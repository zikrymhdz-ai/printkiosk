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
sudo apt install -y cups-client poppler-utils python3-pil python3-pypdf

# the secret must match Netlify exactly
mkdir -p ~/printkiosk/pi
cat > ~/printkiosk/pi/print-worker.env <<'EOF'
PRINT_WORKER_SECRET=<paste-your-secret-here>
PRINTKIOSK_API=https://printkioskfyp.netlify.app
PRINTER_NAME=Brother
PRINTER_URI=ipp://Brother.local/ipp/print
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