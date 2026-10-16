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
    # The IPP address supplies are read from. install.sh discovers this and
    # writes it into the env file, but the key was READ in four places and
    # DEFINED in none of them, so every single supply poll raised
    # KeyError: 'printer_uri' and the printer stopped reporting altogether - no
    # toner levels anywhere, last_checked frozen, and the dashboard left showing
    # whatever it happened to have seen last. install.sh was setting an
    # environment variable that nothing read.
    #
    # Resolved from the env file first, then from whatever CUPS has configured
    # for the queue (see _queue_device_uri). Printing itself goes through `lp`
    # and the queue name, so a missing URI must never stop the worker running.
    "printer_uri": os.environ.get("PRINTER_URI", "").strip(),
    # Hostname form is used for supplies so it survives the printer getting a
    # new DHCP address. claim/report go through the API, not the printer.
    #
    # There are two Brother printers on this network (HL-L3240CDW and
    # DCP-T430W) and "Brother.local" does not resolve, so this default cannot
    # work and a brand name cannot say which device is meant. install.sh
    # discovers the right one by model and writes the real dnssd:// URI here.
    # IPP printers can require authentication. Without credentials the printer
    # answers with an authorization failure, and what ipptool shows for that is
    # a bare mandatory printer-name and nothing else - no make-and-model, no
    # printer-info and no toner levels. That is what made this look like a
    # serial-numbering and wrong-printer problem instead of a missing password.
    "printer_user": os.environ.get("PRINTER_USER", ""),
    "printer_password": os.environ.get("PRINTER_PASSWORD", ""),
    # Model this shop is supposed to print on. If the device answers with a
    # different printer-name, the worker reports "wrong printer" instead of
    # filing another machine's toner levels against this one.
    "expected_model": os.environ.get("EXPECTED_MODEL", "HL-L3240CDW"),
    "poll_seconds": int(os.environ.get("PRINT_POLL_SECONDS", "5")),
    # How often the printer is asked how it is. This is the ceiling on how stale
    # the dashboard can be: the admin page reloads every 30s but only sees what
    # the worker last reported, so at 300s a printer that had just gone offline
    # kept showing ONLINE for five minutes. One IPP round trip a minute is
    # nothing on a LAN, and it is the same read_supplies() call either way.
    "supply_seconds": int(os.environ.get("PRINT_SUPPLY_SECONDS", "60")),
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


def _clamp_adjust(value):
    """Brightness/contrast arrive as strings from the DB and the sliders run
    -100..100. Anything outside that, or unparseable, is treated as no
    adjustment rather than being allowed to produce a black or blank page."""
    try:
        v = int(round(float(value)))
    except (TypeError, ValueError):
        return 0
    if v == 0:
        return 0
    return max(-100, min(100, v))


def adjust_image(im, grayscale, brightness=0, contrast=0):
    """Apply the print adjustments to a decoded image, in the same order as the
    preview's CSS filter (grayscale -> brightness -> contrast) so the print
    matches the screen the customer approved.

    Kept separate from the PDF writing so the pixel work can be checked
    directly - Pillow cannot read a PDF back in, so asserting on the output
    file would test nothing.
    """
    from PIL import ImageEnhance

    if grayscale:
        im = im.convert("L").convert("RGB")

    brightness = _clamp_adjust(brightness)
    contrast = _clamp_adjust(contrast)
    if brightness:
        im = ImageEnhance.Brightness(im).enhance(1.0 + brightness / 100.0)
    if contrast:
        # CSS contrast() is linear about MID GREY with slope f. Pillow's
        # ImageEnhance.Contrast instead blends toward the image's own mean, which
        # moves the pivot and does not match the preview the customer approved.
        # Do the CSS formula explicitly, via a per-channel lookup table.
        f = 1.0 + contrast / 100.0

        def _curve(v, f=f):
            x = (v - 127.5) * f + 127.5
            if x < 0:
                return 0
            if x > 255:
                return 255
            return int(x + 0.5)

        lut = [_curve(i) for i in range(256)]
        im = im.point(lut * len(im.getbands()))

    return im


def image_to_pdf(src, dst, grayscale, brightness=0, contrast=0):
    """The kiosk accepts JPEGs/PNGs directly. CUPS will not print those here, so
    flatten to a single-page PDF ourselves. Doing it here also means we are the
    ones applying greyscale, instead of hoping the driver honours ColorModel.

    brightness/contrast are the values the customer dialled in. They used to be
    stored on the job and then dropped on the floor, so the preview showed an
    adjusted image and the printer produced the original - the customer got
    something other than what they chose.
    """
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

        im = adjust_image(im, grayscale, brightness, contrast)

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
#
# Neither the tag nor the value may span lines. In the unquoted named-group form
# the value pattern was [\x27"\x27]+, whose negated class happily matched newlines,
# so an "identity" string swallowed the entire rest of the response. Excluding
# CR and LF keeps every capture to the single line it came from.
_TAG = r"(?:\s*\([^)\r\n]*\))?"
_VALUE = r"[^\x27\"\r\n]+?"
TONER_RE = {
    "toner_black": re.compile(r"printer-toner-black-remaining" + _TAG + r"\s*=\s*(\d+)"),
    "toner_cyan": re.compile(r"printer-toner-cyan-remaining" + _TAG + r"\s*=\s*(\d+)"),
    "toner_magenta": re.compile(r"printer-toner-magenta-remaining" + _TAG + r"\s*=\s*(\d+)"),
    "toner_yellow": re.compile(r"printer-toner-yellow-remaining" + _TAG + r"\s*=\s*(\d+)"),
}

# IPP describes consumables two different ways, and which one a printer uses is
# a property of the model, not a choice.
#
# The IPP 1.x form is printer-toner-<colour>-remaining, matched above. The IPP
# 2.x/PWG form is the marker-* group: one ordered marker-levels set, paired
# positionally with marker-colors (or marker-names) in the same response.
#
# This HL-L3240CDW only ever sends the second. Looking only for the first is why
# the dashboard reported no toner levels at all, on a printer that was reporting
# them perfectly:
#
#     marker-levels (1setOf integer) = 90,100,100,100
#     marker-colors (1setOf nameWithoutLanguage) = #000000,#00FFFF,#FF00FF,#FFFF00
#     marker-names (1setOf nameWithoutLanguage) = BK,C,M,Y
#
# Positional pairing is the point: the values carry no colour of their own, so
# they are only meaningful next to the identity list in the same reply.
_MARKER_LEVELS_RE = re.compile(r"marker-levels" + _TAG + r"\s*=\s*([-\d,\s]+)")
_MARKER_COLORS_RE = re.compile(r"marker-colors" + _TAG + r"\s*=\s*([^(\n]+)")
_MARKER_NAMES_RE = re.compile(r"marker-names" + _TAG + r"\s*=\s*([^(\n]+)")

_MARKER_COLOR_KEYS = {
    "#000000": "toner_black",
    "#00ffff": "toner_cyan",
    "#ff00ff": "toner_magenta",
    "#ffff00": "toner_yellow",
}

_MARKER_NAME_KEYS = {
    "bk": "toner_black", "k": "toner_black", "black": "toner_black",
    "c": "toner_cyan", "cy": "toner_cyan", "cyan": "toner_cyan",
    "m": "toner_magenta", "ma": "toner_magenta", "mag": "toner_magenta",
    "magenta": "toner_magenta",
    "y": "toner_yellow", "ye": "toner_yellow", "yellow": "toner_yellow",
}

# Only used when the reply names no colours at all. Four toner markers in this
# order is the PWG default for a colour laser, and it is a last resort on
# purpose: guessing which number is which colour is exactly the kind of
# assumption that puts cyan's level on the black bar.
_MARKER_FALLBACK_ORDER = ["toner_black", "toner_cyan", "toner_magenta", "toner_yellow"]


def _split_set(value):
    return [v.strip() for v in (value or "").split(",") if v.strip() != ""]


def _marker_levels(text):
    """Read consumable levels from the IPP marker-* group. {} when absent."""
    m = _MARKER_LEVELS_RE.search(text or "")
    if not m:
        return {}

    values = []
    for raw in _split_set(m.group(1)):
        try:
            values.append(int(raw))
        except ValueError:
            return {}          # not a level set we understand; do not guess
    if not values:
        return {}

    keys = None
    colors = _MARKER_COLORS_RE.search(text or "")
    if colors:
        keys = [_MARKER_COLOR_KEYS.get(c.lower()) for c in _split_set(colors.group(1))]

    if not keys or len(keys) != len(values) or any(k is None for k in keys):
        names = _MARKER_NAMES_RE.search(text or "")
        if names:
            keys = [_MARKER_NAME_KEYS.get(n.lower()) for n in _split_set(names.group(1))]

    if not keys or len(keys) != len(values) or any(k is None for k in keys):
        if len(values) == len(_MARKER_FALLBACK_ORDER):
            keys = list(_MARKER_FALLBACK_ORDER)
        else:
            return {}

    out = {}
    for key, value in zip(keys, values):
        # IPP uses negatives for "unknown" and "not available". A negative is
        # not a level, and clamping it to zero would report a full printer as
        # empty.
        out[key] = value if value >= 0 else None
    return out

# The printer's own model string, read from the same Get-Printer-Attributes
# response the toner levels come from.
#
# There are two Brother printers on this network (HL-L3240CDW and DCP-T430W),
# so a brand name identifies neither. The queue is named "Brother" and the
# configured URI was ipp://Brother.local/... which does not resolve at all, so
# neither the config nor the queue name can be trusted to say which device is
# actually being polled. printer-name is the device telling us what it is.
PRINTER_NAME_RE = re.compile(
    r"printer-name" + _TAG + r"\s*=\s*[\x27\"]?(" + _VALUE + r")[\x27\"]?\s*$", re.MULTILINE)
# Some vendors put the model somewhere other than printer-name. Brother in
# particular reports printer-name as the unit's SERIAL number
# ("BRW145A41F176AD"), which never contains the model string, so comparing
# EXPECTED_MODEL against printer-name alone rejected the correct printer as
# "wrong printer" and suppressed its readings.
#
# printer-make-and-model and printer-info both carry "HL-L3240CDW" on this
# device. The expected model is accepted if it appears in ANY of them.
MAKE_MODEL_RE = re.compile(
    r"printer-make-and-model" + _TAG + r"\s*=\s*[\x27\"]?(" + _VALUE + r")[\x27\"]?\s*$", re.MULTILINE)
INFO_RE = re.compile(
    r"printer-info" + _TAG + r"\s*=\s*[\x27\"]?(" + _VALUE + r")[\x27\"]?\s*$", re.MULTILINE)


def _first(re, text):
    m = re.search(text or "")
    return m.group(1).strip() if m else None


def reported_model(text):
    """Everything the device says it is, as a list of identity strings."""
    found = []
    for rx in (PRINTER_NAME_RE, MAKE_MODEL_RE, INFO_RE):
        v = _first(rx, text)
        if v and v not in found:
            found.append(v)
    return found or None


# CUPS ships a known-good Get-Printer-Attributes request on the Pi. Preferred
# over our generated copy, which ipptool has twice rejected as invalid.
CUPS_SYSTEM_TEST = "/usr/share/cups/ipptool/get-printer-attributes.test"


_IPPTOOL_K_SUPPORT = None


def _ipptool_supports_k():
    """Does THIS ipptool accept -k? Answered once and cached.

    -k is not universal. The build on this Pi rejects it outright with
    "Unknown option \"-k\"" and then prints its usage instead of contacting the
    printer at all. Because the worker looked at the reply and concluded "no
    toner attributes", that usage message was misread as an empty printer: the
    dashboard showed no ink levels and no explanation, for a day, while the
    printer was answering perfectly the whole time.

    Guessing here costs one cheap --help call and saves an entire silent outage.
    """
    global _IPPTOOL_K_SUPPORT
    if _IPPTOOL_K_SUPPORT is not None:
        return _IPPTOOL_K_SUPPORT

    _IPPTOOL_K_SUPPORT = False
    try:
        proc = subprocess.run(["ipptool", "--help"], capture_output=True,
                              text=True, timeout=15)
        _IPPTOOL_K_SUPPORT = "-k" in ((proc.stdout or "") + (proc.stderr or ""))
    except Exception:
        _IPPTOOL_K_SUPPORT = False
    return _IPPTOOL_K_SUPPORT


def _auth_args():
    """Build the ipptool arguments for IPP authentication, if configured.

    ipptool takes credentials as "-u NAME -k KEYFILE", where the key file holds
    the username on line 1 and the password on line 2. The password is not a
    command-line argument, so it stays out of the process list and out of the
    journal.

    Whether -k exists at all is checked first. Passing an option this build
    does not recognise makes ipptool print its usage and exit without ever
    contacting the printer, which is indistinguishable from an unreadable
    printer unless you read the error text closely. Most printers on a trusted
    LAN answer without credentials, so an unauthenticated probe is still worth
    trying rather than giving up on supplies entirely.
    """
    user = CONFIG.get("printer_user") or ""
    password = CONFIG.get("printer_password") or ""
    if not user and not password:
        return []

    if not _ipptool_supports_k():
        log("WARNING: PRINTER_USER/PRINTER_PASSWORD are set but this ipptool "
            "does not support -k, so credentials cannot be sent. Probing "
            "unauthenticated - fine on a trusted LAN, but supplies will fail if "
            "the printer actually demands a password.")
        return []

    key_path = os.path.join(tempfile.gettempdir(), "pk-ipp-auth.key")
    try:
        # Create with 0600 from the outset rather than chmod-ing afterwards,
        # so the password is never briefly world-readable.
        fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write((user or "") + "\n" + (password or "") + "\n")
    except Exception as e:
        log("could not write the IPP key file (%s); probing unauthenticated" % e)
        return []

    args = ["-k", key_path]
    if user:
        args += ["-u", user]
    return args


def _probe(test_path):
    """Run ipptool with one test file. Returns (text, returncode, error)."""
    try:
        proc = subprocess.run(
            ["ipptool", "-tv"] + _auth_args()
            + [CONFIG["printer_uri"], test_path],
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


def _looks_unauthorized(text):
    """Did the printer REFUSE this request for authorization reasons?

    About the request, not the device. A printer can allow an anonymous
    Get-Printer-Attributes for its mandatory attributes while refusing the
    same operation with `requested-attributes all`, so being denied once does
    not mean supplies are unreachable - it means try a smaller request.

    Matched on IPP status codes, not on the bare word "authentication". That
    word turns up in ordinary attribute dumps - a privacy policy, a help text,
    any attribute whose name or value mentions it - and treating a single
    occurrence as a refusal made a printer that answers anonymously look like
    one demanding a password. An IPP status is unambiguous; prose is not.
    """
    low = (text or "").lower()
    return ("not-authorized" in low or "not authorized" in low
            or "forbidden" in low)


def read_supplies():
    """Ask the printer what it actually has. Returns (levels, online, why, model).

    `why` exists so a failure is diagnosable from the journal. The first
    version swallowed every error, so a printer that could never be reached
    looked identical to a healthy one -- the levels simply never updated and
    nothing said why.
    """
    if not shutil_which("ipptool"):
        return None, True, "ipptool not installed (apt install cups-ipp-utils)", None

    # Test files, tried in order.
    #
    # First choice is the enhanced request built from CUPS's own file, which
    # asks for every attribute - without that the printer returns only its
    # mandatory set, which on this device was a single printer-name line with no
    # model and no toner levels. CUPS's unmodified file is the fallback, in
    # case the enhanced copy could not be produced.
    #
    # Nothing here is hand-authored IPP any more: the base syntax comes from a
    # file CUPS ships and is known to parse on this machine.
    candidates = []
    enhanced = get_printer_attrs_test()
    if enhanced:
        candidates.append(enhanced)
    if CUPS_SYSTEM_TEST and os.path.exists(CUPS_SYSTEM_TEST):
        candidates.append(CUPS_SYSTEM_TEST)
    candidates = list(dict.fromkeys(candidates))

    text = None
    first_error = ""
    transport_error = ""
    auth_denied = False
    for test_path in candidates:
        text, code, err = _probe(test_path)
        which = test_path

        # Say what each request actually produced. Four attempts can each fail
        # differently, and without this the journal only ever showed the final
        # conclusion - which is how a refusal on the enhanced request came to
        # be reported as "the printer requires a password" when the plain
        # request in the same loop had been refused for a different reason, or
        # not at all.
        def _outcome(t, c):
            if _looks_unauthorized(t):
                return "refused (authorization)"
            if re.search(r'Unknown option|Usage:\s*ipptool', t or ""):
                return "rejected our arguments"
            low = (t or "").lower()
            if "cannot connect" in low or "connection refused" in low \
                    or "no route to host" in low or "could not resolve" in low:
                return "unreachable"
            # re.search rather than a count, matching the "did anything answer"
            # test below: presence is what matters here, and one code path for
            # one question is one fewer thing to get subtly different.
            has_attrs = bool(re.search(r"^\s+\S[^\n]*?=\s*\S", t or "", re.MULTILINE))
            return "has attribute lines" if has_attrs else "NO attribute lines"

        if err:
            log("  supply probe %s: could not run (%s)" % (which, err))
            first_error = first_error or err
            text = None
            continue
        log("  supply probe %s: exit=%s %s" % (which, code, _outcome(text, code)))

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

        # An authorization refusal is about THIS request, not about the
        # printer, so it must not end the search. A refusal still prints
        # attribute lines (IPP echoes the request's own attributes back), which
        # used to satisfy the "did anything answer" test below and break the
        # loop on the very first candidate.
        #
        # That mattered because the enhanced request, tried first, is refused
        # by this printer while the plain one is allowed anonymously. Ending on
        # the refusal meant the working request was never attempted, and the
        # journal claimed the printer "requires authentication" for a printer
        # that had just answered an identical unauthenticated command by hand.
        if _looks_unauthorized(text):
            auth_denied = True
            first_error = first_error or "authorization refused for this request"
            text = None
            continue

        # ipptool exits 0 even when it cannot parse the test file, so its exit
        # status alone does not mean the printer answered. Attribute lines are
        # the only real evidence that a request completed.
        #
        # The shape differs by ipptool build. Some emit an index prefix
        # ("    [12] printer-toner-black-remaining (integer) = 87"), others emit
        # a named group with no index at all:
        #
        #     Get-Printer-Attributes:
        #         attributes-charset (charset) = utf-8
        #         printer-toner-black-remaining (integer) = 87
        #
        # Matching only the indexed form made a perfectly good response look
        # like a request that never completed. Match any indented assignment,
        # which both shapes satisfy and neither the header nor the argument echo
        # ("\"/usr/share/cups/...test\":") does.
        if re.search(r"^\s+\S[^\n]*?=\s*\S", text or "", re.MULTILINE):
            break

        first_error = first_error or (text or "").strip().replace("\n", " | ")[:200]
        text = None

    if transport_error:
        return None, False, transport_error, None

    # ipptool refused our own arguments, so it never contacted the printer.
    # This must never be reported as "no toner attributes": the printer was
    # never asked. An unsupported option such as -k prints the usage text and
    # exits, and reading that as an empty supply list is what made a working
    # printer look inkless for a day.
    usage = re.search(r'Unknown option|Usage:\s*ipptool', text or "")
    if usage:
        first = (text or "").strip().splitlines()[0] if (text or "").strip() else "(no output)"
        return None, False, (
            "ipptool rejected our arguments and never reached the printer: %s"
            % first
        ), None

    # An authorization failure is reported by ipptool as a status line while
    # still exiting 0 and still printing a mandatory printer-name, so without
    # this check it is indistinguishable from a successful read that happened to
    # omit everything else - which is precisely how a missing password came to
    # be diagnosed as a serial number and a wrong printer.
    # Only claim the printer demands a password once EVERY request has been
    # refused. Saying it after a single refusal is what produced "printer
    # requires authentication" for a printer that answers an unauthenticated
    # request perfectly well by hand.
    if _looks_unauthorized(text) or (auth_denied and text is None):
        return None, False, (
            "every request was refused for authentication. Set PRINTER_USER "
            "and PRINTER_PASSWORD in the worker env file, and check this "
            "ipptool supports -k."
        ), None

    if text is None:
        return None, False, (
            "ipptool returned no attributes - no request completed. "
            + (first_error or "(no output)")
        ), None

# The marker-* group is preferred when present: its values are paired with an
    # explicit colour identity, whereas the IPP 1.x attributes are matched by
    # name and so silently miss any model that does not use them. The older
    # patterns stay as the fallback so other printers keep working.
    levels = _marker_levels(text)
    if not levels:
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


def _queue_device_uri(queue):
    """Ask CUPS what device a queue points at, as a fallback for PRINTER_URI.

    The env file is written by install.sh and can be incomplete or replaced by
    hand. Rather than depend on it being exactly right, take the address CUPS
    itself is already using to reach this queue. Returns "" when there is
    nothing to fall back to, which callers must treat as "supplies unreadable"
    rather than fatal - printing goes through `lp` and the queue name and does
    not need this at all.
    """
    lpstat = shutil_which("lpstat")
    if not lpstat or not queue:
        return ""
    try:
        proc = subprocess.run([lpstat, "-v"], capture_output=True, text=True, timeout=15)
    except Exception:
        return ""

    for line in (proc.stdout or "").splitlines():
        # "device for Brother: ipp://10.100.131.48:631/ipp/print"
        if ":" not in line:
            continue
        label, _, uri = line.partition(":")
        if "device for" not in label.lower():
            continue
        if queue.lower() not in label.lower():
            continue
        uri = uri.strip()
        if uri:
            return uri
    return ""


def _names_a_model(strings):
    """True when an identity string actually names a model rather than a serial.

    Brother model numbers are hyphenated and contain digits - HL-L3240CDW,
    DCP-T430W - while the serial it reports as printer-name is not:
    BRW145A41F176AD. That one difference separates "the device said which
    model it is, and it is not the one we expect" from "the device gave us a
    serial and nothing else, which proves nothing about the model".

    Needed because the two cases used to be collapsed into one, and the
    uninformative one was reported as a confident wrong-printer verdict.
    """
    for s in strings or []:
        t = str(s).strip()
        if not t:
            continue
        if "series" in t.lower() or re.search(r"[A-Za-z]+-[A-Za-z]*\d", t):
            return True
    return False


def shutil_which(name):
    for d in os.environ.get("PATH", "").split(os.pathsep):
        p = os.path.join(d, name)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def get_printer_attrs_test():
    """Return a test file that asks the printer for EVERYTHING.

    CUPS ships a known-good Get-Printer-Attributes request, but it does not
    request `requested-attributes all`. Without that a printer returns only its
    mandatory attributes, which on this device meant a single line:

        printer-name = BRW145A41F176AD

    No make-and-model, no printer-info, and no toner levels at all. So the
    worker could neither identify the printer nor read a single supply.

    Rather than generating a request from scratch - which ipptool twice refused
    to parse with "Unexpected token ATTRIBUTE" - this copies CUPS's own file and
    injects only the requested-attributes block. The base is therefore known to
    parse on this machine, and the only thing we add is one well-defined stanza.

    Falls back to a hand-written minimal file only if CUPS's is missing.
    """
    target = os.path.join(tempfile.gettempdir(), "pk-get-printer-attributes-all.test")

    if CUPS_SYSTEM_TEST and os.path.exists(CUPS_SYSTEM_TEST):
        try:
            with open(CUPS_SYSTEM_TEST, "r") as f:
                src = f.read()

            if "requested-attributes" not in src:
                src = src.replace(
                    "STATUS successful-ok",
                    "ATTRIBUTE requested-attributes\n"
                    "    requested-attributes all\n"
                    "    STATUS successful-ok")
                if "requested-attributes" not in src:
                    # Unexpected shape - leave it exactly as CUPS shipped it
                    # rather than producing something unparseable.
                    #
                    # Logged, because this is the quiet failure that matters:
                    # the plain request still works, so nothing errors, but the
                    # printer answers with only its mandatory printer-name. No
                    # toner levels, no model - just a serial number, which then
                    # looks like a wrong-printer problem instead of "we never
                    # asked for the attributes".
                    log("enhanced supply request not injected (CUPS file shape "
                        "changed); falling back to the plain request, so this "
                        "printer will report NO toner levels")
                    return CUPS_SYSTEM_TEST

            with open(target, "w") as f:
                f.write(src)
            return target
        except Exception:
            pass

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
            brightness = _clamp_adjust(job.get("brightness"))
            contrast = _clamp_adjust(job.get("contrast"))
            image_to_pdf(src, pdf, grayscale, brightness, contrast)
            log("%s: image converted to PDF (%s%s)" % (
                public_id, "greyscale" if grayscale else "colour",
                "" if not (brightness or contrast)
                else ", brightness %+d, contrast %+d" % (brightness, contrast)))
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

    # Resolve the supply URI before the first poll. Previously this was read
    # straight out of CONFIG on every poll, and the key was not there, so the
    # first poll raised KeyError and the supplies block aborted every time -
    # silently, and with the worker still running and still printing. The
    # journal said only "supply report failed: 'printer_uri'" once every five
    # minutes, which is easy to scroll past and impossible to diagnose from the
    # dashboard, where the printer simply looked like it had stopped existing.
    if not CONFIG["printer_uri"]:
        CONFIG["printer_uri"] = _queue_device_uri(CONFIG["printer"])
        if CONFIG["printer_uri"]:
            log("PRINTER_URI not set in the env file; using the CUPS device for %s: %s"
                % (CONFIG["printer"], CONFIG["printer_uri"]))

    log("print worker starting -> printer=%s api=%s poll=%ds supplies=%s" % (
        CONFIG["printer"], CONFIG["api"], CONFIG["poll_seconds"],
        CONFIG["printer_uri"] or "UNRESOLVED - toner levels cannot be read"))

    # Not fatal, and deliberately so. Printing goes through `lp` and the queue
    # name; losing supply levels must never stop customers collecting documents.
    # It is announced at startup and then reported as unreadable on every poll.
    if not CONFIG["printer_uri"]:
        log("WARNING: no IPP address for %s, so toner/ink levels and the online"
            " state cannot be read. Printing still works. Set PRINTER_URI in the"
            " worker env file, or make sure the CUPS queue exists."
            % CONFIG["printer"])

    last_supply = 0.0
    last_watchdog = 0.0

    while True:
        now = time.time()

        if now - last_supply >= CONFIG["supply_seconds"]:
            try:
                levels, online, why, model = read_supplies()

                # Guard against reporting the wrong device. There are two Brother
                # printers on this network, so if the device we reached is not the
                # expected model, say so loudly instead of filing its toner levels
                # against the shop's HL.
                #
                # Brother reports printer-name as the unit SERIAL number, so the
                # expected model appears in printer-make-and-model or printer-info
                # instead. Accept it from any identity attribute rather than
                # rejecting the correct printer.
                expected = CONFIG.get("expected_model") or ""
                identity = model or []
                if identity and expected and not any(expected.lower() in s.lower() for s in identity):
                    # Only accuse the shop of pointing at the wrong machine when
                    # the device actually NAMED a model and that model is a
                    # different one.
                    #
                    # Brother reports printer-name as the unit serial
                    # ("BRW145A41F176AD"), so a reply carrying nothing but the
                    # serial says nothing at all about which model answered.
                    # Treating that as a mismatch produced a confident, false
                    # "wrong printer" verdict that sent staff hunting for a
                    # second Brother that was never involved.
                    if _names_a_model(identity):
                        why = ('polled %s but EXPECTED_MODEL is %s - wrong printer'
                               % (identity, expected))
                    else:
                        why = ('printer answered as %s but reported no model, so it '
                               'cannot be confirmed as the %s. This is the reply you '
                               'get when the request did not ask for all attributes.'
                               % (identity[0], expected))
                    levels, online = None, False
                elif identity and expected:
                    # Prefer whichever identity string names the model, so the
                    # dashboard does not show a serial where a model belongs.
                    model = next((s for s in identity if expected.lower() in s.lower()), identity[0])

                payload = {
                    "printer_name": CONFIG["printer"],
                    "printer_uri": CONFIG["printer_uri"],
                    "printer_model": model,
                    # So the backend can tell a genuinely stale reading from a
                    # fresh one. Without this the dashboard has to hardcode how
                    # often to expect a report, and that guess was wrong the
                    # moment the interval was changed in the env file.
                    "poll_interval": CONFIG["supply_seconds"],
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
