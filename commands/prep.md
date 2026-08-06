---
description: Prep the kitchen — index the repo, open the mise-en-place notes, confirm the brigade is ready
---

Prep the kitchen for service:

1. Call `mcp__yeschef__folder_desc` (depth 3, refresh: true) to build a fresh index.
2. Call `mcp__yeschef__notes` with action "read". If the goal is unset and the user
   gave a task in $ARGUMENTS, set the goal (one sentence) and draft a plan as
   `- [ ]` checkboxes via `notes`.
3. Confirm readiness in ≤8 lines: repo shape (2-3 lines from the index), the goal,
   the open plan items, and which brigade members you expect to use (scout /
   line-cook / expeditor) for this work.

If $ARGUMENTS is empty, just report the kitchen state (index summary + current
notes) and ask for the ticket.

Task: $ARGUMENTS
