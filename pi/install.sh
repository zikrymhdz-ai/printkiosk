#!/usr/bin/env bash
#
# PrintKiosk print worker installer. Run this ON the Raspberry Pi:
#
#     bash install.sh
#
# It asks for the worker secret once (not echoed, not saved to shell history),
# installs dependencies, drops the systemd unit in place and does a single
# safe dry-run that must NOT print anything.
#
# Safe to re-run.

set -uo pipefail

APP_DIR="$HOME/printkiosk"
PI_DIR="$APP_DIR/pi"
ENV_FILE="$PI_DIR/print-worker.env"
QUEUE="Brother"

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32mOK\033[0m  %s\n' "$1"; }
warn() { printf '  \033[33m!!\033[0m  %s\n' "$1"; }
die()  { printf '  \033[31mXX\033[0m  %s\n' "$1"; exit 1; }

# ---------------------------------------------------------------- prerequisites
say "Checking prerequisites"
command -v lpadmin >/dev/null 2>&1 || die "CUPS client not found. Run: sudo apt install -y cups-client"
ok "CUPS client present"
command -v ipptool >/dev/null 2>&1 || warn "ipptool missing - real toner levels will not work (run: sudo apt install -y cups-ipp-utils)"
command -v lpstat >/dev/null 2>&1 && lpstat -p "$QUEUE" >/dev/null 2>&1 \
  && ok "CUPS queue '$QUEUE' exists" \
  || warn "CUPS queue '$QUEUE' not found - create it before printing (see PRINTING.md)"

[ -f "$PI_DIR/print-worker.py" ] || die "print-worker.py not found in $PI_DIR"

# ---------------------------------------------------------------- dependencies
say "Installing Python dependencies"
if sudo apt-get install -y -qq python3-pil python3-pypdf poppler-utils >/dev/null 2>&1; then
  ok "python3-pil, python3-pypdf, poppler-utils installed"
else
  warn "apt install failed - continuing; the worker will report missing modules at runtime"
fi

# ---------------------------------------------------------------- secret
say "Worker secret"
echo "  This must EXACTLY match PRINT_WORKER_SECRET in Netlify."
echo "  It is stored in $ENV_FILE (chmod 600) and never echoed."
echo
if [ -f "$ENV_FILE" ] && grep -q '^PRINT_WORKER_SECRET=pk_print_' "$ENV_FILE" 2>/dev/null; then
  ok "existing secret found in $ENV_FILE - keeping it"
  echo "     (delete that file first if you need to change the secret)"
else
  read -r -s -p "  Paste the secret (invisible, then Enter): " SECRET
  echo
  [ -n "$SECRET" ] || die "no secret entered"
  case "$SECRET" in
    pk_print_*) ok "secret looks correct (starts with pk_print_)" ;;
    *) warn "does not start with pk_print_ - double-check it matches Netlify" ;;
  esac
  umask 077
  cat > "$ENV_FILE" <<EOF
PRINT_WORKER_SECRET=$SECRET
PRINTKIOSK_API=https://printkioskfyp.netlify.app
PRINTER_NAME=$QUEUE
PRINTER_URI=ipp://Brother.local/ipp/print
EOF
  chmod 600 "$ENV_FILE"
  ok "written to $ENV_FILE"
fi

# ---------------------------------------------------------------- systemd
say "Installing systemd service"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$SCRIPT_DIR/printkiosk-worker.service" ] || die "printkiosk-worker.service not found next to this script"
sudo cp "$SCRIPT_DIR/printkiosk-worker.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable printkiosk-worker >/dev/null 2>&1
ok "unit installed and enabled"

# ---------------------------------------------------------------- dry run
say "Dry run (this MUST print nothing)"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
if python3 "$PI_DIR/print-worker.py" --once 2>&1 | sed 's/^/  /'; then
  ok "dry run finished"
else
  warn "dry run returned non-zero - check the output above"
fi

cat <<'DONE'

  ------------------------------------------------------------
  If the dry run printed anything OTHER than
    "no job waiting (nothing prints until a customer taps collect)"
  then STOP and do not start the service. Read PRINTING.md.

  Otherwise start it:
    sudo systemctl start printkiosk-worker

  Watch it:
    sudo journalctl -u printkiosk-worker -f
  ------------------------------------------------------------

DONE