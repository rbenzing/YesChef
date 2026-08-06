---
description: Kitchen report — what YesChef saved and blocked this session and recently
---

Produce the kitchen report.

1. Run (Bash) `node "${CLAUDE_PLUGIN_ROOT}/dist/report.mjs"` — it prints aggregated
   telemetry for this project (current session + recent sessions) from
   `~/.claude/yeschef/logs/`.
2. Present it concisely:
   - This session: turns, tool results compacted (chars → est. tokens trimmed),
     duplicate reads / loops blocked, brigade runs, est. cost if available.
   - Recent trend: totals across the last sessions in the log.
   - One honest caveat: token/cost figures are ESTIMATES (statusline + transcript
     based), not billing data.
3. If the log is empty, say so and explain telemetry starts accumulating now that
   the kitchen is open.
