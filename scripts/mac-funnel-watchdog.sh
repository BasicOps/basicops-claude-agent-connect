#!/usr/bin/env bash
#
# macOS watchdog for an agent's Tailscale Funnel. The Mac's Funnel can break on
# the PUBLIC path (relays accept TCP, TLS gets EOF) — often after sleep — while
# tailnet-only tests still pass, so the agent silently stops receiving webhooks.
# This probes the public relays directly; if they fail twice, it resets this
# agent's path and restarts it (the agent re-adds the path on startup).
#
# Resetting just the path doesn't always clear the TLS failure, so if the next
# check still fails it resets the whole (shared) funnel and restarts every agent
# on it, which kills their in-flight turns. Several watchdogs (one per agent)
# coordinate through a lock and a shared state file, and back off after a reset
# that didn't help (5, 10, 20, 40, then 60 min) instead of restarting every run.
#
# Usage: mac-funnel-watchdog.sh <agent-slug>      (run by launchd every 5 min)
#
set -uo pipefail

SLUG="${1:?usage: $0 <agent-slug>}"
TS=/Applications/Tailscale.app/Contents/MacOS/tailscale
command -v tailscale >/dev/null 2>&1 && TS="$(command -v tailscale)"
LABEL="com.basicops.agent.$SLUG"
FPATH="/$SLUG"
STATE="$HOME/.config/basicops-agent/funnel-watchdog.state" # "<resets> <next allowed reset epoch>"
LOCK="${TMPDIR:-/tmp}/basicops-funnel-watchdog.lock"
log() { echo "$(date '+%F %T') $*"; }

# Agent not running → nothing to watch (launchd restarts it on its own).
launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -q "state = running" || exit 0

# Tailscale off or logged out → restarting agents can't help; wait for it to come back.
TSJSON="$("$TS" status --json 2>/dev/null)"
read -r BACKEND HOST < <(printf '%s' "$TSJSON" | /usr/bin/python3 -c \
  'import json,sys; d=json.load(sys.stdin); print(d.get("BackendState",""), (d.get("Self") or {}).get("DNSName","").rstrip("."))' 2>/dev/null)
[ "${BACKEND:-}" = "Running" ] && [ -n "${HOST:-}" ] || exit 0

# Healthy if ANY public relay reaches the listener. A GET gets a 404 from the
# listener itself (it only accepts POST /webhook), which proves the full path
# without logging a fake inbound event.
probe() {
  local ips ip code
  ips="$(dig +short +time=3 +tries=1 "$HOST" @1.1.1.1 2>/dev/null | grep -E '^[0-9.]+$')"
  [ -n "$ips" ] || return 2 # no public DNS → network down (just woke?), skip
  for ip in $ips; do
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 15 --resolve "$HOST:443:$ip" "https://$HOST$FPATH/webhook")"
    [ "$code" = "404" ] || [ "$code" = "200" ] && return 0
  done
  return 1
}

read -r RESETS NEXT 2>/dev/null <"$STATE" || true
RESETS="${RESETS:-0}"; NEXT="${NEXT:-0}"

probe; rc=$?
if [ $rc -eq 0 ]; then
  [ "$RESETS" != 0 ] && log "public funnel $HOST$FPATH healthy again" && rm -f "$STATE"
  exit 0
fi
[ $rc -eq 2 ] && exit 0
sleep 30
probe; rc=$?
[ $rc -eq 0 ] || [ $rc -eq 2 ] && exit 0

# Only one watchdog resets at a time; the others skip this run.
mkdir "$LOCK" 2>/dev/null || exit 0
trap 'rmdir "$LOCK"' EXIT

read -r RESETS NEXT 2>/dev/null <"$STATE" || true
RESETS="${RESETS:-0}"; NEXT="${NEXT:-0}"
NOW="$(date +%s)"
[ "$NOW" -ge "$NEXT" ] || exit 0 # backing off after a reset that didn't help

DELAY=$((300 << RESETS)); [ $DELAY -gt 3600 ] && DELAY=3600
echo "$((RESETS + 1)) $((NOW + DELAY))" >"$STATE"

# First try: just this agent's path, so other agents' in-flight work isn't killed.
# Only if that didn't help, reset the whole funnel and restart every agent on it.
if [ "$RESETS" -eq 0 ]; then
  log "public funnel $HOST$FPATH unreachable — resetting $FPATH, restarting $LABEL (next no sooner than $((DELAY / 60)) min)"
  "$TS" funnel --https=443 --set-path="$FPATH" off >/dev/null 2>&1
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
  exit 0
fi
AGENTS="$(launchctl list | awk '$3 ~ /^com\.basicops\.agent\./ {print $3}')"
log "public funnel $HOST$FPATH still unreachable — resetting funnel, restarting $(echo $AGENTS) (reset #$((RESETS + 1)), next no sooner than $((DELAY / 60)) min)"
"$TS" funnel reset >/dev/null 2>&1
for a in $AGENTS; do launchctl kickstart -k "gui/$(id -u)/$a"; done
