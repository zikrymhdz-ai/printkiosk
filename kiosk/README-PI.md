# PrintKiosk on Raspberry Pi 4

Setup for running the kiosk on a Pi 4 with a USB webcam, Raspberry Pi OS Desktop.

## What changed for the Pi

| Area | Change |
|---|---|
| Backend | `frontend_config.js` accepts `window.PRINTKIOSK_API_BASE`, so the kiosk on `localhost` calls the live Netlify functions instead of `*.php` (which don't exist on a Pi). |
| QR code | Uses `QR_SITE_BASE`, so a Pi-served kiosk still prints the public `printkioskfyp.netlify.app` URL rather than its own `localhost`. |
| TF backend | Forces single-threaded non-SIMD **WASM**. Chromium on a Pi 4 has no usable WebGL and ARM has no WASM SIMD, so the GPU paths either fail or run slower than CPU. |
| Models | Loads `../models` from the Pi first (no CDN round-trip), falling back to the CDN. |
| Camera | Requests 480p, and detection downscales to 320px with a 250 ms interval. Full-rate detection saturates all four A53 cores. |
| Touch UI | Larger tap targets (min 56px), no text selection, no long-press callout, no overscroll bounce. |
| Layout | Single-screen layout tuned for 800x480 panels. |
| Reliability | Screen wake lock, periodic idle reload to clear WASM memory growth, gesture blocking, and a tap-to-toggle diagnostics overlay. |

## Install

```bash
sudo apt update
sudo apt install -y chromium python3 curl
```

Copy the project to the Pi, e.g. `/home/pi/printkiosk`:

```bash
scp -r printkiosk pi@<pi-ip>:/home/pi/
```

## Run manually

```bash
chmod +x ~/printkiosk/kiosk/pi-kiosk.sh
~/printkiosk/kiosk/pi-kiosk.sh
```

## Run at boot

```bash
sudo cp ~/printkiosk/kiosk/printkiosk-kiosk.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now printkiosk-kiosk
```

Edit `User=pi` and `PRINTKIOSK_DIR` in the service if your username or path differ.

## Disable screen blanking

```bash
sudo apt install -y x11-xserver-utils
sudo xset s off -dpms s off
```

## Camera permissions

The launcher passes `--use-fake-ui-for-media-stream`, which auto-grants webcam access.
The kiosk must be served over **localhost** - Chromium treats a plain `http://` LAN
address as an insecure context and will block `getUserMedia`.

## Diagnostics

Face AI failures are invisible on a touch display without a keyboard, so the kiosk logs
state into an on-screen overlay:

- Tap the camera box **5 times** to toggle it, or launch with `?diag=1`.
- Shows the TF backend, model source, registered face count, camera resolution and
  any backend/camera errors.

If face login does not work, check the overlay first - it distinguishes
`models FAILED`, `camera FAILED` and `Face AI offline`.

## Tuning

Override via environment variables:

```bash
PRINTKIOSK_PORT=8080 PRINTKIOSK_CHROMIUM=/usr/bin/chromium ~/printkiosk/kiosk/pi-kiosk.sh
```

If detection is too slow or too aggressive, edit the `window.FACE_MIN_INTERVAL_MS` and
`window.FACE_DETECT_WIDTH` values in the Pi bootstrap block at the top of
`kiosk/walkin.html`.

Pi mode auto-detects both 32-bit (`armv7l`/`armhf`) and 64-bit (`aarch64`)
Raspberry Pi OS builds. Query-string overrides:

- `?pi=1` forces Pi mode on any device, which is handy for testing the throttled
  detection path on a laptop.
- `?pi=0` forces it off.
- `?diag=1` shows the diagnostics overlay on launch.

## Notes

- The kiosk still needs internet for the Netlify backend; the camera and PIN flows
  fall back to `Camera access denied` / `Connection error` when offline. Face models
  are vendored locally, so recognition itself keeps working.
- `audio: false` is now requested explicitly; some USB webcams fail to open when an
  audio device is expected but absent.
- To force Pi mode from code (no query string), set `window.IS_RPI = true` and
  `window.PRINTKIOSK_API_BASE = 'https://printkioskfyp.netlify.app'` before
  `frontend_config.js` loads.