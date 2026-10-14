#!/usr/bin/env bash
#
# macOS watchdog for an agent's Tailscale Funnel. The Mac's Funnel can break on
# the PUBLIC path (relays accept TCP, TLS gets EOF) — often after sleep — while
# tailnet-only tests still pass, so the agent silently stops receiving webhooks.
# This probes the public relays directly; if they fail twice, it resets the
# funnel path and restarts the agent (which re-adds the path on startup).
#
# Usage: mac-funnel-watchdog.sh <agent-slug>      (run by launchd every 5 min)
#
set -uo pipefail

SLUG="${1:?usage: $0 <agent-slug>}"
TS=/Applications/Tailscale.app/Contents/MacOS/tailscale
command -v tailscale >/dev/null 2>&1 && TS="$(command -v tailscale)"
LABEL="com.basicops.agent.$SLUG"
FPATH="/$SLUG"
log() { echo "$(date '+%F %T') $*"; }

# Agent not running → nothing to watch (launchd restarts it on its own).
launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -q "state = running" || exit 0

HOST="$("$TS" status --json 2>/dev/null | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null)"
[ -n "$HOST" ] || exit 0

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

probe; rc=$?
[ $rc -eq 0 ] || [ $rc -eq 2 ] && exit 0
sleep 30
probe; rc=$?
[ $rc -eq 0 ] || [ $rc -eq 2 ] && exit 0

log "public funnel $HOST$FPATH unreachable — resetting funnel path and restarting $LABEL"
"$TS" funnel --https=443 --set-path="$FPATH" off >/dev/null 2>&1
launchctl kickstart -k "gui/$(id -u)/$LABEL"
