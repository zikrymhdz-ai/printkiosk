#!/usr/bin/env bash
# PrintKiosk kiosk launcher for Raspberry Pi 4 (Raspberry Pi OS Desktop).
#
# Serves the project over localhost and opens Chromium in true kiosk mode.
# Serving from localhost matters: getUserMedia is a secure-context API and
# Chromium will refuse the USB webcam on a plain http:// LAN address.
#
# Because the kiosk runs from a LOCAL copy, deploying to Netlify does not update
# the screen by itself. Before launching we pull the current kiosk front-end from
# the live site, so an unattended screen never runs a stale walkin.html.
#
# Usage:  ./kiosk/pi-kiosk.sh
set -uo pipefail

APP_DIR="${PRINTKIOSK_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PORT="${PRINTKIOSK_PORT:-8080}"
URL="http://localhost:${PORT}/kiosk/walkin.html?pi=1"
CHROMIUM="${PRINTKIOSK_CHROMIUM:-}"
LIVE_BASE="${PRINTKIOSK_LIVE:-https://printkioskfyp.netlify.app}"
SCREEN="${PRINTKIOSK_SCREEN:-800,480}"

log() { printf '[printkiosk] %s\n' "$*"; }

# --- refresh the kiosk front-end from the deployed site ------------------------
# The kiosk now loads face-api / tfjs-wasm / qrcode / pdf from its OWN origin
# (vendor/) and models from models/, so those must be present locally. We only
# refresh the small HTML/config here; vendor+models are large binaries that are
# shipped once by scp (see kiosk/README-PI.md). If vendor/ is missing we warn.
sync_from_live() {
  command -v curl >/dev/null 2>&1 || { log "curl not found; using local files"; return 0; }
  local tmp
  local ok=0
  # kiosk/walkin.html is the page; frontend_config.js is read by every page.
  # assets/logo.svg is the header logo walkin.html references, so it has to
  # travel with them: a kiosk that syncs the HTML but not the image it points at
  # renders a broken image forever, and the fault looks like a missing asset
  # rather than a file the sync never knew to fetch.
  for f in kiosk/walkin.html kiosk/kiosk-serve.py kiosk/README-PI.md frontend_config.js assets/logo.svg; do
    tmp="${APP_DIR}/$(basename "$f").new.$$"
    if curl -fsS --max-time 20 "${LIVE_BASE}/${f}" -o "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
      if ! cmp -s "$tmp" "${APP_DIR}/${f}" 2>/dev/null; then
        # Write atomically: the kiosk serves this file over HTTP, and a partially
        # written walkin.html would be fetched by a reload and fail to parse.
        # The parent directory has to exist first, since these paths are nested
        # and a fresh install has no assets/ directory.
        mkdir -p "$(dirname "${APP_DIR}/${f}")" 2>/dev/null
        if mv -f "$tmp" "${APP_DIR}/${f}" 2>/dev/null; then
          log "updated ${f} from live site"
          # Only for the kiosk page: a truncated copy that still parses is worse
          # than the stale one, because the kiosk will happily run it. Other
          # synced files have no version marker to check for.
          case "$f" in
            kiosk/walkin.html)
              if ! grep -q "KIOSK_APP_VERSION" "${APP_DIR}/${f}" 2>/dev/null; then
                log "WARNING: fetched ${f} looks incomplete"
              fi
              ;;
          esac
        else
          rm -f "$tmp"
        fi
      else
        rm -f "$tmp"
      fi
      ok=1
    else
      rm -f "$tmp"
    fi
  done
  [ "$ok" = 1 ] || log "live sync unavailable; using local copy"
}

# Keep the served HTML fresh. The kiosk reloads itself on an idle timer, and a
# reload re-fetches from localhost, so without this the screen would keep
# running whatever was on disk at boot and miss every later fix.
start_sync_loop() {
  while true; do
    sleep 120
    sync_from_live
  done
}

check_local_assets() {
  if [ ! -f "${APP_DIR}/vendor/face-api.min.js" ]; then
    log "WARNING: vendor/face-api.min.js missing - face AI will fall back to CDN (needs internet)"
  fi
  if [ ! -f "${APP_DIR}/vendor/qrcode.min.js" ]; then
    log "WARNING: vendor/qrcode.min.js missing - guest QR will not render"
  fi
  if [ ! -f "${APP_DIR}/models/ssd_mobilenetv1_model.bin" ]; then
    log "WARNING: models/ssd_mobilenetv1_model.bin missing - face AI will not load offline"
  fi
}

log "syncing kiosk files from ${LIVE_BASE}"
sync_from_live
check_local_assets
start_sync_loop &

# --- locate Chromium ---------------------------------------------------------
if [ -z "$CHROMIUM" ]; then
  for c in chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1; then CHROMIUM="$(command -v "$c")"; break; fi
  done
fi
if [ -z "$CHROMIUM" ]; then
  log "ERROR: chromium not found. Install with: sudo apt install chromium"
  exit 1
fi
log "chromium: $CHROMIUM"

# --- static server ------------------------------------------------------------
# python3 http.server is enough; no PHP or Node needed on the Pi.
if ! command -v python3 >/dev/null 2>&1; then
  log "ERROR: python3 not found. Install with: sudo apt install python3"
  exit 1
fi

if curl -fsS "http://localhost:${PORT}/frontend_config.js" >/dev/null 2>&1; then
  log "reusing server already on port ${PORT}"
else
  # kiosk-serve.py, not `python3 -m http.server`. The stdlib server sends no
  # Cache-Control header, so Chromium heuristically cached walkin.html and the
  # screen could keep running a stale copy from disk after a deploy -- which
  # showed up as a page calling helpers that did not exist in that copy.
  SERVE_SCRIPT="${APP_DIR}/kiosk/kiosk-serve.py"
  if [ -f "$SERVE_SCRIPT" ] && command -v python3 >/dev/null 2>&1; then
    log "starting no-cache static server on port ${PORT}"
    ( cd "$APP_DIR" && nohup python3 "$SERVE_SCRIPT" "$APP_DIR" "$PORT" \
        >/tmp/printkiosk-http.log 2>&1 & )
  else
    log "kiosk-serve.py missing; falling back to python3 -m http.server (may cache)"
    ( cd "$APP_DIR" && nohup python3 -m http.server "$PORT" --bind 127.0.0.1 \
        >/tmp/printkiosk-http.log 2>&1 & )
  fi
  sleep 1
  curl -fsS "http://localhost:${PORT}/frontend_config.js" >/dev/null 2>&1 \
    || log "WARNING: server did not come up; see /tmp/printkiosk-http.log"
fi

# --- stop the desktop session taking input ------------------------------------
# Keeps the Pi from painting its own desktop or panel over the kiosk.
if command -v xdg-screensaver >/dev/null 2>&1; then xdg-screensaver suspend >/dev/null 2>&1 || true; fi

# --- clear any stored camera permission decision ------------------------------
# Chromium persists the per-origin camera choice in the profile. If an earlier
# attempt was ever denied (or the prompt could not be answered in kiosk mode),
# getUserMedia keeps failing forever after. A fresh profile each launch means the
# --use-fake-ui-for-media-stream flag always decides.
PROFILE_DIR="${PRINTKIOSK_PROFILE:-/tmp/printkiosk-chrome}"
rm -rf "$PROFILE_DIR" 2>/dev/null || true

log "launching kiosk -> $URL"
exec "$CHROMIUM" \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=TranslateUI,Translate,CalculateNativeWinOcclusion \
  --overscroll-history-navigation=0 \
  --touch-events=enabled \
  --autoplay-policy=no-user-gesture-required \
  --use-fake-ui-for-media-stream \
  --allow-file-access-from-files \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --disable-background-timer-throttling \
  --disable-renderer-backgrounding \
  --disable-backgrounding-occluded-windows \
  --force-device-scale-factor=1 \
  --enable-logging=stderr \
  --v=0 \
  --disable-application-cache \
  --disk-cache-size=1 \
  --media-cache-size=1 \
  --window-position=0,0 \
  --window-size="$SCREEN" \
  --user-data-dir="$PROFILE_DIR" \
  "$URL"

# NOTE ON THE FLAGS BELOW (added because getUserMedia and enumerateDevices both
# *hung* instead of erroring on this Pi):
#   --disable-background-timer-throttling / --disable-renderer-backgrounding /
#   --disable-backgrounding-occluded-windows
#                           Chromium treats a kiosk window that is not focused
#                           as occluded and throttles its timers to ~1/min. That
#                           starved the heartbeat, the admin settings poll and the
#                           face detection loop, so the screen appeared to stutter
#                           and flicker. These keep the render loop running.
#   --force-device-scale-factor=1
#                           stops Chromium guessing the panel DPI, which made the
#                           canvas repaint at a different size than the CSS layout
#                           and produced visible shimmer on camera frames.
#   --no-sandbox            the setuid sandbox is unreliable on Raspberry Pi OS and
#                           a sandboxed renderer cannot reach /dev/video0, so the
#                           video capture service stalls instead of failing fast.
#   --disable-dev-shm-usage /dev/shm is only 64MB on a Pi by default; Chromium
#                           runs out of shared memory and hangs while opening media.
#   --disable-gpu           there is no usable GPU on a Pi 4 and the GPU process can
#                           stall the compositor that owns the camera preview.