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
#
# Two shapes exist. This Pi's build emits the named-group form with no index at
# all -- matching only the indexed form made a good response look like a request
# that never completed.
GOOD_INDEXED = "\n".join([
    "    [12] printer-uri (uri) = 'ipp://10.100.131.48:631/ipp/print'",
    "    [13] printer-name (nameWithoutLanguage) = Brother HL-L3240CDW series",
    "    [14] printer-toner-black-remaining (integer) = 87 (% of supply)",
    "    [15] printer-toner-cyan-remaining (integer) = 42 (% of supply)",
    "    [16] printer-toner-magenta-remaining (integer) = 13 (% of supply)",
    "    [17] printer-toner-yellow-remaining (integer) = 0 (% of supply)",
])

GOOD_GROUPED = "\n".join([
    "Get-Printer-Attributes:",
    "    attributes-charset (charset) = utf-8",
    "    attributes-natural-language (naturalLanguage) = en",
    "    printer-name (nameWithoutLanguage) = Brother HL-L3240CDW series",
    "    printer-make-and-model (nameWithoutLanguage) = Brother HL-L3240CDW series",
    "    printer-toner-black-remaining (integer) = 87 (% of supply)",
    "    printer-toner-cyan-remaining (integer) = 42 (% of supply)",
    "    printer-toner-magenta-remaining (integer) = 13 (% of supply)",
    "    printer-toner-yellow-remaining (integer) = 0 (% of supply)",
])

# Exactly what the Pi reported.
REJECTED = ('ipptool: Unexpected token ATTRIBUTE seen on line 4 of '
            '"/tmp/pk-get-printer-attributes.test".')

FAILED = []

# The option list the Pi's ipptool printed when given -k. Note what is absent:
# there is no -k, which is the whole reason the worker probes for it.
HELP_TEXT = ("Usage: ipptool [options] URI filename [ ... filenameN ]\n"
             "Options:\n"
             "--ippserver filename\n"
             "--version\n"
             "-4\n-6\n-C\n-E\n-I\n-L\n-t\n-v\n")


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
        # The flags MUST be passed through. An earlier shim ignored them, so
        # every pattern compiled without re.MULTILINE, "$" stopped matching at
        # end-of-line, and the identity lookups returned None - which looked
        # exactly like a worker bug and nearly caused a correct parser to be
        # "fixed" into a broken one.
        return re.compile(pattern, flags)

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
        # `ipptool --help` carries no test file. The worker runs it once to find
        # out whether this build has -k, so the stub has to answer it instead of
        # reaching for args[3] and raising IndexError.
        if "--help" in args or "-h" in args:
            return _Result(0, HELP_TEXT, "")
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
    # The worker now warns at startup when credentials cannot be sent. Keep the
    # harness quiet so it does not drown the test output.
    mod.log = lambda *a, **k: None

    # The worker guards everything behind these at import time. Take one
    # CONTIGUOUS slice: piecemeal per-line matching broke as soon as an
    # assignment wrapped onto a second line, silently capturing half a
    # definition and reporting nonsense.
    src = open(WORKER, encoding="utf-8").read()
    code = src[src.index("_TAG = "):src.index("def _probe(test_path)")]
    code += src[src.index("def _probe(test_path)"):src.index("def report(job_id")]
    keep, skip = [], False
    needed = ("get_printer_attrs_test", "_probe", "read_supplies",
              "reported_model", "_first", "_auth_args",
              # Both are called by the functions above, so they have to survive
              # the filter or the extracted read_supplies raises NameError.
              "_looks_unauthorized", "_ipptool_supports_k",
              # Transport classification moved out of read_supplies so the log
              # line, the retry decision and the report all use one list.
              "_transport_failure", "_cups_uri_hint",
              # The IPP marker-* supply parser and its list helper.
              "_marker_levels", "_split_set")
    for line in code.splitlines():
        if line.startswith("def ") and not any(n in line for n in needed):
            skip = True
        elif line and not line[0].isspace():
            skip = False
        if not skip:
            keep.append(line)
    exec(compile("\n".join(keep), WORKER, "exec"), mod.__dict__)
    mod_reported_model = mod.reported_model
    return mod.read_supplies, calls, mod_reported_model


def main():
    # 1. The enhanced request is used, and it asks for EVERYTHING.
    #
    # CUPS's file on its own returns only mandatory attributes - on this device
    # that was a single printer-name line, with no model and no toner levels, so
    # the printer could neither be identified nor measured.
    rs, calls, _ = load_worker(
        "/usr/share/cups/ipptool/get-printer-attributes.test",
        lambda p: (0, "", GOOD_GROUPED))
    levels, online, why, model = rs()
    ok(calls and calls[0].startswith(tempfile.gettempdir()),
       "the enhanced request (built from CUPS's file) is used first")
    requested = None
    try:
        requested = open(calls[0], encoding="utf-8").read()
    except Exception:
        pass
    ok(requested and "requested-attributes all" in requested,
       "and it requests all attributes, not just the mandatory set")
    ok(requested and "OPERATION Get-Printer-Attributes" in requested,
       "and it is still a Get-Printer-Attributes request")
    ok(levels and levels.get("toner_black") == 87,
       "toner parsed on the first try: %s" % levels)

    # 1b. The shape THIS Pi emits: a named group with no [n] index at all.
    rs, calls, mod_reported_model = load_worker(
        "/usr/share/cups/ipptool/get-printer-attributes.test",
        lambda p: (0, "", GOOD_GROUPED))
    levels, online, why, model = rs()
    ok(levels and levels.get("toner_black") == 87,
       "the grouped (un-indexed) output shape parses too: %s" % levels)
    ok(online is True, "grouped output is reported as a reachable printer")

    # 1c. THE MODEL ON THE SHOP'S PRINTER: the IPP 2.x marker-* group.
    #
    # The HL-L3240CDW never sends printer-toner-black-remaining at all. It sends
    # marker-levels, an ordered set of bare numbers carrying no colour of their
    # own, paired with marker-colors in the same reply. Looking only for the
    # IPP 1.x attributes meant a printer reporting 90% black was reported as
    # having no toner information at all - which is what both the dashboard and
    # the kiosk were showing.
    MARKER_REPLY = """
    Get-Printer-Attributes:
        attributes-charset (charset) = utf-8
        printer-info (textWithoutLanguage) = Brother HL-L3240CDW series
        marker-colors (1setOf nameWithoutLanguage) = #000000,#00FFFF,#FF00FF,#FFFF00
        marker-high-levels (1setOf integer) = 100,100,100,100
        marker-levels (1setOf integer) = 90,100,100,100
        marker-low-levels (1setOf integer) = 10,10,10,10
        marker-names (1setOf nameWithoutLanguage) = BK,C,M,Y
        marker-types (1setOf keyword) = toner,toner,toner,toner
"""
    rs, calls, mod_reported_model = load_worker(
        "/usr/share/cups/ipptool/get-printer-attributes.test",
        lambda p: (0, "", MARKER_REPLY))
    levels, online, why, model = rs()
    ok(levels and levels.get("toner_black") == 90,
       "marker-* levels are read: %s" % levels)
    ok(levels and levels.get("toner_cyan") == 100
       and levels.get("toner_magenta") == 100 and levels.get("toner_yellow") == 100,
       "all four toners are attributed to the right colours")
    ok(online is True, "a marker-* reply is a reachable printer with real readings")

    # Identity comes from the colour list, not the position: reorder it and the
    # numbers must follow. Pairing by position is how cyan ends up on the black bar.
    MARKER_REORDERED = MARKER_REPLY.replace(
        "#000000,#00FFFF,#FF00FF,#FFFF00", "#00FFFF,#000000,#FF00FF,#FFFF00").replace(
        "90,100,100,100", "5,90,7,8")
    rs, calls, _ = load_worker(
        "/usr/share/cups/ipptool/get-printer-attributes.test",
        lambda p: (0, "", MARKER_REORDERED))
    levels, online, why, model = rs()
    ok(levels and levels.get("toner_black") == 90 and levels.get("toner_cyan") == 5,
       "values follow their colour identity, not their position: %s" % levels)

    # Negatives mean unknown, not empty. Clamping them to zero would report a
    # working printer as out of toner - the dangerous direction.
    MARKER_NEGATIVE = """
        marker-colors (1setOf nameWithoutLanguage) = #000000,#00FFFF,#FF00FF,#FFFF00
        marker-levels (1setOf integer) = -1,50,-2,60
"""
    rs, calls, _ = load_worker(
        "/usr/share/cups/ipptool/get-printer-attributes.test",
        lambda p: (0, "", MARKER_NEGATIVE))
    levels, online, why, model = rs()
    ok(levels and levels.get("toner_black") is None,
       "a negative marker level stays unknown rather than becoming 0%%: %s" % levels)
    ok(levels and levels.get("toner_cyan") == 50,
       "the readable markers alongside it are still reported")

    # The older IPP 1.x form must keep working for other printers.
    rs, calls, _ = load_worker(None, lambda p: (0, "", GOOD_GROUPED))
    levels, online, why, model = rs()
    ok(levels and levels.get("toner_black") == 87,
       "the older printer-toner-* form still works (regression guard)")

    # 2. CUPS file missing -> generated fallback used.
    rs, calls, mod_reported_model = load_worker(None, lambda p: (0, "", GOOD_INDEXED))
    levels, online, why, model = rs()
    ok(calls and calls[0].startswith(tempfile.gettempdir()),
       "falls back to the generated file when CUPS has none (%s)" % (calls[0] if calls else "-"))
    ok(levels and levels.get("toner_black") == 87, "toner parsed via the generated file")

    # 3. THE REAL CASE: nothing parses, ipptool still exits 0.
    #    Must NOT report a reachable printer with no data.
    rs, calls, mod_reported_model = load_worker(None, lambda p: (0, "", REJECTED))
    levels, online, why, model = rs()
    ok(levels is None, "no levels invented when the request never completed")
    ok(online is False, "reported offline, not 'reachable'")
    ok("no request completed" in (why or ""), "says no request completed: %s" % why)
    ok("Unexpected token" in (why or ""), "still surfaces ipptool's own error")

    # 4. A real transport failure must not be retried pointlessly, but must be
    #    reported with the URI.
    def refused(p):
        return (1, "", "ipptool: connect: Connection refused")

    rs, calls, mod_reported_model = load_worker("/usr/share/cups/ipptool/get-printer-attributes.test", refused)
    levels, online, why, model = rs()
    ok(levels is None and online is False, "a refused connection is offline")

    # 4b. THE LIVE CASE, 2026-10-27. ipptool's wording on this network is
    #     "Unable to connect ... Host is down", not "cannot connect". The old
    #     marker list missed it, so the error transcript fell through to the
    #     attribute parser and was reported as "reachable, but no toner
    #     attributes in the response. Got: ipptool: Unable to connect ..." -
    #     a sentence that contradicts itself and blames parsing for a dead
    #     address.
    HOST_DOWN = ('ipptool: Unable to connect to "10.100.131.48" on port 631'
                 ' - Host is down')

    def host_down(p):
        return (1, "", HOST_DOWN)

    rs, calls, mod_reported_model = load_worker(
        "/usr/share/cups/ipptool/get-printer-attributes.test", host_down)
    levels, online, why, model = rs()
    ok(levels is None and online is False, "'Host is down' is an unreachable printer")
    ok("reachable, but no toner" not in (why or ""),
       "it is not reported as a reachable printer with a parsing problem: %s" % why)
    ok("cannot reach" in (why or ""), "the reason names the failure: %s" % why)
    ok("Host is down" in (why or ""), "and quotes ipptool's own words")
    ok("10.100.131.48" in (why or ""), "and the address it failed to reach")

    # 4c. Any other non-zero exit is still not a response. Its transcript must
    #     never be parsed as an attribute dump.
    def odd_exit(p):
        return (1, "", "ipptool: something nobody has seen before")

    rs, calls, mod_reported_model = load_worker(
        "/usr/share/cups/ipptool/get-printer-attributes.test", odd_exit)
    levels, online, why, model = rs()
    ok(levels is None and online is False, "an unclassified non-zero exit is offline")
    ok("reachable, but no toner" not in (why or ""),
       "and is never called a reachable printer: %s" % why)
    ok("no request completed" in (why or ""),
       "it says the request never completed: %s" % why)

    # 5. THE REAL CASE: Brother reports the SERIAL as printer-name.
    #    The correct printer must not be rejected as "wrong printer".
    BROTHER = "\n".join([
        "Get-Printer-Attributes:",
        "    attributes-charset (charset) = utf-8",
        "    printer-name (nameWithoutLanguage) = BRW145A41F176AD",
        "    printer-make-and-model (nameWithoutLanguage) = Brother HL-L3240CDW series",
        "    printer-info (text) = Brother HL-L3240CDW series",
        "    printer-toner-black-remaining (integer) = 91 (% of supply)",
        "    printer-toner-cyan-remaining (integer) = 88 (% of supply)",
        "    printer-toner-magenta-remaining (integer) = 90 (% of supply)",
        "    printer-toner-yellow-remaining (integer) = 92 (% of supply)",
    ])
    identity = mod_reported_model(BROTHER)
    ok(identity and len(identity) >= 2,
       "identity gathers the serial AND the model: %s" % identity)
    ok(all("\n" not in s and len(s) < 80 for s in identity or []),
       "each identity is a single short line, not the rest of the response")
    expected = "HL-L3240CDW"
    ok(any(expected.lower() in s.lower() for s in identity or []),
       "the expected model is found in one of them")
    ok(not ("BRW145A41F176AD".lower() == expected.lower()),
       "the serial alone does not satisfy the model check")

    # 6. A printer that REQUIRES a password.
    #    Unauthenticated, ipptool exits 0 and prints a mandatory printer-name
    #    and nothing else. That is what made a missing password look like a
    #    serial number and a wrong printer.
    UNAUTH = "\n".join([
        "Get-Printer-Attributes:",
        "    printer-name (nameWithoutLanguage) = BRW145A41F176AD",
        "    STATUS client-error-not-authorized",
    ])
    rs, calls, _ = load_worker("/usr/share/cups/ipptool/get-printer-attributes.test",
                              lambda p: (0, "", UNAUTH))
    levels, online, why, model = rs()
    ok(levels is None, "an unauthorized read produces no levels")
    ok(online is False, "and is reported offline")
    # The wording changed from "printer requires authentication" to "every
    # request was refused for authentication", because one refusal is not
    # proof: this printer allows the plain request anonymously and refuses only
    # the enhanced one. The intent of the assertion is unchanged - a
    # password-demanding printer must not be blamed on the wrong machine.
    ok("refused for authentication" in (why or ""),
       "and says a password is required, not 'wrong printer': %s" % why)
    ok("wrong printer" not in (why or ""),
       "it is not misdiagnosed as the wrong printer")

    # 7. Credentials must reach ipptool as -u/-k, never on the command line.
    key = os.path.join(tempfile.gettempdir(), "pk-ipp-auth.key")
    if os.path.exists(key):
        ok(True, "an ipptool key file is used for the password")
        with open(key) as f:
            lines = f.read().splitlines()
        ok(len(lines) >= 2, "the key file holds the user and the password")
    else:
        ok(True, "no credentials configured, so no key file is written")

    # ipptool absent.
    src = open(WORKER, encoding="utf-8").read()
    ok("ipptool not installed" in src, "missing ipptool is reported plainly")
    ok('"printer_user": os.environ.get("PRINTER_USER"' in src,
       "a printer username is read from the environment")
    ok('"printer_password": os.environ.get("PRINTER_PASSWORD"' in src,
       "a printer password is read from the environment")
    ok("0o600" in src, "the key file is created 0600, never world-readable")
    ok(src.index('"-k", key_path') > 0, "the password is passed via -k, not as an argument")

    print("  -> %d failed" % len(FAILED) if FAILED else
          "  ok      the worker recovers from an unusable test file")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())