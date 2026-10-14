#!/usr/bin/env bash
# Wire this machine's Claude Code sessions and BasicOps agents to the standing
# rules in the Justin AI OS vault (github.com/jtoberbauer/justin-os).
#
#   scripts/install-rules.sh                 # set up ~/.agent-rules links + ~/.claude/CLAUDE.md
#   scripts/install-rules.sh --client-project DIR [DIR...]
#                                            # mark DIRs as BasicOps client projects
#
# Creates (idempotent):
#   ~/.agent-rules/justin-os        -> <vault>
#   ~/.agent-rules/basicops-client  -> <vault>/10 Clients/BasicOps
#   ~/.claude/CLAUDE.md              imports the global Agent Operating Rules
# Claude Code imports can't cross paths with spaces, hence the symlinks (NOT under
# ~/.claude/rules/, which Claude Code auto-loads recursively: that would load the whole vault). The
# paths in ~/.claude/CLAUDE.md and CLAUDE.local.md are identical on every machine.
set -euo pipefail

# Same lookup order as the vault's 70 SOPs/Agent-Obsidian-Context-SOP.md.
VAULT=""
for candidate in \
  "${JUSTIN_AI_OS_VAULT:-}" \
  "/home/gus/.openclaw/workspace/obsidian-ai-os/Justin-OS" \
  "$HOME/Obsidian/Justin-AI-OS/justin-os"
do
  [ -n "$candidate" ] || continue
  if [ -f "$candidate/AGENTS.md" ] && [ -f "$candidate/INDEX.md" ] &&
     git -C "$candidate" remote -v 2>/dev/null | grep -q 'jtoberbauer/justin-os'; then
    VAULT="$candidate"
    break
  fi
done
[ -n "$VAULT" ] || { echo "Justin AI OS vault not found on this machine (set JUSTIN_AI_OS_VAULT)." >&2; exit 1; }

RULES="$HOME/.agent-rules"
CLIENT_IMPORT="@~/.agent-rules/basicops-client/BASICOPS-CLIENT-RULES.md"

if [ "${1:-}" = "--client-project" ]; then
  shift
  for dir in "$@"; do
    [ -d "$dir" ] || { echo "not a directory, skipped: $dir" >&2; continue; }
    local_md="$dir/CLAUDE.local.md"
    if grep -qF "$CLIENT_IMPORT" "$local_md" 2>/dev/null; then
      echo "already a BasicOps client project: $dir"
      continue
    fi
    {
      [ -s "$local_md" ] && echo
      echo "# Client: BasicOps"
      echo
      echo "This is a BasicOps client project, so the BasicOps client rules apply (copy rules, Jesper's mandatories, product facts)."
      echo
      echo "$CLIENT_IMPORT"
    } >> "$local_md"
    # Personal file: keep it out of the repo.
    if git -C "$dir" rev-parse --git-dir >/dev/null 2>&1; then
      exclude="$(git -C "$dir" rev-parse --git-path info/exclude)"
      case "$exclude" in /*) ;; *) exclude="$dir/$exclude" ;; esac
      grep -qxF "CLAUDE.local.md" "$exclude" 2>/dev/null || echo "CLAUDE.local.md" >> "$exclude"
    fi
    # Pre-approve the external import (same as clicking "approve" once in Claude
    # Code); otherwise non-interactive runs silently skip it.
    python3 - "$(cd "$dir" && pwd -P)" <<'PY' || echo "  (approve the external import once in an interactive session)"
import json, os, sys, tempfile
p = os.path.expanduser("~/.claude.json")
d = json.load(open(p)) if os.path.exists(p) else {}
e = d.setdefault("projects", {}).setdefault(sys.argv[1], {})
e["hasClaudeMdExternalIncludesApproved"] = True
e["hasClaudeMdExternalIncludesWarningShown"] = True
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(p))
os.write(fd, json.dumps(d, indent=2).encode()); os.close(fd); os.replace(tmp, p)
PY
    echo "marked BasicOps client project: $dir"
  done
  exit 0
fi

mkdir -p "$RULES"
ln -sfn "$VAULT" "$RULES/justin-os"
ln -sfn "$VAULT/10 Clients/BasicOps" "$RULES/basicops-client"
echo "linked $RULES/justin-os -> $VAULT"

GLOBAL_IMPORT="@~/.agent-rules/justin-os/AGENT-OPERATING-RULES.md"
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
if grep -qF "$GLOBAL_IMPORT" "$CLAUDE_MD" 2>/dev/null; then
  echo "$CLAUDE_MD already imports the global rules"
else
  {
    [ -s "$CLAUDE_MD" ] && echo
    echo "# Justin's global agent rules"
    echo
    echo "Loaded in every Claude Code session (terminal, VS Code, desktop) and by the BasicOps agents."
    echo "The rules live in the Justin AI OS vault: edit them there, not here."
    echo
    echo "$GLOBAL_IMPORT"
  } >> "$CLAUDE_MD"
  echo "added the global rules import to $CLAUDE_MD"
fi
