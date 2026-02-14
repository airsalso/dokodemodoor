#!/usr/bin/env bash
# Status for dokodemodoor (web), re-scanner, osv-scanner.
# Usage:
#   ./status.sh                    → menu: 1) dokodemodoor  2) re  3) osv
#   ./status.sh 1|dokodemodoor [session_id]
#   ./status.sh 2|re [session_id]
#   ./status.sh 3|osv [session_id]

run_dokodemodoor() {
  if [ -n "$1" ]; then
    npx zx ./dokodemodoor.mjs --status --session "$1"
  else
    npx zx ./dokodemodoor.mjs --status
  fi
}

run_re() {
  if [ -n "$1" ]; then
    node ./re-scanner.mjs --status "$1"
  else
    node ./re-scanner.mjs --status
  fi
}

run_osv() {
  if [ -n "$1" ]; then
    node ./osv-scanner.mjs --status "$1"
  else
    node ./osv-scanner.mjs --status
  fi
}

run_by_choice() {
  local choice="$1"
  local session_id="$2"
  case "$choice" in
    1|dokodemodoor|web) run_dokodemodoor "$session_id" ;;
    2|re)               run_re "$session_id" ;;
    3|osv)               run_osv "$session_id" ;;
    *)
      echo "Unknown option: $choice. Use 1|dokodemodoor, 2|re, 3|osv."
      exit 1
      ;;
  esac
}

if [ -n "$1" ]; then
  run_by_choice "$1" "$2"
  exit 0
fi

echo ""
echo "  1) dokodemodoor (web pentest)"
echo "  2) re-scanner (RE)"
echo "  3) osv-scanner (OSV)"
echo ""
read -r -p "Select (1-3): " num
run_by_choice "$num" ""
