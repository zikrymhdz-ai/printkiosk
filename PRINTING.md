# Real Printing — Deployment Runbook

PrintKiosk real printing, customer-triggered, Brother HL-L3240CDW via CUPS.

## The core rule

**Nothing prints until a customer taps "Print My Document" at the kiosk.**

Only the kiosk can move a job from `ready_to_print` -> `print_requested`
(`printer.js` `requestPrint`). The Pi worker only ever claims jobs whose status
is `print_requested`. There is no scheduled sweep and no "print everything
pending" path, so a job that is paid but unclaimed sits quietly until a person
asks for it.

## Status lifecycle

```
pending            created, awaiting payment
ready_to_print     PAID, waiting for the customer to tap collect
print_requested    customer tapped -> the worker will print it
printing           worker claimed it, job is at the printer
completed          printed successfully
failed             worker gave up -> appears in admin "Failed Print Jobs"
```

## What changed

| File | Change |
|---|---|
| `migrations/20261014_print_lifecycle.sql` | new statuses + lifecycle columns + partial indexes |
| `netlify/functions/_shared.js` | `PRINT_WORKER_SECRET`, `safeEqual()`, version `2026.10.14-37` |
| `netlify/functions/printer.js` | `request-print`, `claim-job`, `report-print`, `report-supplies`, `watchdog`, `reprint`, `print-status`, `failed-jobs` |
| `pi/print-worker.py` | the worker (new) |
| `pi/printkiosk-worker.service` | systemd unit (new) |
| `kiosk/walkin.html` | "Print My Document" button + live printing-progress screen |
| `website/upload.html`, `website/customer.html` | Duplex selector + matching pricing |
| `admin/admin.html` | Failed Print Jobs card, "Print Now"/"Reprint", `escHtml()` |

## Step 1 — Run the SQL migration

Supabase Dashboard -> SQL Editor -> paste -> run:

```sql
-- 20261014_print_lifecycle.sql  (full contents are in migrations/20261014_print_lifecycle.sql)
ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_status_check;
ALTER TABLE print_jobs
  ADD CONSTRAINT print_jobs_status_check CHECK (
    status IN ('pending','ready_to_print','print_requested','printing',
               'completed','failed','superseded','refund_issued','cancelled')
  );

ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS print_requested_at  timestamptz;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS print_claimed_at    timestamptz;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS print_started_at    timestamptz;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS print_completed_at  timestamptz;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS print_error         text;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS print_attempts      integer NOT NULL DEFAULT 0;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS print_by            text;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS print_page_verified boolean;

CREATE INDEX IF NOT EXISTS print_jobs_print_requested_idx
  ON print_jobs (print_requested_at) WHERE status = 'print_requested';
CREATE INDEX IF NOT EXISTS print_jobs_printing_idx
  ON print_jobs (print_claimed_at) WHERE status = 'printing';

UPDATE print_jobs SET print_attempts = 0 WHERE print_attempts IS NULL;
```

`status` has a CHECK constraint, so this step is mandatory — without it every
`request-print` call fails with `23514`.

## Step 2 — Netlify environment variable

Site settings -> Environment variables -> add:

| Key | Value |
|---|---|
| `PRINT_WORKER_SECRET` | `<paste-your-secret-here>` |

Generate your own with:

```bash
python3 -c "import secrets; print('pk_print_' + secrets.token_hex(32))"
```

The **same** value must also go on the Pi (Step 4). One character different and
every worker request is rejected with `401`.

There is deliberately **no fallback in code** — if this variable is missing,
every worker request is rejected rather than accepted with a guessable token.

Then redeploy so the new functions ship.

## Step 3 — Clear the old test jobs

After the migration, the six test jobs can be parked so they can never print:

```bash
# from the repo, using the same pattern as before
```

Or simply paste into the SQL editor:

```sql
UPDATE print_jobs SET status = 'superseded'
 WHERE status = 'ready_to_print'
   AND created_at < now();
```

## Step 4 — Install the worker on the Pi

```bash
# from your PC
scp pi/print-worker.py            user@10.100.131.35:/home/user/printkiosk/pi/
scp pi/printkiosk-worker.service  user@10.100.131.35:/home/user/printkiosk/pi/

ssh user@10.100.131.35
```

On the Pi:

```bash
sudo apt install -y cups-client poppler-utils python3-pil python3-pypdf libnss-mdns avahi-utils

# the secret must match Netlify exactly
mkdir -p ~/printkiosk/pi
cat > ~/printkiosk/pi/print-worker.env <<'EOF'
PRINT_WORKER_SECRET=<paste-your-secret-here>
PRINTKIOSK_API=https://printkioskfyp.netlify.app
PRINTER_NAME=Brother
# Use the printer's mDNS NAME, never a bare IP. This printer gets its address
# from DHCP, and on 2026-10-27 it had moved from 10.100.131.48 to 10.100.138.65:
# CUPS and this file were both still pointing at the old address, the toner read
# failed with "Host is down", and the kiosk told every customer the printer could
# not be reached - while the queue itself was fine. A .local name follows the
# printer; libnss-mdns above is what lets ipptool and lp resolve it.
# Find yours with:  ippfind -T 5     (then match the serial on the printer)
PRINTER_URI=ipp://BRW145A41F176AD.local:631/ipp/print
EOF
chmod 600 ~/printkiosk/pi/print-worker.env

sudo cp ~/printkiosk/pi/printkiosk-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now printkiosk-worker
```

Check it:

```bash
sudo systemctl status printkiosk-worker
sudo journalctl -u printkiosk-worker -f
```

## Step 5 — Test without spending paper

```bash
cd ~/printkiosk/pi
python3 print-worker.py --once
```

With nothing queued it should log:

```
no job waiting (nothing prints until a customer taps collect)
```

That is the correct and desired behaviour.

## Testing with real paper

1. Upload a 1-page PDF on the website.
2. Pay it.
3. At the kiosk, enter the PIN.
4. Tap **Print My Document**.
5. The kiosk shows a live printing screen, then "All done!".

Confirm in admin -> Printer: the job appears under Ready, disappears when
claimed, and Failed Print Jobs stays empty.

## Safety properties worth knowing

- **Page-count guard.** The worker reads the real page count from the PDF and
  refuses to print if it disagrees with the stored `pages` value. A customer who
  paid for 3 pages can never be silently handed 1 or 5.
- **Page ranges.** Already stripped in the browser by `pagerange.js`, so the
  stored PDF contains only the selected pages.
- **Images.** JPEG/PNG uploads are flattened to PDF on the Pi, with greyscale
  applied there so it does not depend on the driver honouring `ColorModel`.
- **Claiming is a compare-and-set** (`PATCH ...?status=eq.print_requested`).
  A double tap or a retry cannot print the same page twice.
- **Retry** is 3 attempts; after that the job becomes `failed` and raises an
  alert so staff can reprint or refund.
- **Watchdog** flips anything stuck in `printing` for 30 minutes to `failed`.
- **Idempotent kiosk tap.** `request-print` returns success if the job is already
  queued/printing/done, so a double tap is harmless.

## Known limitations

- `request-print` is unauthenticated (the kiosk has no session at that point).
  It only accepts an unguessable UUID and only transitions `ready_to_print`,
  but it is not a hard authentication boundary.
- `data.js?action=kiosk-heartbeat` is also unauthenticated — anyone can post
  fake heartbeats and make admin show the kiosk as online. Pre-existing.
- Paper level cannot be read over IPP (drivers report loaded trays, not a
  remaining count), so `paper_level` keeps its last manual value.
- Colour and duplex are the most likely causes of an unattended jam; the
  watchdog and the kiosk's "see a staff member" screen are the safety net.
- A job is only reported `completed` when CUPS itself reports the job
  completed. "The queue is empty now" is not proof of printing (a cancelled or
  aborted job also leaves the queue), and neither is `lp`'s
  `request id is Brother-NN`, which only means the file reached the spooler.
  A job that cannot be found is reported as a failure with the reason, never
  as a success.

## If a paid job prints nothing

The kiosk now refuses to call it printed, so `print_jobs.print_error` (admin ->
Printing -> failed jobs, or the `alerts` table) carries the reason. Read it
before touching anything:

```bash
lpstat -W all -o            # every job CUPS knows about
lpstat -p Brother -l        # queue enabled? stop reason? driver?
lpoptions -p Brother -l     # which options this queue accepts
sudo tail -80 /var/log/cups/error_log
sudo journalctl -u printkiosk-worker --since "-10 min" --no-pager
```

**`lpstat` cannot tell you whether a job printed.** On this Pi it prints

```
Brother-41  user  36864  Tue 27 Oct 2026 17:33:03 +08
```

with no state column, so a printed job, a job the printer refused and a job
someone cancelled are identical. That is why the worker asks the scheduler over
IPP (`Get-Job-Attributes`) and only falls back to lpstat. To answer "did job N
actually print" for a specific job:

```bash
ipptool -tv ipp://localhost:631/jobs/41 /usr/share/cups/ipptool/get-job-attributes.test \
  | grep -iE "job-state|STATUS"
```

`job-state (enum) = completed` / `job-completed-successfully` is the scheduler
saying the backend handed the whole document over. `aborted` with
`document-format-error` means the printer refused the file itself.

Common causes, in the order worth checking:

| Symptom | Cause |
|---|---|
| `never appeared in the CUPS queue` | cupsd refused the file (filter or page-range error). `error_log` says which filter. |
| `aborted` with `job-completed-with-errors` | the printer took the data and rejected it - usually an option it does not support. |
| state `completed` but nothing on the tray | the printer's own PDF/PCL interpreter failed; check its panel. |
| `document-format-error` | the queue is raw and the file is a format the printer cannot read directly. Install the queue with `lpadmin -m everywhere` (driverless) so CUPS converts. |

## If the printer stops reporting

The toner/status read is the only part of printing that needs the printer's
**address**; `lp` uses the queue name. So these two can disagree, and on
2026-10-27 they did: jobs printed fine while every poll logged

```
supplies unavailable (cannot reach ipp://10.100.131.48:631/ipp/print -
ipptool: Unable to connect to "10.100.131.48" on port 631 - Host is down)
```

That is a stale DHCP address, not a broken printer. Find the real one and
compare it with what CUPS thinks:

```bash
ippfind -T 5        # every live IPP printer, by mDNS serial name
lpstat -v           # what the queue is actually pointed at
getent hosts BRW145A41F176AD.local     # must resolve, or libnss-mdns is missing
```

Then re-point both at the same name (never a bare IP - see the note in Step 4):

```bash
sudo lpadmin -p Brother -E -v ipp://BRW145A41F176AD.local:631/ipp/print
nano ~/printkiosk/pi/print-worker.env     # PRINTER_URI= same URI
sudo systemctl restart printkiosk-worker
lp -d Brother /usr/share/cups/data/testprint    # the only real test
```

Two things that look like failures and are not:

- **A print request id proves nothing.** CUPS accepts the job and only fails
  later at the device, so `request id is Brother-39` appears even when nothing
  can print. Check `lpstat -o` and the paper tray.
- **"Printer status unavailable" on the kiosk does not block printing.** Toner
  is read over IPP, the job goes out over the queue; the panel is amber and
  keeps the concrete reason. A red `Offline` or a jam is the blocking state.