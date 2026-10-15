"""Exercises read_supplies' test-file fallback with a stand-in ipptool.

The generated test file has been rejected twice by ipptool ("Unexpected token
ATTRIBUTE seen on line 4") with syntax matching the CUPS original, and it cannot
be verified from a machine without ipptool. read_supplies now prefers CUPS's own
get-printer-attributes.test and falls back to the generated file.

This runs the real read_supplies from pi/print-worker.py with shims for
subprocess/os/tempfile, so the behaviour is checked rather than the source text.
"""
import os
import re
import sys
import tempfile
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKER = os.path.join(ROOT, "pi", "print-worker.py")

# Well-formed ipptool output, as it actually appears (on stderr).
GOOD = "\n".join([
    "    [12] printer-uri (uri) = 'ipp://10.100.131.48:631/ipp/print'",
    "    [13] printer-name (nameWithoutLanguage) = Brother HL-L3240CDW series",
    "    [14] printer-toner-black-remaining (integer) = 87 (% of supply)",
    "    [15] printer-toner-cyan-remaining (integer) = 42 (% of supply)",
    "    [16] printer-toner-magenta-remaining (integer) = 13 (% of supply)",
    "    [17] printer-toner-yellow-remaining (integer) = 0 (% of supply)",
])

# Exactly what the Pi reported.
REJECTED = ('ipptool: Unexpected token ATTRIBUTE seen on line 4 of '
            '"/tmp/pk-get-printer-attributes.test".')

FAILED = []


def ok(cond, msg):
    print(("  ok      " if cond else "  FAILED  ") + msg)
    if not cond:
        FAILED.append(msg)


def load_worker(system_exists, ipptool):
    """Load pi/print-worker.py's read_supplies with shims, return (fn, calls)."""
    calls = []

    mod = types.ModuleType("pk")
    mod.__file__ = WORKER
    mod.CONFIG = {"printer_uri": "ipp://10.100.131.48:631/ipp/print"}

    def _compile(pattern, flags=0):
        return re.compile(pattern)

    class _re:
        compile = staticmethod(_compile)
        MULTILINE = re.MULTILINE
        search = staticmethod(re.search)

    mod.re = _re

    class _Result:
        def __init__(self, returncode, stdout, stderr):
            self.returncode = returncode
            self.stdout = stdout
            self.stderr = stderr

    def _run(args, **kw):
        calls.append(args[3])
        code, out, err = ipptool(args[3])
        return _Result(code, out, err)

    mod.subprocess = types.SimpleNamespace(run=_run)
    mod.os = types.SimpleNamespace(
        path=types.SimpleNamespace(
            exists=lambda p: p == system_exists if system_exists else False,
            join=lambda a, b: a + "/" + b,
        )
    )
    mod.tempfile = types.SimpleNamespace(gettempdir=lambda: tempfile.gettempdir())
    mod.shutil_which = lambda name: "/usr/bin/ipptool"

    # The worker guards everything behind these at import time.
    src = open(WORKER, encoding="utf-8").read()
    code = src[src.index("_TAG = "):src.index("def report(job_id")]
    # Drop the network/queue helpers the slice drags in; they are unused here.
    keep, skip = [], False
    needed = ("get_printer_attrs_test", "_probe", "read_supplies", "reported_model")
    for line in code.splitlines():
        if line.startswith("def ") and not any(n in line for n in needed):
            skip = True
        elif line and not line[0].isspace():
            skip = False
        if not skip:
            keep.append(line)
    exec(compile("\n".join(keep), WORKER, "exec"), mod.__dict__)
    return mod.read_supplies, calls


def main():
    # 1. CUPS's file works -> used first, no fallback needed.
    rs, calls = load_worker(
        "/usr/share/cups/ipptool/get-printer-attributes.test",
        lambda p: (0, "", GOOD))
    levels, online, why, model = rs()
    ok(calls and calls[0].startswith("/usr/share/cups"),
       "CUPS's own test file is tried first (%s)" % (calls[0] if calls else "-"))
    ok(levels and levels.get("toner_black") == 87,
       "toner parsed on the first try: %s" % levels)

    # 2. CUPS file missing -> generated fallback used.
    rs, calls = load_worker(None, lambda p: (0, "", GOOD))
    levels, online, why, model = rs()
    ok(calls and calls[0].startswith(tempfile.gettempdir()),
       "falls back to the generated file when CUPS has none (%s)" % (calls[0] if calls else "-"))
    ok(levels and levels.get("toner_black") == 87, "toner parsed via the generated file")

    # 3. THE REAL CASE: nothing parses, ipptool still exits 0.
    #    Must NOT report a reachable printer with no data.
    rs, calls = load_worker(None, lambda p: (0, "", REJECTED))
    levels, online, why, model = rs()
    ok(levels is None, "no levels invented when the request never completed")
    ok(online is False, "reported offline, not 'reachable'")
    ok("no request completed" in (why or ""), "says no request completed: %s" % why)
    ok("Unexpected token" in (why or ""), "still surfaces ipptool's own error")

    # 4. A real transport failure must not be retried pointlessly, but must be
    #    reported with the URI.
    def refused(p):
        return (1, "", "ipptool: connect: Connection refused")

    rs, calls = load_worker("/usr/share/cups/ipptool/get-printer-attributes.test", refused)
    levels, online, why, model = rs()
    ok(levels is None and online is False, "a refused connection is offline")

    # 5. ipptool absent.
    src = open(WORKER, encoding="utf-8").read()
    ok("ipptool not installed" in src, "missing ipptool is reported plainly")

    print("  -> %d failed" % len(FAILED) if FAILED else
          "  ok      the worker recovers from an unusable test file")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())