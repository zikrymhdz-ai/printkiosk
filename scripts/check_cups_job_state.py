"""Checks that the worker verifies a print job instead of assuming it printed.

Two bugs on 2026-10-27 made EVERY job report success within ~20 s with nothing
on the tray (PRN-20261027-2AB9 08:12:44 -> 08:13:04, -5F15 08:21:40 -> 08:22:04,
-9733 09:15:19 -> 09:15:38):

  1. cups_job_state ran `lpstat -W all -o <job_id>`. `lpstat -o` takes
     DESTINATION names, so the job id was read as a printer called
     "Brother-40", which does not exist. The output was always empty, so the
     state was always None.

  2. wait_for_outcome read None as "the job finished and CUPS purged the
     history", and returned success after a 15 s grace window. Absence of
     evidence was treated as proof of printing.

There is a third trap, found by running lpstat on the Pi: `-W all -o` there
prints NO state column at all --

    Brother-41  user  36864  Tue 27 Oct 2026 17:33:03 +08

-- so a printed job, a refused job and a cancelled job look identical. The
scheduler's IPP interface does report job-state, and ipptool is already a
dependency, so that is the primary source and lpstat is only the fallback.

Run: python scripts/check_cups_job_state.py
"""
import os
import re
import sys
import tempfile
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKER = os.path.join(ROOT, "pi", "print-worker.py")

FAILED = []


def ok(cond, msg):
    print(("  ok      " if cond else "  FAILED  ") + msg)
    if not cond:
        FAILED.append(msg)


class _Result:
    def __init__(self, returncode, stdout, stderr):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class _Clock:
    """A fake clock: sleeping must not cost the test suite real seconds."""

    def __init__(self):
        self.t = 0.0

    def time(self):
        return self.t

    def sleep(self, seconds):
        self.t += seconds


# Exactly what the shop's Pi prints. No state column anywhere.
PI_HISTORY = "\n".join([
    "Brother-1               root              1024   Wed 14 Oct 2026 12:58:24 +08",
    "Brother-12              user             63488   Thu 15 Oct 2026 12:04:36 +08",
    "Brother-39              user              1024   Tue 27 Oct 2026 17:06:09 +08",
    "Brother-40              user            324608   Tue 27 Oct 2026 17:15:22 +08",
    "Brother-41              user             36864   Tue 27 Oct 2026 17:33:03 +08",
]) + "\n"


def responder(active="", completed="", all_jobs="", long_out="",
              printer_out="", ipp="", lpoptions="", ipp_code=0):
    """Route an argv to the stream a real CUPS would produce for it."""
    def respond(args):
        if args[0] == "lpoptions":
            return 0, lpoptions, ""
        if args[0] == "ipptool":
            return ipp_code, "", ipp
        if args[0] != "lpstat":
            return 0, "", ""
        if "-p" in args:
            return 0, printer_out, ""
        if "-W" in args:
            if "-l" in args:
                return 0, long_out, ""
            which = args[args.index("-W") + 1]
            return 0, {"all": all_jobs, "completed": completed}.get(which, ""), ""
        return 0, active, ""
    return respond


def load_state_functions(respond):
    """Exec the job-state block from the worker, return (module, calls)."""
    calls = []

    def _run(args, **kw):
        calls.append(list(args))
        code, out, err = respond(list(args))
        return _Result(code, out, err)

    mod = types.ModuleType("pk_state")
    mod.__file__ = WORKER
    mod.subprocess = types.SimpleNamespace(run=_run)
    mod.time = _Clock()
    mod.re = re
    mod.os = os
    mod.tempfile = tempfile
    mod.shutil_which = lambda name: "/usr/bin/" + name
    mod.log = lambda *a, **k: None

    src = open(WORKER, encoding="utf-8").read()
    start = src.index("_JOB_STATES_DONE")
    end = src.index("def _color_runs(")
    exec(compile(src[start:end], WORKER, "exec"), mod.__dict__)
    return mod, calls


def load_option_reader(lpoptions_output):
    """Exec printer_option_names with lpoptions replaced by a recorder."""
    mod = types.ModuleType("pk_opts")
    mod.__file__ = WORKER
    mod.re = re
    mod.subprocess = types.SimpleNamespace(
        run=lambda args, **kw: _Result(0, lpoptions_output, ""))
    src = open(WORKER, encoding="utf-8").read()
    start = src.index("def printer_option_names(")
    end = src.index("_JOB_STATES_DONE")
    exec(compile(src[start:end], WORKER, "exec"), mod.__dict__)
    return mod


def ipp_job(state=None, reasons=None):
    """An ipptool Get-Job-Attributes reply for the local scheduler.

    `state` may be an RFC 8011 enum number or the NAME ipptool actually prints.
    """
    if state is None:
        # What a scheduler says when it has no such job.
        return "Get-Job-Attributes:\n    STATUS client-error-not-found\n"
    if isinstance(state, int):
        state = {3: "pending", 4: "held", 5: "processing", 6: "stopped",
                 7: "canceled", 8: "aborted", 9: "completed"}[state]
    out = ["Get-Job-Attributes:",
           "        status-code = successful-ok (successful-ok)",
           "    job-uri (uri) = ipp://localhost:631/jobs/41",
           "    job-state (enum) = %s" % state]
    if reasons:
        out.append("    job-state-reasons (keyword) = %s" % reasons)
    return "\n".join(out) + "\n"


# VERBATIM from the shop's Pi, 2026-10-27, for the test PDF that did print:
#
#   job-state (enum) = completed
#
# ipptool -tv prints the state NAME, not the number. The first version of the
# parser only accepted digits, so it found nothing on every poll and quietly
# fell back to lpstat - defeating the entire point of asking over IPP.
PI_REPLY_COMPLETED = """        status-code = successful-ok (successful-ok)
        job-state (enum) = completed
        job-state-reasons (keyword) = job-completed-successfully
        job-printer-state-message (textWithoutLanguage) = Unable to get printer status.
"""


def main():
    # --- 1. THE DESTINATION BUG -------------------------------------------
    # `lpstat -o` filters by DESTINATION. Passing the job id there returns
    # nothing on every poll, whatever the printer is really doing.
    mod, calls = load_state_functions(
        responder(ipp=ipp_job(), active=PI_HISTORY))
    mod.cups_job_state("Brother", "Brother-41")
    flattened = [a for c in calls for a in c]
    ok("Brother-41" not in flattened,
       "the job id is never passed to lpstat as a destination")

    # --- 2. IPP IS ASKED FIRST, AND ITS ANSWER IS USED --------------------
    # The real reply, exactly as the Pi printed it. This is the shape that
    # matters: a name, not an enum number.
    mod, calls = load_state_functions(responder(ipp=PI_REPLY_COMPLETED))
    ok(mod.cups_job_state("Brother", "Brother-41") == "completed",
       "the real ipptool reply is understood - it prints the state NAME")
    ipp_calls = [c for c in calls if c and c[0] == "ipptool"]
    ok(ipp_calls and "ipp://localhost:631/jobs/41" in ipp_calls[0],
       "and the job is asked about through the local scheduler: %s"
       % (ipp_calls[0][2] if ipp_calls else "-"))
    ok(not [c for c in calls if c and c[0] == "lpstat"],
       "lpstat is not consulted when IPP answered")

    # job-state-reasons contains the word 'completed' too. It must not be
    # mistaken for the state, or a failure would read as a success.
    mod, _ = load_state_functions(responder(
        ipp="        job-state-reasons (keyword) = job-completed-with-errors\n"))
    ok(mod.cups_job_ipp("Brother-41") == ("", ""),
       "a reason line on its own is not a state")

    # Numeric form, for a protocol dump rather than ipptool's pretty output.
    for enum, want in ((3, "pending"), (5, "printing"), (6, "stopped"),
                       (7, "canceled"), (8, "aborted"), (9, "completed")):
        mod, _ = load_state_functions(
            responder(ipp="    job-state (enum) = %d\n" % enum))
        got = mod.cups_job_state("Brother", "Brother-41")
        ok(got == want, "numeric job-state %d reads as %s (got %s)" % (enum, want, got))

    for name, want in (("pending", "pending"), ("pending-held", "held"),
                       ("processing", "printing"), ("processing-stopped", "stopped"),
                       ("canceled", "canceled"), ("aborted", "aborted"),
                       ("completed", "completed")):
        mod, _ = load_state_functions(
            responder(ipp="    job-state (enum) = %s\n" % name))
        got = mod.cups_job_state("Brother", "Brother-41")
        ok(got == want, "ipptool's '%s' reads as %s (got %s)" % (name, want, got))

    # --- 3. THE REAL PI SHAPE, WHEN IPP CANNOT ANSWER ---------------------
    # No state word in `lpstat -W all -o`; the job is out of the active queue
    # and in the finished list. That is the strongest evidence lpstat has.
    mod, _ = load_state_functions(
        responder(active="", completed=PI_HISTORY, all_jobs=PI_HISTORY))
    ok(mod.cups_job_state("Brother", "Brother-41") == "finished",
       "a finished job is recognised from lpstat alone")

    mod, _ = load_state_functions(
        responder(active=PI_HISTORY, completed="", all_jobs=PI_HISTORY))
    ok(mod.cups_job_state("Brother", "Brother-41") == "active",
       "a job still in the active queue is not treated as finished")

    mod, _ = load_state_functions(responder())
    ok(mod.cups_job_state("Brother", "Brother-41") is None,
       "a job CUPS has no record of reads as absent")

    # --- 4. THE SUBSTRING BUG ---------------------------------------------
    # 'Brother-1' is inside 'Brother-12'. Reporting a neighbour's state as this
    # job's is how one job's paper vouches for another's.
    mod, _ = load_state_functions(
        responder(active="", completed=PI_HISTORY, all_jobs=PI_HISTORY))
    ok(mod.cups_job_state("Brother", "Brother-1") == "finished",
       "Brother-1 and Brother-12 are told apart by exact id")

    # --- 5. A VANISHED JOB IS NOT A PRINTED JOB ---------------------------
    # The whole failure: empty lpstat output used to mean success.
    mod, _ = load_state_functions(responder())
    mod.JOB_VISIBLE_GRACE = 0
    printed, reason = mod.wait_for_outcome("Brother", "Brother-41", 30)
    ok(printed is False,
       "a job CUPS never lists is a failure, not a success")
    ok("never appeared" in (reason or ""),
       "and the reason says the submission vanished: %s" % reason)

    # --- 6. THE HAPPY PATH ------------------------------------------------
    def completes_second_poll():
        state = {"n": 0}

        def respond(args):
            if args[0] == "ipptool":
                state["n"] += 1
                return 0, "", ipp_job(5 if state["n"] == 1 else 9)
            return 0, "", ""
        return respond

    mod, _ = load_state_functions(completes_second_poll())
    printed, reason = mod.wait_for_outcome("Brother", "Brother-41", 30)
    ok(printed is True, "a job the scheduler reports completed is a success (%r)" % reason)

    # --- 7. ABORTED, WITH THE SCHEDULER'S OWN REASON ----------------------
    # job-state-reasons is the string that actually names the fault, so it has
    # to reach print_error where staff can read it.
    mod, _ = load_state_functions(
        responder(ipp=ipp_job(8, "document-format-error")))
    printed, reason = mod.wait_for_outcome("Brother", "Brother-41", 30)
    ok(printed is False, "an aborted job is a failure")
    ok("aborted" in (reason or ""), "and says so: %s" % reason)
    ok("document-format-error" in (reason or ""),
       "and carries the scheduler's reason: %s" % reason)

    # A cancel is a failure too - paper may not have come out.
    mod, _ = load_state_functions(responder(ipp=ipp_job(7)))
    printed, reason = mod.wait_for_outcome("Brother", "Brother-41", 30)
    ok(printed is False, "a cancelled job is a failure")

    # --- 8. FALLBACK COMPLETION NEEDS A HEALTHY PRINTER -------------------
    mod, _ = load_state_functions(
        responder(active="", completed=PI_HISTORY, all_jobs=PI_HISTORY))
    printed, reason = mod.wait_for_outcome("Brother", "Brother-41", 30)
    ok(printed is True, "the lpstat fallback can still complete a job")

    mod, _ = load_state_functions(
        responder(active="", completed=PI_HISTORY, all_jobs=PI_HISTORY,
                  printer_out="printer Brother disabled since Tue 27 Oct"))
    printed, reason = mod.wait_for_outcome("Brother", "Brother-41", 30)
    ok(printed is False,
       "but not while the queue reports a stop reason: %s" % reason)

    # --- 9. SEEN, THEN GONE ------------------------------------------------
    # With job history off, a finished job disappears -- but so does a job the
    # scheduler threw away. Neither may be reported as printed.
    def prints_then_vanishes():
        state = {"n": 0}

        def respond(args):
            if args[0] == "ipptool":
                state["n"] += 1
                # 5 = processing, then the job is no longer known at all.
                return 0, "", (ipp_job(5) if state["n"] <= 2 else ipp_job())
            return 0, "", ""
        return respond

    mod, _ = load_state_functions(prints_then_vanishes())
    printed, reason = mod.wait_for_outcome("Brother", "Brother-41", 60)
    ok(printed is False,
       "a job that leaves the queue without 'completed' is a failure")
    ok("paper tray" in (reason or "") or "error_log" in (reason or ""),
       "and points staff at the tray and the CUPS log: %s" % reason)

    # --- 10. NO JOB ID -----------------------------------------------------
    mod, calls = load_state_functions(responder(ipp=ipp_job(9)))
    printed, reason = mod.wait_for_outcome("Brother", "", 30)
    ok(printed is False, "no job id cannot be a success")
    ok(not calls, "and it does not bother asking CUPS")
    ok("lpstat" in (reason or ""),
       "the reason tells the operator where to look: %s" % reason)

    # --- 11. THE TIMEOUT IS STILL HONEST ----------------------------------
    mod, _ = load_state_functions(responder(ipp=ipp_job(5)))
    printed, reason = mod.wait_for_outcome("Brother", "Brother-41", 30)
    ok(printed is False, "a job stuck in 'printing' past the timeout is a failure")
    ok("did not confirm" in (reason or ""),
       "and says it was not confirmed: %s" % reason)

    ok(mod.JOB_VISIBLE_GRACE >= 10,
       "a new job is given time to appear before being called missing")
    ok(mod.JOB_HISTORY_GRACE >= 4,
       "and a single empty poll does not decide the outcome")

    # --- 12. A JOB ID THAT IS NOT A NUMBER MUST NOT BE GUESSED AT ---------
    mod, _ = load_state_functions(responder(ipp=ipp_job(9)))
    ok(mod._job_uri("Brother-41") == "ipp://localhost:631/jobs/41",
       "a job URI is built from the job number")
    ok(mod._job_uri("Brother-") == "" and mod._job_uri("garbage") == "",
       "and a non numeric job id yields no URI instead of a wrong one")

    # --- 13. THE COLOUR OPTION -- NAME DEPENDS ON THE QUEUE ---------------
    # The shop's queue is a Brother PPD queue: `lpoptions -p Brother -l` shows
    # ColorModel/Output Mode: *RGB Gray, and no print-color-mode at all. A
    # driverless IPP Everywhere queue is the opposite. The worker must use
    # whichever name the queue actually advertises.
    mod = load_option_reader(
        "ColorModel/Output Mode: *RGB Gray\n"
        "PageSize/Media Size: *A4 Letter\n"
        "Duplex/Duplex: *None DuplexNoTumble DuplexTumble\n")
    names = mod.printer_option_names("Brother")
    ok("colormodel" in names,
       "the shop's PPD queue is detected as taking ColorModel: %s" % sorted(names))
    ok("print-color-mode" not in names,
       "and it does not advertise the driverless spelling")

    mod = load_option_reader(
        "copies/Copies: 1\n"
        "print-color-mode/Color Mode: *color monochrome\n"
        "media/Media Size: iso_a4_210x297mm\n")
    names = mod.printer_option_names("Brother")
    ok("print-color-mode" in names,
       "a driverless queue is detected as taking print-color-mode: %s" % sorted(names))
    ok("colormodel" not in names,
       "and its colour option is not guessed")

    mod = load_option_reader("")
    ok(mod.printer_option_names("Brother") == set(),
       "a queue that reports no options yields an empty set, not an error")

    print("  -> %d failed" % len(FAILED) if FAILED else
          "  ok      a job is only 'printed' when CUPS says it completed")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
