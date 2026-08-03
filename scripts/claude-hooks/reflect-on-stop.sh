#!/usr/bin/env bash
# Stop hook for decant. Nudges toward writing down durable findings when a
# session changed several files but recorded nothing.
#
# Claude Code passes the Stop hook a JSON payload on stdin. This walks the
# session transcript, counts file edits against knowledge captured, and prints a
# reminder on stderr when the two do not line up. Editing AGENTS.md counts as
# capturing, so a session that already wrote down its conventions stays quiet.
#
# Offline by design. Bash and jq only, no network and no Dosu dependency. The
# reminder names the Dosu MCP tool when it is wired up and falls back to
# AGENTS.md otherwise, so it is useful to contributors without Dosu access.
# Always exits 0, so it can never block a turn or fail a session.
#
# Wire-up lives in .claude/settings.json under hooks.Stop. Tested by
# test/reflect-on-stop.test.ts.

set -uo pipefail

INPUT="$(cat)"

# jq does the JSONL walking. Without it the hook is a no-op rather than an error.
command -v jq >/dev/null 2>&1 || exit 0

# Never re-fire on a stop that this hook itself provoked. Both reads discard
# jq's stderr, so an empty or malformed payload leaves the hook silent instead of
# spilling a parse error into the session.
if [ "$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null)" = "true" ]; then
  exit 0
fi

TRANSCRIPT="$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)"
[ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || exit 0

# The transcript is JSONL and a single assistant turn can carry several tool_use
# blocks inside message.content[]. Walk the structure instead of grepping, so
# field order and whitespace cannot silently break the count.
count_tools() { # <regex matched against the tool name>
  jq -c --arg names "$1" '
    select(.type == "assistant")
    | .message.content[]?
    | select(.type == "tool_use")
    | .name
    | select(test($names))
  ' "$TRANSCRIPT" 2>/dev/null | wc -l | tr -d ' '
}

edited_paths() {
  jq -r '
    select(.type == "assistant")
    | .message.content[]?
    | select(.type == "tool_use")
    | select(.name == "Edit" or .name == "Write")
    | .input.file_path // empty
  ' "$TRANSCRIPT" 2>/dev/null
}

EDITS="$(count_tools '^(Edit|Write)$')"
CAPTURED="$(count_tools 'write_knowledge$')"
EDITS="${EDITS:-0}"
CAPTURED="${CAPTURED:-0}"

# Writing the repo's own guidance is capture by another route. Anchor on a path
# boundary so a file that merely ends in those characters, say NOT_AGENTS.md,
# does not silence the nudge.
if edited_paths | grep -qE '(^|/)(AGENTS|CLAUDE)\.md$'; then
  CAPTURED=$((CAPTURED + 1))
fi

# Read-only and small sessions stay silent.
[ "$EDITS" -gt 2 ] || exit 0
[ "$CAPTURED" -eq 0 ] || exit 0

{
  echo "[reflect] ${EDITS} file changes this session, nothing recorded."
  echo "[reflect] If the work uncovered something durable and non-obvious:"
  echo "[reflect]   - mcp__dosu__write_knowledge, when the Dosu server is listed"
  echo "[reflect]   - AGENTS.md, for a convention the whole repo should follow"
} >&2

exit 0
