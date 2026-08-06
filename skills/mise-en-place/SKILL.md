---
name: mise-en-place
description: The YesChef working method for any multi-step task - coding, research, or iterative work - batch discovery, 3-turn floor, shared notes, token thrift. Use at the START of any non-trivial task (feature, bug fix, refactor, investigation, research question, multi-cycle iteration) to set up the work correctly, and whenever unsure how to keep context lean.
---

# Mise en place — everything in its place before you cook

The goal: finish in the FEWEST turns with the LEANEST context. Each extra turn
resends the whole conversation; each raw dump pollutes every later turn. Cost
grows quadratically — thrift compounds.

## The 3-turn floor (Discover → Read → Act)

**Turn 1 — Discover (one message, everything parallel):**
- `mcp__yeschef__folder_desc` for orientation (hundreds of tokens, cached).
- ONE `mcp__yeschef__batch_digest` call with ALL your globs/greps at once.
- For anything bigger, delegate to the `scout` subagent instead of exploring
  yourself — its digest costs the chef ~40 lines, not 40 files.
- Set the goal and plan in `mcp__yeschef__notes`:
  - `action:"set", section:"goal"` — one sentence.
  - `action:"set", section:"plan"` — `- [ ]` checkboxes, smallest verifiable steps.

**Turn 2 — Read (only what Discover proved you need):**
- Parallel `Read` calls with `offset`/`limit` ranges, or one `batch_digest` with
  read-range ops. Never read a whole large file for one function.

**Turn 3 — Act (everything that can land together):**
- All independent edits in one message. Then verify (run_tests / expeditor).
- Check off finished plan items: `notes` `action:"check"`.

Simple tasks may legitimately need fewer; complex ones iterate Act→Verify. The
floor is the discipline: never spend a whole turn on ONE discovery call.

## Token thrift rules

1. **Never re-dump.** Earlier reads are referenced as `file:line`. Re-reading an
   unchanged file gets blocked by the kitchen guardrails.
2. **Batch or delegate.** >2 expected reads → scout. Discovery → batch_digest.
3. **Tests through `mcp__yeschef__run_tests`** — failures come back compacted,
   green runs come back as one line.
4. **Notes are memory, not transcript.** Durable facts go in notes (one line
   each); the transcript is allowed to be forgotten (compaction).
5. **Think ≤15 lines, then act.** Long deliberation is output tokens at the
   most expensive rate. Decide, fire tools, adjust.
6. **Plan items are the contract.** The stop guard blocks finishing with open
   `- [ ]` items — keep the plan honest: check off what's done, delete what's
   obsolete (with a one-line decision note).

## Anti-patterns the kitchen will push back on

- The same tool call twice with identical inputs and no new information (loop guard).
- Read → Read → Read of the same unchanged file (duplicate-read guard).
- Retrying a failing command verbatim a third time (failure nudges).
- 36+ tool calls with no edit, no new file, no passing test (paralysis abort).
