#!/usr/bin/env python3
"""
print-worker.py -- PrintKiosk kiosk print worker (runs on the Raspberry Pi).

The one rule this file exists to enforce: NOTHING prints unless a customer
physically taps "Done / Collect" at the kiosk. The backend only hands this
worker jobs whose status is 'print_requested', and only the kiosk can move a
job into that state.

Flow per job:
    claim -> download -> normalise -> verify page count -> lp -> report

The worker also polls the printer's real toner levels over IPP and pushes them
to the backend so admin stops showing made-up numbers.
"""

import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

CONFIG = {
    "api": os.environ.get("PRINTKIOSK_API", "https://printkioskfyp.netlify.app").rstrip("/"),
    "token": os.environ.get("PRINT_WORKER_SECRET", ""),
    "printer": os.environ.get("PRINTER_NAME", "Brother"),
    # Hostname form is used for supplies so it survives the printer getting a
    # new DHCP address. claim/report go through the API, not the printer.
    #
    # There are two Brother printers on this network (HL-L3240CDW and
    # DCP-T430W) and "Brother.local" does not resolve, so this default cannot
    # work and a brand name cannot say which device is meant. install.sh
    # discovers the right one by model and writes the real dnssd:// URI here.
    "printer_uri": os.environ.get("PRINTER_URI", "ipp://Brother.local/ipp/print"),
    # Model this shop is supposed to print on. If the device answers with a
    # different printer-name, the worker reports "wrong printer" instead of
    # filing another machine's toner levels against this one.
    "expected_model": os.environ.get("EXPECTED_MODEL", "HL-L3240CDW"),
    "poll_seconds": int(os.environ.get("PRINT_POLL_SECONDS", "5")),
    "supply_seconds": int(os.environ.get("PRINT_SUPPLY_SECONDS", "300")),
    "watchdog_seconds": int(os.environ.get("PRINT_WATCHDOG_SECONDS", "120")),
    "max_attempts": int(os.environ.get("PRINT_MAX_ATTEMPTS", "3")),
    "queue_timeout": int(os.environ.get("PRINT_QUEUE_TIMEOUT", "180")),
    "download_timeout": int(os.environ.get("PRINT_DOWNLOAD_TIMEOUT", "90")),
}

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
MAX_BYTES = 60 * 1024 * 1024  # refuse anything unreasonable rather than filling /tmp

_counter = {"n": 0}


def log(msg):
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    sys.stdout.write("[%s] %s\n" % (stamp, msg))
    sys.stdout.flush()


def today():
    return datetime.now(timezone.utc).strftime("%Y%m%d")


# --------------------------------------------------------------------------
# API helpers
# --------------------------------------------------------------------------

def api_post(action, payload, timeout=25):
    url = "%s/.netlify/functions/printer?action=%s" % (CONFIG["api"], action)
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Print-Token": CONFIG["token"],
            "User-Agent": "printkiosk-worker",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


# --------------------------------------------------------------------------
# Download + normalise
# --------------------------------------------------------------------------

def download(url, dest):
    """Stream the file to disk, enforcing a size cap. Returns True on success."""
    req = urllib.request.Request(url, headers={"User-Agent": "printkiosk-worker"})
    total = 0
    with urllib.request.urlopen(req, timeout=CONFIG["download_timeout"]) as r, open(dest, "wb") as f:
        while True:
            chunk = r.read(65536)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_BYTES:
                f.close()
                os.unlink(dest)
                raise ValueError("file exceeds %d MB" % (MAX_BYTES // (1024 * 1024)))
            f.write(chunk)
    if total == 0:
        os.unlink(dest)
        raise ValueError("downloaded file was empty")
    return total


def is_image(path):
    return os.path.splitext(path)[1].lower() in IMAGE_EXT


def image_to_pdf(src, dst, grayscale):
    """The kiosk accepts JPEGs/PNGs directly. CUPS will not print those here, so
    flatten to a single-page PDF ourselves. Doing it here also means we are the
    ones applying greyscale, instead of hoping the driver honours ColorModel."""
    from PIL import Image, ImageOps

    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im) or im
        # CMYK JPEGs from phones print with wrong colours unless converted.
        if im.mode in ("CMYK", "RGBA", "P", "LA"):
            im = im.convert("RGBA")
            bg = Image.new("RGB", im.size, (255, 255, 255))
            bg.paste(im, mask=im.split()[-1])
            im = bg
        elif im.mode != "RGB":
            im = im.convert("RGB")

        if grayscale:
            im = im.convert("L").convert("RGB")

        # A4 at 300dpi -- well beyond what the HL-L3240CDW resolves.
        im.save(dst, "PDF", resolution=300.0)


def pdf_page_count(path):
    """Read the real page count so a mismatch against the stored value is
    caught BEFORE anything comes out of the printer."""
    try:
        from pypdf import PdfReader
        return len(PdfReader(path).pages)
    except Exception:
        pass
    try:
        out = subprocess.run(
            ["pdfinfo", path], capture_output=True, text=True, timeout=30
        ).stdout
        m = re.search(r"^Pages:\s+(\d+)", out, re.M)
        return int(m.group(1)) if m else None
    except Exception:
        return None


# --------------------------------------------------------------------------
# Printing
# --------------------------------------------------------------------------

def run_lp(args, timeout):
    return subprocess.run(
        args, capture_output=True, text=True, timeout=timeout
    )


def cups_job_state(printer, job_id):
    """Return the state of one specific CUPS job, or None if it has vanished.

    'lp' only tells us the job was ACCEPTED into the queue. It says nothing
    about whether paper ever came out, so relying on "the queue is empty now"
    is not a success check at all: an aborted, cancelled or offline-rejected
    job also leaves the queue, and a fast single-page job is already gone
    before the first poll.

    'lpstat -W all' reports per-job state:
        completed  -> it really did print
        aborted    -> the printer gave up (jam, no paper, offline)
        canceled   -> removed before printing
    """
    try:
        proc = subprocess.run(
            ["lpstat", "-W", "all", "-o", job_id],
            capture_output=True, text=True, timeout=30,
        )
    except Exception:
        return None

    out = proc.stdout
    if not out.strip():
        return None

    # Line looks like: Brother-12  user  24576  Tue 14 Oct ... printing
    for line in out.splitlines():
        if job_id not in line:
            continue
        low = line.lower()
        for state in ("completed", "aborted", "canceled", "cancelled"):
            if state in low:
                return state
        for state in ("printing", "processing", "pending", "held"):
            if state in low:
                return state
    return None


def printer_alert(printer):
    """Return the printer's stop reason (e.g. 'Paper jam'), or '' if healthy.

    Useful both as a pre-flight check and to explain *why* a job aborted, so
    staff see 'Paper jam' instead of a bare failure.
    """
    try:
        proc = subprocess.run(
            ["lpstat", "-p", printer, "-l"],
            capture_output=True, text=True, timeout=30,
        )
    except Exception:
        return ""
    out = (proc.stdout or "") + (proc.stderr or "")
    low = out.lower()

    for reason in ("out of paper", "paper jam", "no paper", "printer stopped",
                   "offline", "unable to connect", "error"):
        if reason in low:
            # Grab the trailing "(Reason)" text if CUPS supplies one.
            m = re.search(r"\(([^)]*)\)", out)
            return (m.group(1) if m else reason).strip()
    return ""


def wait_for_outcome(printer, job_id, timeout):
    """Block until this specific job finishes. Returns (ok, reason)."""
    deadline = time.time() + timeout
    last = ""

    while time.time() < deadline:
        state = cups_job_state(printer, job_id)

        if state == "completed":
            return True, ""
        if state in ("aborted", "canceled", "cancelled"):
            alert = printer_alert(printer)
            return False, alert or ("job %s by the printer (%s)" % (state, alert or "no reason given"))

        # CUPS can purge job history (PreserveJobHistory defaults to Off), so
        # the job may disappear without us ever seeing 'completed'. Only treat
        # that as success if the printer is healthy, otherwise report the
        # printer's own stop reason.
        if state is None and time.time() > deadline - timeout + 15:
            alert = printer_alert(printer)
            if not alert:
                return True, ""
            return False, alert

        if state is None:
            alert = printer_alert(printer)
            if alert:
                return False, alert
            last = alert

        time.sleep(2)

    return False, "printer did not confirm within %ds" % timeout


def send_to_printer(pdf_path, job):
    """Submit to CUPS. Returns (ok, job_id_or_error)."""
    printer = CONFIG["printer"]
    sides = (job.get("sides") or "single").lower()
    color = (job.get("color_mode") or "bw").lower()

    args = ["lp", "-d", printer, "-t", "PrintKiosk-%s" % job.get("job_id", "job")]

    try:
        copies = int(job.get("copies") or 1)
    except (TypeError, ValueError):
        copies = 1
    if copies > 1:
        args += ["-n", str(max(1, min(99, copies)))]

    args += ["-o", "media=A4"]
    args += ["-o", "ColorModel=Gray" if color != "color" else "ColorModel=RGB"]

    if sides in ("double", "duplex", "two-sided", "double_sided"):
        # long-edge binding is portrait A4 duplex on the HL-L3240CDW.
        args += ["-o", "sides=two-sided-long-edge"]
    else:
        args += ["-o", "sides=one-sided"]

    args.append(pdf_path)

    proc = run_lp(args, timeout=CONFIG["queue_timeout"])
    if proc.returncode != 0:
        return False, (proc.stderr or proc.stdout or "lp exited %d" % proc.returncode).strip()[:400]

    # 'request id is Brother-12 (1 file(s))' -- we need this to track the exact
    # job instead of guessing from an empty queue.
    out = (proc.stdout or "") + (proc.stderr or "")
    m = re.search(r"request id is\s+(\S+?)\s*\(", out)
    if m:
        return True, m.group(1)

    # Some lp builds print the id without the parenthesised suffix.
    m = re.search(r"request id is\s+(\S+)", out)
    if m:
        return True, m.group(1)

    return True, ""


# --------------------------------------------------------------------------
# Supplies over IPP
# --------------------------------------------------------------------------

# ipptool -tv prints lines like:
#   [12] printer-toner-black-remaining = 87 (% of supply) (integer)
# ipptool -tv prints an OPTIONAL parenthesised value tag between the attribute
# name and the '=', e.g.
#
#   [12] printer-toner-black-remaining (integer) = 87 (% of supply) (integer)
#   [13] printer-name (nameWithoutLanguage) = Brother HL-L3240CDW series
#
# The original patterns required the '=' immediately after the name, so on this
# build neither the toner levels nor the model were ever found. The printer was
# reachable the whole time and reported status as "reachable, but no toner
# attributes", which looked exactly like an absent or broken printer.
#
# (?:\s*\([^)]*\))? absorbs that tag, so both forms now match.
_TAG = r"(?:\s*\([^)]*\))?"
TONER_RE = {
    "toner_black": re.compile(r"printer-toner-black-remaining" + _TAG + r"\s*=\s*(\d+)"),
    "toner_cyan": re.compile(r"printer-toner-cyan-remaining" + _TAG + r"\s*=\s*(\d+)"),
    "toner_magenta": re.compile(r"printer-toner-magenta-remaining" + _TAG + r"\s*=\s*(\d+)"),
    "toner_yellow": re.compile(r"printer-toner-yellow-remaining" + _TAG + r"\s*=\s*(\d+)"),
}

# The printer's own model string, read from the same Get-Printer-Attributes
# response the toner levels come from.
#
# There are two Brother printers on this network (HL-L3240CDW and DCP-T430W),
# so a brand name identifies neither. The queue is named "Brother" and the
# configured URI was ipp://Brother.local/... which does not resolve at all, so
# neither the config nor the queue name can be trusted to say which device is
# actually being polled. printer-name is the device telling us what it is.
PRINTER_NAME_RE = re.compile(r"printer-name" + _TAG + r"\s*=\s*['\"]?([^'\"]+?)['\"]?\s*$", re.MULTILINE)


def reported_model(text):
    m = PRINTER_NAME_RE.search(text or "")
    return m.group(1).strip() if m else None


# CUPS ships a known-good Get-Printer-Attributes request on the Pi. Preferred
# over our generated copy, which ipptool has twice rejected as invalid.
CUPS_SYSTEM_TEST = "/usr/share/cups/ipptool/get-printer-attributes.test"


def _probe(test_path):
    """Run ipptool with one test file. Returns (text, returncode, error)."""
    try:
        proc = subprocess.run(
            ["ipptool", "-tv", CONFIG["printer_uri"], test_path],
            capture_output=True, text=True, timeout=45,
        )
    except Exception as e:
        return None, None, "ipptool could not run: %s" % e
    # ipptool writes the attribute dump to stderr, not stdout. Parsing only
    # stdout once meant this saw a single echoed argument
    # ('"/tmp/pk-get-printer-attributes.test":') and concluded the printer was
    # unreadable while it was answering perfectly. Both streams are searched.
    text = (proc.stdout or "") + "\n" + (proc.stderr or "")
    return text, proc.returncode, None


def read_supplies():
    """Ask the printer what it actually has. Returns (levels, online, why, model).

    `why` exists so a failure is diagnosable from the journal. The first
    version swallowed every error, so a printer that could never be reached
    looked identical to a healthy one -- the levels simply never updated and
    nothing said why.
    """
    if not shutil_which("ipptool"):
        return None, True, "ipptool not installed (apt install cups-ipp-utils)", None

    # Two candidate test files, tried in order.
    #
    # The generated file has been rejected twice ("Unexpected token ATTRIBUTE
    # seen on line 4") with syntax that matches the CUPS original, and it cannot
    # be verified from a machine without ipptool. CUPS ships a known-good
    # get-printer-attributes.test on the Pi itself, so it is preferred outright
    # and the generated file is only a fallback for a system without CUPS.
    # That removes our ability to break this entirely.
    candidates = []
    if CUPS_SYSTEM_TEST and os.path.exists(CUPS_SYSTEM_TEST):
        candidates.append(CUPS_SYSTEM_TEST)
    candidates.append(get_printer_attrs_test())
    candidates = list(dict.fromkeys(candidates))

    text = None
    first_error = ""
    transport_error = ""
    for test_path in candidates:
        text, code, err = _probe(test_path)
        if err:
            first_error = first_error or err
            text = None
            continue

        if code != 0:
            detail = (text or "").strip().splitlines()
            line = detail[0] if detail else "no output"
            first_error = first_error or line
            # A transport failure is about the printer, not about which test
            # file was used, so trying the other candidate cannot help.
            low = (text or "").lower()
            if "cannot connect" in low or "connection refused" in low \
                    or "no route to host" in low or "could not resolve" in low:
                transport_error = "cannot reach %s - %s" % (CONFIG["printer_uri"], line)
                break
            continue

        # ipptool exits 0 even when it cannot parse the test file, so its exit
        # status alone does not mean the printer answered. Attribute lines are
        # the only real evidence that a request completed.
        if re.search(r"^\s*\[\d+\]", text or "", re.MULTILINE):
            break

        first_error = first_error or (text or "").strip().replace("\n", " | ")[:200]
        text = None

    if transport_error:
        return None, False, transport_error, None

    if text is None:
        return None, False, (
            "ipptool returned no attributes - no request completed. "
            + (first_error or "(no output)")
        ), None

    levels = {}
    for key, rx in TONER_RE.items():
        m = rx.search(text)
        if m:
            levels[key] = int(m.group(1))

    if not levels:
        # Reachable, but nothing usable came back. Include a sample of the real
        # response so the parsing can be fixed from evidence.
        #
        # This was previously just "reachable, but no toner attributes", which
        # is a dead end: it says the request succeeded without saying what came
        # back, so the only way to learn the actual ipptool output format was to
        # guess. printer-name is mandatory in every IPP Get-Printer-Attributes
        # response, so failing to find either that or the toner attributes means
        # our assumptions about the text format are wrong, not that the printer
        # is odd.
        sample = (text or "").strip().replace("\n", " | ")[:600]
        return None, False, (
            "reachable, but no toner attributes in the response. Got: " + (sample or "(empty)")
        ), reported_model(text)
    return levels, True, "", reported_model(text)


def shutil_which(name):
    for d in os.environ.get("PATH", "").split(os.pathsep):
        p = os.path.join(d, name)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def get_printer_attrs_test():
    """Write a valid ipptool request for Get-Printer-Attributes and return its path.

    Two defects made this file unusable, and both produced the same misleading
    symptom - "reachable, but no toner attributes":

    1. The values used the RESPONSE form "value-charset" / "value-uri". In a
       request they must be the bare syntax name ("charset", "uri"). ipptool
       refused to parse the file and said:

           Unexpected token ATTRIBUTE seen on line 4

       ...then still exited 0, so we concluded the printer had been reached and
       answered, when the request had never been sent at all.

    2. Without "requested-attributes all", a printer may return only its
       mandatory attributes, which excludes the toner levels and the model.

    The file is rewritten on every worker start rather than reused if present,
    because the broken version was already cached in the temp directory and
    simply re-validating its existence would keep using it.
    """
    p = os.path.join(tempfile.gettempdir(), "pk-get-printer-attributes.test")
    with open(p, "w") as f:
        f.write(
            '{\n'
            '    OPERATION Get-Printer-Attributes\n'
            '    GROUP operation-attributes-tag\n'
            '    ATTRIBUTE charset\n'
            '        charset "utf-8"\n'
            '    ATTRIBUTE naturalLanguage\n'
            '        naturalLanguage "en"\n'
            '    ATTRIBUTE uri\n'
            '        uri "$uri"\n'
            '    ATTRIBUTE requested-attributes\n'
            '        requested-attributes all\n'
            '    STATUS successful-ok\n'
            '}\n'
        )
    return p


# --------------------------------------------------------------------------
# Main job loop
# --------------------------------------------------------------------------

def report(job_id, public_id, outcome, error=None, attempts=1, page_verified=False):
    for attempt in range(3):
        try:
            api_post("report-print", {
                "job_id": job_id,
                "public_id": public_id,
                "outcome": outcome,
                "error": error,
                "attempts": attempts,
                "page_verified": page_verified,
            })
            return
        except Exception as e:
            log("report-print failed (%s) retry %d" % (e, attempt + 1))
            time.sleep(3)
    log("GAVE UP reporting %s -- check manually" % public_id)


def process(job):
    _counter["n"] += 1
    workdir = os.path.join(tempfile.gettempdir(), "pk-%s-%d" % (today(), _counter["n"]))
    os.makedirs(workdir, exist_ok=True)

    public_id = job.get("job_id", "?")
    src = None
    attempts = int(job.get("print_attempts") or 0) + 1

    try:
        raw = job.get("file_path")
        if not raw:
            raise ValueError("job has no file_path")

        ext = os.path.splitext(raw.split("?")[0])[1].lower() or ".pdf"
        src = os.path.join(workdir, "source%s" % ext)
        log("%s: downloading %s" % (public_id, os.path.basename(raw.split("?")[0])))
        size = download(raw, src)
        log("%s: downloaded %d bytes" % (public_id, size))

        if is_image(src):
            pdf = os.path.join(workdir, "print.pdf")
            grayscale = (job.get("color_mode") or "bw").lower() != "color"
            image_to_pdf(src, pdf, grayscale)
            log("%s: image converted to PDF (%s)" % (public_id, "greyscale" if grayscale else "colour"))
        else:
            pdf = src

        actual = pdf_page_count(pdf)
        expected = job.get("pages")
        page_verified = actual is not None and expected is not None and int(actual) == int(expected)
        if actual is not None:
            log("%s: page count check -> %s (expected %s)" % (
                public_id, "OK" if page_verified else "MISMATCH", expected))
            if not page_verified and expected:
                # Never silently overprint. The customer paid for N pages and the
                # file does not contain N pages -- stop and let staff decide.
                raise ValueError("page count mismatch: file has %s, job says %s" % (actual, expected))

        # Refuse to submit at all if the printer is already reporting a stop
        # reason. Better to fail now with a clear message than to hand CUPS a
        # job it will silently drop.
        alert = printer_alert(CONFIG["printer"])
        if alert:
            raise RuntimeError("printer unavailable: %s" % alert)

        ok, result = send_to_printer(pdf, job)
        if not ok:
            raise RuntimeError("lp rejected job: %s" % result)

        job_id = result
        log("%s: submitted to CUPS as %s" % (public_id, job_id or "(id unknown)"))

        # Wait for THIS job to reach a terminal state. Only 'completed' counts
        # as success -- an aborted or cancelled job means no paper came out.
        printed, reason = wait_for_outcome(
            CONFIG["printer"], job_id, CONFIG["queue_timeout"]
        )
        if not printed:
            raise RuntimeError(reason or "printer did not confirm the job")

        log("%s: PRINTED (cups job %s)" % (public_id, job_id or "n/a"))
        report(job["id"], public_id, "completed", None, attempts, page_verified)

    except urllib.error.URLError as e:
        log("%s: network error: %s" % (public_id, e))
        report(job["id"], public_id, "failed", "download failed: %s" % e, attempts)
    except Exception as e:
        log("%s: FAILED: %s" % (public_id, e))
        if attempts >= CONFIG["max_attempts"]:
            log("%s: final attempt reached -- job marked failed for staff" % public_id)
        report(job["id"], public_id, "failed", str(e)[:400], attempts)
    finally:
        try:
            for f in os.listdir(workdir):
                os.unlink(os.path.join(workdir, f))
            os.rmdir(workdir)
        except Exception:
            pass


def main():
    if not CONFIG["token"]:
        log("FATAL: PRINT_WORKER_SECRET is not set. Refusing to start.")
        sys.exit(1)

    once = "--once" in sys.argv
    log("print worker starting -> printer=%s api=%s poll=%ds" % (
        CONFIG["printer"], CONFIG["api"], CONFIG["poll_seconds"]))

    last_supply = 0.0
    last_watchdog = 0.0

    while True:
        now = time.time()

        if now - last_supply >= CONFIG["supply_seconds"]:
            try:
                levels, online, why, model = read_supplies()

                # Guard against reporting the wrong device. There are two
                # Brother printers on this network, so if the printer we
                # reached is not the expected model, say so loudly instead of
                # filing its toner levels and paper against the shop's HL.
                expected = CONFIG.get("expected_model") or ""
                if model and expected and expected.lower() not in model.lower():
                    why = ('polled "%s" but EXPECTED_MODEL is %s - wrong printer'
                           % (model, expected))
                    levels, online = None, False

                payload = {
                    "printer_name": CONFIG["printer"],
                    "printer_uri": CONFIG["printer_uri"],
                    "printer_model": model,
                }

                # Also report CUPS' own view of the printer. printer_alert()
                # used to be consulted only at submit time and after an abort,
                # so a jam or an empty tray never reached the kiosk: the screen
                # said "Online" while the printer was unusable and the customer
                # only found out at the machine.
                try:
                    alert = printer_alert(CONFIG["printer"])
                except Exception as e:
                    alert = ""
                    log("printer_alert failed: %s" % e)

                if levels:
                    api_post("report-supplies", dict(payload, **{
                        "levels": levels, "online": online, "alert": alert,
                    }))
                    log("supplies: %s (online=%s, model=%s)%s" % (
                        levels, online, model,
                        (" alert=%s" % alert) if alert else ""))
                else:
                    # Report the failure too. Otherwise the last-known levels sit
                    # in admin forever looking like live readings, which is how a
                    # 49-hour-old hand-entered value ended up being presented as
                    # if the printer had reported it.
                    api_post("report-supplies", dict(payload, **{
                        "levels": {}, "online": False, "error": why, "alert": alert,
                    }))
                    log("supplies unavailable (%s) via %s%s" % (
                        why, CONFIG["printer_uri"], (" alert=%s" % alert) if alert else ""))
            except Exception as e:
                log("supply report failed: %s" % e)
            last_supply = now

        if now - last_watchdog >= CONFIG["watchdog_seconds"]:
            try:
                res = api_post("watchdog", {"stuck_minutes": 30})
                if res.get("recovered"):
                    log("watchdog recovered %s stalled job(s)" % res["recovered"])
            except Exception as e:
                log("watchdog failed: %s" % e)
            last_watchdog = now

        did_work = False
        claim_ok = True
        try:
            res = api_post("claim-job", {})
            job = res.get("job")
            if job:
                did_work = True
                process(job)
        except Exception as e:
            log("claim-job failed: %s" % e)
            claim_ok = False

        if once and not claim_ok:
            # Without this the dry run would go on to announce "no job waiting",
            # which reads like a successful safety check even though we never
            # actually reached the backend. The first version of this script
            # had exactly that bug and looked like it passed.
            log("DRY RUN FAILED: could not talk to the backend. Fix this before"
                " starting the service - it would never print anything.")
            sys.exit(1)

        if once and did_work:
            break
        if once and not did_work:
            log("no job waiting (nothing prints until a customer taps collect)")
            break
        if not did_work:
            time.sleep(CONFIG["poll_seconds"])


if __name__ == "__main__":
    # systemd sends SIGINT on stop (KillSignal=SIGINT in the unit). Without this
    # every restart and every reboot buried a 30-line KeyboardInterrupt
    # traceback in the journal, which trains you to ignore real errors.
    def _bye(signum, frame):
        log("stopping (signal %d)" % signum)
        sys.exit(0)

    signal.signal(signal.SIGINT, _bye)
    signal.signal(signal.SIGTERM, _bye)
    main()