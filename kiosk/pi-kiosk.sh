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
URL="http://localhost:${PORT}/kiosk/walkin.html"
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
  tmp="$(mktemp)"
  local ok=0
  for f in kiosk/walkin.html kiosk/README-PI.md frontend_config.js; do
    if curl -fsS --max-time 20 "${LIVE_BASE}/${f}" -o "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
      if ! cmp -s "$tmp" "${APP_DIR}/${f}" 2>/dev/null; then
        if cp "$tmp" "${APP_DIR}/${f}" 2>/dev/null; then
          log "updated ${f} from live site"
        fi
      fi
      ok=1
    fi
  done
  rm -f "$tmp"
  [ "$ok" = 1 ] || log "live sync unavailable; using local copy"
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
  log "starting static server on port ${PORT}"
  ( cd "$APP_DIR" && nohup python3 -m http.server "$PORT" --bind 127.0.0.1 \
      >/tmp/printkiosk-http.log 2>&1 & )
  sleep 1
  curl -fsS "http://localhost:${PORT}/frontend_config.js" >/dev/null 2>&1 \
    || log "WARNING: server did not come up; see /tmp/printkiosk-http.log"
fi

# --- stop the desktop session taking input ------------------------------------
# Keeps the Pi from painting its own desktop or panel over the kiosk.
if command -v xdg-screensaver >/dev/null 2>&1; then xdg-screensaver suspend >/dev/null 2>&1 || true; fi

log "launching kiosk -> $URL"
exec "$CHROMIUM" \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=TranslateUI,Translate \
  --overscroll-history-navigation=0 \
  --touch-events=enabled \
  --autoplay-policy=no-user-gesture-required \
  --use-fake-ui-for-media-stream \
  --allow-file-access-from-files \
  --enable-logging=stderr \
  --v=0 \
  --disable-application-cache \
  --disk-cache-size=1 \
  --media-cache-size=1 \
  --window-position=0,0 \
  --window-size="$SCREEN" \
  --user-data-dir=/tmp/printkiosk-chrome \
  "$URL"