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
    "printer_uri": os.environ.get("PRINTER_URI", "ipp://Brother.local/ipp/print"),
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


def wait_for_queue_empty(printer, timeout):
    """lp returns as soon as the job is ACCEPTED, not when paper comes out.
    Poll CUPS until our job leaves the queue so 'completed' means printed."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            out = subprocess.run(
                ["lpstat", "-p", printer, "-o"],
                capture_output=True, text=True, timeout=30,
            ).stdout
            if not out.strip():
                return True, ""
        except Exception:
            pass
        time.sleep(2)
    return False, "job still in queue after %ds" % timeout


def send_to_printer(pdf_path, job):
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
    return True, ""


# --------------------------------------------------------------------------
# Supplies over IPP
# --------------------------------------------------------------------------

# ipptool -tv prints lines like:
#   [12] printer-toner-black-remaining = 87 (% of supply) (integer)
TONER_RE = {
    "toner_black": re.compile(r"printer-toner-black-remaining\s*=\s*(\d+)"),
    "toner_cyan": re.compile(r"printer-toner-cyan-remaining\s*=\s*(\d+)"),
    "toner_magenta": re.compile(r"printer-toner-magenta-remaining\s*=\s*(\d+)"),
    "toner_yellow": re.compile(r"printer-toner-yellow-remaining\s*=\s*(\d+)"),
}


def read_supplies():
    """Ask the printer what it actually has. Returns (levels, online)."""
    if not shutil_which("ipptool"):
        return None, True

    try:
        proc = subprocess.run(
            ["ipptool", "-tv", CONFIG["printer_uri"], get_printer_attrs_test()],
            capture_output=True, text=True, timeout=45,
        )
    except Exception:
        return None, True

    if proc.returncode != 0:
        return None, False

    text = proc.stdout
    levels = {}
    for key, rx in TONER_RE.items():
        m = rx.search(text)
        if m:
            levels[key] = int(m.group(1))

    if not levels:
        # Reachable but the driver gave us nothing usable -- treat as unknown
        # rather than reporting a confident-looking 0% that would trigger a
        # false "out of toner" page for staff.
        return None, False
    return levels, True


def shutil_which(name):
    for d in os.environ.get("PATH", "").split(os.pathsep):
        p = os.path.join(d, name)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def get_printer_attrs_test():
    p = os.path.join(tempfile.gettempdir(), "pk-get-printer-attributes.test")
    if not os.path.exists(p):
        with open(p, "w") as f:
            f.write(
                '{\n'
                '    OPERATION Get-Printer-Attributes\n'
                '    GROUP operation-attributes-tag\n'
                '    ATTRIBUTE charset\n'
                '        value-charset "utf-8"\n'
                '    ATTRIBUTE naturalLanguage\n'
                '        value-naturalLanguage "en"\n'
                '    ATTRIBUTE uri\n'
                '        value-uri "$uri"\n'
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

        ok, err = send_to_printer(pdf, job)
        if not ok:
            raise RuntimeError("lp rejected job: %s" % err)

        printed, qerr = wait_for_queue_empty(CONFIG["printer"], CONFIG["queue_timeout"])
        if not printed:
            raise RuntimeError(qerr)

        log("%s: PRINTED" % public_id)
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
                levels, online = read_supplies()
                if levels:
                    api_post("report-supplies", {
                        "levels": levels, "online": online, "printer_name": CONFIG["printer"],
                    })
                    log("supplies: %s (online=%s)" % (levels, online))
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
        try:
            res = api_post("claim-job", {})
            job = res.get("job")
            if job:
                did_work = True
                process(job)
        except Exception as e:
            log("claim-job failed: %s" % e)

        if once and did_work:
            break
        if once and not did_work:
            log("no job waiting (nothing prints until a customer taps collect)")
            break
        if not did_work:
            time.sleep(CONFIG["poll_seconds"])


if __name__ == "__main__":
    main()