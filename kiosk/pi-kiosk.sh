#!/usr/bin/env bash
# PrintKiosk kiosk launcher for Raspberry Pi 4 (Raspberry Pi OS Desktop).
#
# Serves the project over localhost and opens Chromium in true kiosk mode.
# Serving from localhost matters: getUserMedia is a secure-context API and
# Chromium will refuse the USB webcam on a plain http:// LAN address.
#
# Usage:  ./kiosk/pi-kiosk.sh
set -uo pipefail

APP_DIR="${PRINTKIOSK_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PORT="${PRINTKIOSK_PORT:-8080}"
URL="http://localhost:${PORT}/kiosk/walkin.html"
CHROMIUM="${PRINTKIOSK_CHROMIUM:-}"

log() { printf '[printkiosk] %s\n' "$*"; }

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
  --window-position=0,0 \
  --window-size=1280,800 \
  --user-data-dir=/tmp/printkiosk-chrome \
  "$URL"