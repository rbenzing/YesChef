---
description: Iteration service — autonomously work through the plan, item by item, verified, until done or blocked
---

Run iteration service. Task context (may be empty): $ARGUMENTS

This is autonomous multi-cycle work. The kitchen's guards keep it honest: the
stop guard blocks finishing with open plan items, loop/paralysis guards bound
wasted motion, and the budget guard (if configured) bounds spend.

1. **Load the plan.** `mcp__yeschef__notes` action "read". If the plan is empty
   and $ARGUMENTS describes work, draft the plan first: smallest verifiable
   `- [ ]` steps (each one independently completable and testable), set the goal.
2. **Cycle — repeat until no open items remain:**
   a. Take the FIRST open item. If it needs discovery, send `scout` (don't
      self-explore beyond 2 reads).
   b. Implement it — directly for small items; via `line-cook` ticket(s) for
      bigger ones (parallel cooks only on disjoint files).
   c. Verify with the narrowest test via `mcp__yeschef__run_tests`. An item
      without a verification step gets one invented for it (a test, a type-check,
      a concrete observable) — "it compiles" is not verification.
   d. Check it off: `notes` action "check". Append discoveries worth keeping.
   e. Every 3-4 items, or before any risky change: run `expeditor` on the
      accumulated change set; fix regressions BEFORE taking new items.
3. **Finish.** When the plan is empty: final `expeditor` pass, then report in
   ≤15 lines — items completed, evidence, discoveries, anything deferred (as
   new `- [ ]` items with a one-line reason).

Rules: one item at a time; never widen an item's scope mid-cycle (append a new
plan item instead); if blocked on an item after a genuine attempt, mark it
`- [ ] BLOCKED:` with the reason, move to the next, and report all blockers at
the end. If EVERY remaining item is blocked, stop and say exactly what you need.
