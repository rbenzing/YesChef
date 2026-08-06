# YesChef — Design

> *"Yes, chef!"* — A kitchen-brigade AI harness, packaged as a Claude Code plugin.
> It makes Claude Code cheaper (fewer tokens), sharper (lean context), faster
> (fewer round-trips), and more autonomous (doesn't stall, loop, or quit early).

The methodology is ported from **BouzéCode** ([site](https://simon-free.github.io/bouzecode/),
[repo](https://github.com/Simon-Free/bouzecode), Apache-2.0), a standalone agent
harness that demonstrated ~10x token reduction at equal model capability. BouzéCode
owns its entire agent loop; YesChef re-expresses the same levers inside the
extension surface Claude Code actually offers a plugin: **hooks, MCP tools,
subagents, skills, commands, workflows, statusline**.

---

## 1. The four levers, ported

| # | BouzéCode lever | BouzéCode mechanism (owns the loop) | YesChef mechanism (plugin surface) |
|---|---|---|---|
| 1 | **Fewer turns** | DAG executor, `depends_on`, 3-turn floor (Discover→Read→Act), `GetFolderDescription` | `mise-en-place` skill (batch discipline, 3-turn floor); `folder_desc` + `batch_digest` MCP tools (one call = a whole Discover turn); per-turn chef's reminder via `UserPromptSubmit` |
| 2 | **Less context** | ContextGC tool (trash/keep_snippets/notes), 50-line snippet wrapping, methodology note + 20k structural compaction, tool-result truncation, pytest compaction | **Prevention over cleanup**: brigade subagents absorb bulk reads and return digests; `PostToolUse → updatedToolOutput` compacts test output and truncates oversized Bash spew (overflow → file + pointer); `notes` MCP tool = shared mise-en-place scratchpad with structural compaction; duplicate-read guardrail |
| 3 | **Less output** | "Think ≤15 lines then ACT" injection, thinking overflow cap | Same instruction carried by the per-turn reminder + skills; digest contracts cap subagent final outputs |
| 4 | **Cache prices** | Fixed block order with `cache_control` breakpoints | Claude Code owns caching natively. YesChef only avoids *breaking* it: stable injection text, append-only placement, no system-prompt churn mid-session |

**Safety stoppers** (BouzéCode's "last resort" layer) map directly:

| BouzéCode | YesChef |
|---|---|
| Loop detection: MD5 of tool batch, cycles size 1–8, ≥3 repeats → LoopWarning | `PreToolUse` keeps a ring buffer of `(tool, input-hash)`; cycle detection over the recent window; 3rd identical repeat is **denied** with corrective feedback (guardrail mode) |
| Paralysis abort at 12 turns without progression | Progress = file mutated / test passed / new file read. Counter in session state; threshold trips → stop guard lets the session end with a status report instead of blocking the stop |
| Omission enforcement (locked `tool_choice` side-calls) | Not possible in a plugin (see Gaps). Approximated by seed context at `SessionStart` + per-turn reminder + guardrail denials that *teach* the cheaper alternative |
| Seed placeholder turn 1 (81.8%→0% omission) | `SessionStart` injects house rules + mise notes + folder digest |
| Bigctx-reminder (~70 tokens/turn) | `UserPromptSubmit → additionalContext`, stable wording (cache-friendly), ~70 tokens |

---

## 2. Architecture — the brigade

```
                         ┌──────────────────────────────────────┐
                         │  Chef de cuisine = MAIN THREAD        │
                         │  (orchestrates; keeps a lean context) │
                         └──────┬───────────────┬───────────────┘
            delegates (Agent)   │               │  invokes (Workflow)
        ┌───────────┬───────────┴┐              │
        ▼           ▼            ▼              ▼
   ┌─────────┐ ┌──────────┐ ┌──────────┐  ┌──────────────────┐
   │ scout   │ │line-cook │ │expeditor │  │ full-service.js  │
   │ haiku   │ │ inherit  │ │ inherit  │  │ Discover→Plan→   │
   │ read-   │ │ edits,   │ │ verify,  │  │ Cook→Verify      │
   │ only,   │ │ bg-      │ │ compact  │  │ (workflow runs   │
   │ digest  │ │ capable  │ │ reports  │  │  the brigade)    │
   └────┬────┘ └────┬─────┘ └────┬─────┘  └──────────────────┘
        │           │            │
        └─────┬─────┴────────────┘
              ▼  all share session-wide MCP tools
   ┌─────────────────────────────────────────────┐
   │  MCP "kitchen" server (bundled, stdio)      │
   │  folder_desc · batch_digest · notes ·       │
   │  run_tests                                  │
   └─────────────────────────────────────────────┘
              ▲
   ┌──────────┴──────────────────────────────────┐
   │  Hooks = the chef's discipline              │
   │  SessionStart  seed context                 │
   │  UserPromptSubmit  ~70-tok reminder, budget │
   │  PreToolUse  loop guard, dup-read guard     │
   │  PostToolUse  test compaction, truncation,  │
   │               failure-streak nudges, telem. │
   │  Stop  don't-stop-early guard               │
   │  Pre/PostCompact  state reset, note re-seed │
   └─────────────────────────────────────────────┘
```

**Why subagents don't blow the budget here** (the BouzéCode objection): scouts run
on Haiku, are seeded with the `folder_desc` index instead of exploring cold, and
are bound by a digest contract (≤40 lines, `file:line` pointers, never full dumps).
Isolation keeps the main context clean; cheap models + pre-indexing keep total
spend down; both at once is the point.

### Components

- **agents/** — `scout` (haiku, read-only, digest contract), `line-cook`
  (implementation, background-capable), `expeditor` (verification, compacted
  reports). Plugin agents can't carry `hooks`/`mcpServers`/`permissionMode`
  (ignored by design); they inherit the session's MCP tools, which is all we need.
- **skills/** — `mise-en-place` (the methodology: batch discipline, 3-turn floor,
  notes contract, think-≤15-lines), `brigade` (delegation playbook + digest
  contracts).
- **commands/** — `/yeschef:prep` (index + open notes), `/yeschef:cook` (run the
  full-service workflow), `/yeschef:report` (savings/telemetry report),
  `/yeschef:86` (clear stuck state).
- **workflows/** — `full-service.js`, invoked via the Workflow tool with
  `scriptPath: ${CLAUDE_PLUGIN_ROOT}/workflows/full-service.js`.
- **hooks/** + **dist/** — bundled zero-dependency Node scripts (see §4).
- **statusline/** — kitchen display: context %, cost, waste blocked, brigade
  activity. Reads the documented statusline stdin JSON defensively.

### State & config

- Session state (ring buffers, counters, telemetry): `~/.claude/yeschef/state/<project-slug>/<session-id>.json` — never pollutes the repo.
- Telemetry log: `~/.claude/yeschef/logs/<project-slug>.jsonl` (one event per guardrail action / compaction; `/yeschef:report` aggregates it).
- Folder-desc cache: `~/.claude/yeschef/cache/` with mtime invalidation.
- Config resolution: `.yeschef.json` (project) → `~/.claude/yeschef/config.json` (user) → built-in defaults. Every guardrail has a dial: `"off" | "warn" | "block"`.

### Defaults (ported thresholds)

| Knob | Default | Origin |
|---|---|---|
| Loop cycle window / repeats | sizes 1–8, deny on 3rd repeat | BouzéCode |
| Paralysis threshold | 12 turns without progress | BouzéCode |
| Bash output truncation | 200 lines / 8,000 chars, head 80, overflow → file + pointer | BouzéCode |
| Duplicate-read guard | warn on 2nd identical read, block 3rd (resets on edit/compaction) | adapted |
| Notes structural compaction | 20,000 chars | BouzéCode (20k tokens ≈ chars, conservative) |
| Test compaction | failures: FAILURES/ERRORS + summary; green: one-liner | BouzéCode |
| Per-turn reminder | ~70 tokens, stable text | BouzéCode |
| Budget guardrail | off by default; when set, warn at 75%, wrap-up at 90% | new |
| Stop guard | max 2 consecutive stop-blocks, then always allows stop | safety |

---

## 3. Gaps — what a plugin cannot do (and what we do instead)

These are honest, structural limits of the plugin surface vs. owning the loop:

1. **No message-history rewriting.** BouzéCode's ContextGC deletes stale tool
   results from past turns. A plugin cannot edit the transcript.
   *Instead:* prevent bloat at the source (compression before results land,
   subagent isolation), and lean on Claude Code's native auto-compact /
   microcompact for the rest. Don't duplicate native compaction.
2. **No cache block ordering.** `cache_control` placement is Claude Code's.
   *Instead:* keep every injected string stable and appended, never prefixed.
3. **No locked `tool_choice` recovery side-calls.** Can't force the model to call
   `notes`. *Instead:* seed + reminder + denial messages that name the correct
   tool. BouzéCode's data says seeding alone took omission 81.8%→0%; we get the
   same class of fix, without the hard guarantee.
4. **No thinking-stream control.** Can't cap or summarize thinking overflow.
   *Instead:* instruction-level "think ≤15 lines then act"; effort/thinking level
   stays the user's choice.
5. **No true DAG `depends_on` in the main thread.** Parallel tool calls exist,
   but no cross-batch dependency scheduling. *Instead:* `batch_digest` collapses
   a whole Discover stage into one call; workflows give real scripted DAGs for
   big jobs.
6. **Duplicate-read blocking vs. compaction:** after Claude Code compacts, a
   previously-read file may be *gone* from context, making a re-read legitimate.
   *Mitigation:* `PostCompact` hook clears the read-dedup cache; the guard also
   auto-resets per file on any Edit/Write to it.

## 4. Unknowns & inconclusives (tracked, with fallbacks)

| # | Unknown | Risk | Fallback |
|---|---|---|---|
| U1 | Plugin-shipped **workflows**: docs only document project/user save locations; invoking via `Workflow(scriptPath=${CLAUDE_PLUGIN_ROOT}/...)` from a command is believed to work but unverified | `/yeschef:cook` degraded | command falls back to brigade-via-Agent orchestration; or installer copies the script to `~/.claude/workflows/` |
| U2 | **Statusline stdin schema** varies by version (context %, cost fields) | cosmetic | statusline parses defensively, renders only fields present |
| U3 | `updatedToolOutput` interaction with **microcompact** (double truncation) | cosmetic | our truncation marks output with a `[yeschef]` marker; thresholds sit below native caps so native truncation rarely fires |
| U4 | **PostToolUseFailure / PostCompact** availability across versions (verified ≥2.1.141; user runs 2.1.173) | nudges/cache-reset degrade | failure-streak detection also reads exit markers in PostToolUse output; stale dedup cache self-expires (TTL 10 min) |
| U5 | Stop-hook visibility into "is the task done" is heuristic (we read our own notes' plan checklist + recent failure state, not Claude's internal todo list) | false keep-cooking nudges | hard cap: 2 consecutive blocks, then stop is always allowed; dial to `warn`/`off` |
| U6 | Exact token counts for budget guardrail (hooks don't receive usage) | estimates only | parse `transcript_path` JSONL tail for last `usage` block; report as "estimated" |
| U7 | Whether two plugins' statuslines conflict (last-one-wins per docs) | cosmetic | documented; `/yeschef:report` carries the same data |

## 4b. Beyond BouzéCode — three service modes

BouzéCode optimizes a coding loop. YesChef applies the same physics (quadratic
context growth doesn't care what the tokens contain) to three modes:

1. **Coding** — the brigade above: scout → line-cook(s) → expeditor, with
   `/yeschef:cook` scripting it end-to-end for big jobs.
2. **Research** — `researcher` agent (claims + citations + confidence tags,
   never page dumps), `/yeschef:research` workflow (angles fan out in parallel,
   non-solid claims get adversarially cross-checked, one cited report returns),
   and WebFetch/WebSearch results flow through the same truncation layer as
   build logs.
3. **Iterations** — `/yeschef:iterate`: autonomous multi-cycle work over the
   notes plan checklist — one item per cycle, verified before check-off,
   expeditor gates every few items. The stop guard (open items block premature
   finish), paralysis abort, and budget guard form the loop's safety envelope.
   This turns the notes file into a durable iteration engine that survives
   compaction and even session restarts.

## 5. What YesChef deliberately does NOT do

- Re-implement auto-compact, prompt caching, lazy MCP tool loading (native).
- Rewrite tool *inputs* in v1 (`updatedInput` reserved for v2 — e.g., auto-adding
  `--no-color`/`-q` to test commands).
- Block anything in `advisory` mode — every guard honors its dial.
- Call any LLM from hooks or the MCP server. Everything deterministic, local,
  and free; the only model spend is the conversation itself.

## 6. Success metrics (how we'll know it works)

Per-session, from telemetry: tokens entering context from tool results (raw vs.
after compaction), guardrail blocks (loops, dup reads), subagent digests vs.
estimated inline cost, turns-to-done on comparable tasks. `/yeschef:report`
prints these; the JSONL log allows before/after comparison with the plugin
disabled.
