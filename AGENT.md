# AGENT.md - PrintKiosk

## 1. What it is
Self-service print kiosk. Customer uploads from their phone (or kiosk QR), pays **DuitNow**, collects a print. A Raspberry Pi kiosk offers **face login** or **6-digit PIN** to release a paid job to a **Brother HL-L3240CDW**. Live: `https://printkioskfyp.netlify.app`

**The whole system exists to solve one problem:** DuitNow QR payments carry no order reference - only an *amount*. So every order must get a **unique amount**, or one customer's money releases another customer's document.

## 2. Stack
Plain HTML/CSS/JS (**no framework, no build step**) | **Netlify Functions** (Node, CommonJS) | **Supabase** Postgres/Storage/Auth | **Python** worker on the Pi (CUPS, `lp`, `ipptool`, Pillow) | `face-api.js` + TF.js for faces | `pdf-lib` 1.17.1 for merging.
One npm dep: `bcryptjs`. PHP (`*.php`) is **dead code** - no live page references it.

## 3. Structure
| Path | Purpose |
|---|---|
| `website/customer.html` | Signed-in multi-file upload (main flow) |
| `website/upload.html` | Guest upload - locked to exactly 1 file |
| `website/pagerange.js` | Client PDF toolkit: page select, merge-to-one-job, image adjust |
| `kiosk/walkin.html` | Kiosk: face login, PIN, payment, print, cancel |
| `admin/admin.html` | Staff dashboard: jobs, alerts, printer, review queue |
| `netlify/functions/_shared.js` | **Pricing, match-fee allocation, Supabase helpers, version** |
| `netlify/functions/upload.js` | Upload URLs, job rows, `seal-order` (prices a whole order) |
| `netlify/functions/payment.js` | **Payment matching** - groups jobs by order, settles one amount |
| `netlify/functions/printer.js` | Worker API: claim-job, report-print, supplies, watchdog |
| `pi/print-worker.py` | Pi worker: claims jobs, converts images, applies adjustments, `lp` |
| `migrations/`, `models/`, `vendor/` | SQL migrations; face-api weights; vendored JS/wasm |
| `scripts/check-*`, `version.js`, `_headers`, `PRINTING.md` | Test suite; version source of truth; cache rules; **printing runbook - read before touching `pi/`** |

## 4. Commands
```bash
npm install                 # only bcryptjs
netlify dev                 # run locally (Pi kiosk: python3 kiosk/kiosk-serve.py)
npm test                    # FULL SUITE - run before every commit
node scripts/check-merge-files.js    # one check
# version bump: edit version.js, then npm run version:sync (never hand-edit its copies)
netlify deploy --prod --message "v100: what changed"
```
Pi: `scp pi/print-worker.py pi/install.sh <user>@<pi-ip>:~/printkiosk/pi/` then `ssh <user>@<pi-ip> 'sudo systemctl restart printkiosk-worker'`.
Migrations: run the numbered SQL in Supabase's editor, in order.

## 5. Status - v104
Works: multi-file merge (PDFs together, photos separate, per-file settings); mixed colour in one job (B&W baked to greyscale, priced **per page** - 1 colour + 1 B&W = RM1.30 not RM2.20); unique payment amounts reserved for the full 60-min match window; kiosk face/PIN/cancel/paid-only/smooth scrolling; brightness+contrast applied at print time.

v104 stopped a job retrying for ever. `reportPrint` computed the attempt number from `body.attempts` and never wrote it back, so the next claim re-read `print_attempts = 0`, every report computed `used = 1`, and the `used < 3` cap could never be reached. Seen live: 15 attempts in 90 s, `print_attempts` still 0, status flipping `printing` <-> `print_requested`. The count is now persisted, a **4xx on the stored file is permanent** (not retried - the file is gone and every retry downloads the same 400), and the `print_failed` alert fires only when the job is actually parked, instead of once per retry.

**Data loss worth knowing:** `reportPrint` deletes the stored file on `completed`. Every job the old worker falsely "completed" therefore had its file destroyed and cannot be reprinted - verified 2026-10-27: all `completed` jobs return HTTP 400 for `file_path`, while unpaid `pending` ones return 200. A false success is not just a wrong label; it costs the customer their upload.

v103 fixed the worker's verification:
- `cups_job_state()` ran `lpstat -W all -o <job_id>`. `lpstat -o` takes **destination** names, so the job id was read as a printer called `Brother-40`; the list came back empty on every poll, forever. It now matches the id **exactly** - the old `if job_id not in line` also matched `Brother-1` inside `Brother-12`.
- `wait_for_outcome()` treated "not in the queue" as "printed". That is how every job passed in ~16 s: 15 s grace window, healthy printer, success. Absence of evidence is now a **failure** with the reason.
- This Pi's `lpstat -W all -o` prints **no state column at all** (`Brother-41  user  36864  Tue 27 Oct 2026 17:33:03 +08`), so a printed, refused and cancelled job are identical. Verification therefore asks the scheduler over IPP (`Get-Job-Attributes`); note ipptool prints `job-state (enum) = completed`, the NAME not the number. lpstat is only the fallback.
- Colour was sent as `ColorModel=Gray|RGB`, a Brother **PPD** option. `printer_option_names()` now reads `lpoptions -p X -l` and uses whichever spelling the queue has; the shop's queue is a PPD queue, a driverless one takes `print-color-mode`.
- Every colour run of a merged job is verified, not just the first.

v100 fixed four things a live failure exposed on 2026-10-27:
- `website/customer.html` had a stray `}` after `renderOrderCard()`, so the **whole 2,445-line inline block failed to parse** and every customer-page function was dead in the browser. `check-syntax.js` caught it the moment the suite was run.
- The worker reported `"reachable, but no toner attributes ... Got: ipptool: Unable to connect ... Host is down"` - a self-contradicting reason. Transport detection now lives in one list (`TRANSPORT_FAILURES` / `_transport_failure`) that knows ipptool's real wording, and a non-zero exit can never leave its transcript where the attribute parser will read it as a reply.
- Admin took the newest row of ANY `kiosk_id`, so the 20 s diagnostic probe (`kiosk-error`) stole the top slot from the real `kiosk-1` report about half the time and admin said "the screen has not sent a status update" while it was reporting fine. `getKioskStatus()` now asks for `kiosk-1` by name and returns the probe separately as `probe_only`/`probe`.
- The kiosk printed a red "Cannot reach printer" whenever the IPP toner read failed, even though printing goes out through the CUPS queue and worked. It now says "Printer status unavailable" in amber and keeps the reason.

**Open:** no automated coverage for browser canvas steps (image adjust, greyscale bake). Whether the CUPS queue on the Pi is driverless (`lpadmin -m everywhere`) or raw decides whether a PDF is converted or handed to the printer as-is - `lpstat -p Brother -l | grep Interface` and `lpoptions -p Brother -l` answer it. If it is raw and PDFs do not print, recreate it with `-m everywhere`.

Lessons not to undo: pdf-lib 1.17 made `create()`/`copyPages()` **async**; image `width`/`height` are **pixels** but `addPage` takes **points** (55-inch pages stall the printer); identify files by **bytes, not extension**; reserved amounts must cover the matcher's window (`_shared.js` owns `assignUniqueOrderTotal`/`pickFreeOffset`, mirrored by an `orderAmountOf` rule in `payment.js` **and** `walkin.html` - all three must agree).

Mixed colour in one photo job works by **baking, not by print options**: `combineGroups` (`pagerange.js:509`) keys photos WITHOUT colour so they group, `combineImages` (`:457`) bakes greyscale into the B&W photo's pixels via `adjustImageFile`, and the worker then sends **one `ColorModel` for the whole document** (`print-worker.py:354`). Verified 2026-10-16 on the Pi: `ColorModel=RGB` does print colour on the HL-L3240CDW, and two images (1 B&W + 1 colour) come out 1 grey + 1 colour. Do not "simplify" this by trusting the driver's colour handling per page - there is no per-page colour, only baked pixels.

## 6. Rules
1. Run `npm test` before every commit. 2. Never trust a browser-computed price - the server prices. 3. Never let two matchable orders share an amount. 4. Write a test that **fails first** for every bug. 5. One home per rule - shared logic lives in `_shared.js`. 6. Bump `version.js` + `npm run version:sync` before deploying. 7. Keep HTML **pure ASCII** (`&mdash;`) - PowerShell edits have corrupted UTF-8 twice. 8. `request-print` is called in **exactly one place**: `closeReceipt()`. 9. Comment the *why* and the failure behind it, not the *what*.

## 7. Do not touch
**Credentials**: `_shared.js` reads `SUPABASE_URL`, `SUPABASE_KEY`, `NOTIFICATION_SECRET`, `PRINT_WORKER_SECRET`, `SMTP_*` from the environment **with a committed fallback**, so the site runs with nothing configured and needs no Netlify env. Four live values - the Supabase service key, `NOTIFICATION_SECRET`, the sender and the Gmail app password - **are** in the repo, and the owner has accepted that for a small non-commercial app. Keep the fallbacks; do not strip them without asking. `check-no-committed-secrets.js` does **not** fail on those four; it fails only when a **new** credential-shaped value appears. Never log or echo PINs, tokens or the notification secret.

**Files:** `config.php` (legacy DB creds) | `Notification` (watcher token) | `models/*.bin` + manifests | `vendor/**` | `package-lock.json` | `uploads/` runtime dir.
`frontend_config.js` is public config - read freely, never add secrets. Never commit customer documents, face photos, payment refs, or log PINs/tokens. Note the `print-jobs` storage bucket is **public**: a stored file is readable by URL, and the worker deletes it on completion, so a failed print leaves nothing to inspect afterwards.
