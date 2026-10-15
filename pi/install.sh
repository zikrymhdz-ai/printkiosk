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
# The worker must point at this specific model. Several printers on this
# network advertise IPP (a Brother DCP-T430W and an HP LaserJet have both
# turned up), and printing a customer's job to the wrong machine is worse
# than printing nothing at all.
EXPECTED_MODEL="${EXPECTED_MODEL:-HL-L3240CDW}"

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32mOK\033[0m  %s\n' "$1"; }
warn() { printf '  \033[33m!!\033[0m  %s\n' "$1"; }
die()  { printf '  \033[31mXX\033[0m  %s\n' "$1"; exit 1; }

# ---------------------------------------------------------------------------
# Printer discovery
#
# Tries every IPP device the network advertises (including mDNS names) and
# returns the first one that actually answers a Get-Printer-Attributes. A
# reachable-looking entry is not enough: a stale dnssd URI resolves and then
# fails to connect, which is exactly the failure this replaces.
# ---------------------------------------------------------------------------
ipp_answers() {
  command -v ipptool >/dev/null 2>&1 || return 1
  ipptool -tv "$1" /usr/share/cups/ipptool/get-printer-attributes.test >/dev/null 2>&1
}

# Ask a printer what it calls itself. Used to make sure we are not pointing the
# worker at the wrong physical machine.
printer_name() {
  command -v ipptool >/dev/null 2>&1 || return 1
  # ipptool emits e.g. "[0] printer-name (name) = Brother HL-L3240CDW series".
  # Both ends need trimming: the value is left-padded after the '=' is consumed,
  # and without stripping it every model comparison below fails on a stray space.
  ipptool -tv "$1" /usr/share/cups/ipptool/get-printer-attributes.test 2>/dev/null |
    grep -i 'printer-name' | head -1 |
    sed 's/^[[:space:]]*//; s/.*printer-name[^=]*=[[:space:]]*//; s/[[:space:]]*(\(integer\|text\|name\)).*//; s/[[:space:]]*$//'
}

# Lists what is actually on the network, with the model each device reports.
show_printers() {
  local c name
  echo "  IPP devices visible:"
  while read -r c; do
    [ -n "$c" ] || continue
    name="$(printer_name "$c")"
    printf '    %-58s %s\n' "$c" "${name:-<no reply>}"
  done <<EOF
$(lpinfo -v 2>/dev/null | awk '/^network/{print $2}')
EOF
}

# Returns the URI to use. Prefers a device whose reported model matches
# EXPECTED_MODEL. Refuses to guess if several match, because printing a
# customer's document to the wrong machine is worse than printing nothing.
discover_printer_uri() {
  local candidates c name match=""

  # 1. A matching device advertised over mDNS, preferred. It survives the
  #    printer being given a different IP, which a bare ipp://address cannot.
  candidates="$(lpinfo -v 2>/dev/null | awk '/^network/{print $2}')"
  for c in $candidates; do
    case "$c" in
      dnssd://*|ipps://*) ;;
      *) continue ;;
    esac
    ipp_answers "$c" || continue
    name="$(printer_name "$c")"
    if [ -z "$EXPECTED_MODEL" ] || printf '%s' "$name" | grep -qi "$EXPECTED_MODEL"; then
      if [ -n "$match" ]; then
        warn "two printers match '$EXPECTED_MODEL'; not guessing. Refusing to choose."
        return 1
      fi
      match="$c"
    fi
  done
  [ -n "$match" ] && { echo "$match"; return 0; }

  # 2. Otherwise fall back to whatever the CUPS queue already uses, which is
  #    the URI printing is proven to work over.
  if command -v lpstat >/dev/null 2>&1 && [ -n "$QUEUE" ]; then
    local q
    q="$(lpstat -v "$QUEUE" 2>/dev/null | head -1 | awk '{print $3}')"
    if [ -n "$q" ] && ipp_answers "$q"; then
      name="$(printer_name "$q")"
      if [ -z "$EXPECTED_MODEL" ] || printf '%s' "$name" | grep -qi "$EXPECTED_MODEL"; then
        echo "$q"; return 0
      fi
    fi
  fi

  # 3. Any other advertised device matching the model.
  for c in $candidates; do
    ipp_answers "$c" || continue
    name="$(printer_name "$c")"
    if [ -z "$EXPECTED_MODEL" ] || printf '%s' "$name" | grep -qi "$EXPECTED_MODEL"; then
      if [ -n "$match" ]; then
        warn "two printers match '$EXPECTED_MODEL'; not guessing. Refusing to choose."
        return 1
      fi
      match="$c"
    fi
  done
  [ -n "$match" ] && { echo "$match"; return 0; }
  return 1
}

# ---------------------------------------------------------------- prerequisites
say "Checking prerequisites"
command -v lpadmin >/dev/null 2>&1 || die "CUPS client not found. Run: sudo apt install -y cups-client"
ok "CUPS client present"
command -v ipptool >/dev/null 2>&1 || warn "ipptool missing - real toner levels will not work (run: sudo apt install -y cups-ipp-utils)"
command -v lpstat >/dev/null 2>&1 && lpstat -p "$QUEUE" >/dev/null 2>&1 \
  && ok "CUPS queue '$QUEUE' exists" \
  || warn "CUPS queue '$QUEUE' not found - create it before printing (see PRINTING.md)"

[ -f "$PI_DIR/print-worker.py" ] || die "print-worker.py not found in $PI_DIR"

# Fail early and clearly if the printer is not on the network. Installing
# against a printer that has dropped off WiFi produces a worker that claims
# everything works and then silently accepts no jobs.
say "Checking the printer is reachable"
show_printers
Q_URI="$(lpstat -v "$QUEUE" 2>/dev/null | head -1 | awk '{print $3}')"
if [ -n "$Q_URI" ] && ipp_answers "$Q_URI"; then
  ok "printer answers at $Q_URI"
else
  # Brother.local is not this printer's hostname -- that name never resolves,
  # which is why a poll against it failed with "Name or service not known"
  # even though the printer was on the network the whole time. Prefer the mDNS
  # dnssd:// URI instead: it does not need to know the hostname or the IP.
  DISCOVERED="$(discover_printer_uri)"
  if [ -n "$DISCOVERED" ]; then
    ok "printer answers at $DISCOVERED"
    # The queue itself is also pointed at the dead address, so printing would
    # fail even once supply polling works. Repoint it.
    if [ "$DISCOVERED" != "$Q_URI" ]; then
      say "Repointing the CUPS queue"
      if sudo lpadmin -p "$QUEUE" -E -v "$DISCOVERED" -m everywhere 2>/dev/null; then
        ok "queue '$QUEUE' now uses $DISCOVERED"
      else
        warn "could not repoint the queue - run this manually:"
        printf '     sudo lpadmin -p %s -E -v "%s" -m everywhere\n' "$QUEUE" "$DISCOVERED"
      fi
    fi
  else
    warn "NO '$EXPECTED_MODEL' RESPONDING over IPP."
    warn "  devices seen above; if yours is not listed it is off WiFi."
  fi
fi

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
  # Do NOT hardcode a printer address here. A fixed IP in this file was wrong
  # twice: first an mDNS name while the CUPS queue used an address, then a
  # static address that the printer later abandoned. Instead, discover it at
  # install time and record whichever URI actually answers right now.
PRINTER_URI_FOUND="$(discover_printer_uri)"
  if [ -z "$PRINTER_URI_FOUND" ]; then
    die "No IPP printer found on this network.
  Power the printer on and confirm it is joined to WiFi, then re-run.
  To see candidates yourself:  lpinfo -v | grep -i ipp"
  fi

  # IPP credentials, only if this printer asks for them.
  #
  # A printer that requires authentication answers an unauthenticated request
  # with an error status, and ipptool surfaces only the mandatory printer-name
  # from it - no model, no toner levels. That presents as a serial number and a
  # "wrong printer" rather than as the missing password it actually is.
  #
  # Leaving these blank is harmless for a printer that does not use them, so this
  # asks once and writes empty values rather than forcing an answer.
  echo
  say "Printer password"
  echo "  Only needed if this printer asks for a username and password over IPP."
  echo "  Press Enter to skip (most printers on a shop network do not)."
  echo
  read -r -p "  IPP username (blank = none): " PRINTER_USER
  PRINTER_PASSWORD=""
  if [ -n "$PRINTER_USER" ]; then
    read -r -s -p "  IPP password (invisible, then Enter): " PRINTER_PASSWORD
    echo
    [ -n "$PRINTER_PASSWORD" ] || die "a username was given with no password"
  fi

  umask 077
  cat > "$ENV_FILE" <<EOF
PRINT_WORKER_SECRET=$SECRET
PRINTKIOSK_API=https://printkioskfyp.netlify.app
PRINTER_NAME=$QUEUE
PRINTER_URI=$PRINTER_URI_FOUND
PRINTER_USER=$PRINTER_USER
PRINTER_PASSWORD=$PRINTER_PASSWORD
EOF
  chmod 600 "$ENV_FILE"
  ok "written to $ENV_FILE"
  if [ -n "$PRINTER_USER" ]; then
    ok "printer credentials saved (not echoed, file is chmod 600)"
  fi
fi

# Say out loud what the worker will actually poll, and prove it is reachable.
echo
echo "  Worker will poll: $(grep '^PRINTER_URI=' "$ENV_FILE" 2>/dev/null || echo '(not set)')"
if command -v ipptool >/dev/null 2>&1; then
  U=$(grep '^PRINTER_URI=' "$ENV_FILE" | cut -d= -f2-)
  if ipptool -tv "$U" /usr/share/cups/ipptool/get-printer-attributes.test >/dev/null 2>&1; then
    ok "printer reachable over IPP at $U - toner levels will be real"
  else
    warn "could not reach $U over IPP. Toner levels will show 'unknown'."
    warn "try:  sudo apt install cups-ipp-utils"
  fi
else
  warn "ipptool not installed -> toner levels will show 'unknown'."
  warn "install it:  sudo apt install cups-ipp-utils"
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