---
description: Full service — run the Discover→Plan→Cook→Verify brigade workflow on a task
---

Run full service on this task: **$ARGUMENTS**

Preferred path — the scripted workflow (intermediate results stay out of your context):

1. Invoke the Workflow tool with
   `scriptPath: ${CLAUDE_PLUGIN_ROOT}/workflows/full-service.js` and
   `args: { "task": "$ARGUMENTS" }`.
2. While it runs, stay responsive. When it completes, relay the final report:
   what changed (file:line), test evidence, and any BLOCKED/CONCERNS items.
3. Update `mcp__yeschef__notes`: check off completed plan items, append durable
   discoveries the workflow reported.

Fallback — if the Workflow tool is unavailable or the scriptPath fails, run the
same shape manually with the brigade:
1. `scout` digests the task area (one subagent, clear question).
2. Write the plan to `mcp__yeschef__notes` (- [ ] items) and post tickets to one
   or more `line-cook` subagents (background + parallel ONLY for disjoint files),
   each ticket carrying goal, file:line pointers, scope fence, and the exact
   verify command.
3. `expeditor` verifies the merged result against the goal.
4. Report: outcome first, changes as file:line bullets, test evidence, open items.

If $ARGUMENTS is empty, ask for the task instead of guessing.
