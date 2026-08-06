---
description: 86 it — clear stuck kitchen state (loop counters, read cache, stall flags) and optionally the notes
---

The user wants to clear stuck YesChef state ("86 it").

1. Run (Bash): `node "${CLAUDE_PLUGIN_ROOT}/dist/eighty-six.mjs"` — it resets this
   project's session state files (loop ring buffers, duplicate-read cache, failure
   streaks, paralysis/stall flags, stop-block counters). It does NOT touch the
   mise-en-place notes.
2. If $ARGUMENTS contains "notes" or "all", also reset the notes: call
   `mcp__yeschef__notes` with action "set" for section "plan" with empty content,
   and section "goal" with "(unset — write one sentence)" — but FIRST echo the
   current open plan items so nothing is silently lost.
3. Confirm in ≤3 lines what was cleared and that guardrails start fresh.

$ARGUMENTS
