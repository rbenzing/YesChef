---
name: brigade
description: The YesChef delegation playbook - when and how to route work to scout, line-cook, and expeditor subagents, write good tickets, and run parallel service. Use when a task spans multiple files or subsystems, needs heavy exploration, or has parallelizable parts.
---

# Run the brigade — delegation that saves tokens instead of spending them

Subagents isolate context: their reads and logs stay in THEIR window; only the
final digest lands in yours. But a badly-briefed subagent re-explores from
scratch and burns more than it saves. The difference is the ticket.

## Who does what

| Brigade member | Send them | They return |
|---|---|---|
| `scout` (cheap model) | any exploration needing >2 reads: "where is X", "map Y", "trace Z" | ≤40-line digest, file:line pointers |
| `line-cook` | one well-specified change with pointers attached | ≤30-line DONE/BLOCKED + changes + test result |
| `expeditor` | "verify the change set against the goal" — always, before declaring done | ≤30-line PASS/FAIL verdict with evidence |
| `researcher` | one ANGLE of an external question (docs, APIs, prior art, comparisons) | ≤40-line digest: claims + source URLs + confidence tags |

## Writing a ticket (the briefing IS the savings)

A ticket must contain, in this order:
1. **Goal** — one sentence, copy from notes.
2. **Pointers** — the exact `file:line` ranges already discovered. Never make a
   cook re-discover what a scout already found.
3. **Scope fence** — what NOT to touch.
4. **Verification** — the exact test command that must pass.

Bad: "fix the auth bug". Good: "In src/auth/session.ts:84-120 the refresh path
drops the tenant claim (see scout digest). Restore it like login does at
src/auth/login.ts:40-55. Don't touch token TTLs. Verify: npx vitest run src/auth".

## Service patterns

- **Solo** (default for small tasks): chef cooks alone with mise-en-place discipline.
- **Scout-first**: scout digests → chef cooks → expeditor verifies. The standard.
- **Parallel line**: independent tickets → multiple line-cooks as background
  subagents simultaneously → expeditor verifies the merged result. Only when
  tickets touch DISJOINT files.
- **Full service** (big jobs): run `/yeschef:cook` — a scripted workflow drives
  Discover→Plan→Cook→Verify with the brigade, and only the final report enters
  your context.
- **Research service**: `/yeschef:research` — angles fan out to researchers in
  parallel, claims get cross-checked, one cited report comes back.
- **Iteration service**: `/yeschef:iterate` — autonomously work the plan item by
  item, verified each cycle, until the checklist is empty or genuinely blocked.

## Rules

1. Don't delegate what one narrow read answers (delegation has overhead too).
2. Never spawn two cooks on overlapping files.
3. Everything the brigade learns flows through `mcp__yeschef__notes` — it is the
   shared pass between stations; subagents read it on start, you read it after.
4. A digest that violates its contract (raw dumps, >40 lines) gets summarized
   into one notes line and otherwise ignored — don't re-quote bloat into context.
