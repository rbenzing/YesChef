# 👨‍🍳 YesChef

**A kitchen-brigade AI harness for Claude Code** — token thrift, clean context,
autonomous service. For **coding, research, and iterative work**.

YesChef ports the methodology of [BouzéCode](https://simon-free.github.io/bouzecode/)
([repo](https://github.com/Simon-Free/bouzecode), Apache-2.0) — a standalone
harness that demonstrated ~10x token reduction at equal model capability — into
a Claude Code **plugin**: hooks for discipline, a bundled MCP server for
token-cheap tools, a subagent brigade for context isolation, and workflows for
scripted orchestration. See [DESIGN.md](DESIGN.md) for the full methodology
mapping, including what a plugin *cannot* do and the tracked unknowns.

## Why

Agentic context grows quadratically: every turn resends the whole history, so a
single 5,000-token log dump costs you 5,000 tokens × every remaining turn.
YesChef attacks all four levers at once:

1. **Fewer turns** — batch discipline, folder indexing, one-call batch discovery
2. **Less context** — results compacted *before* they land; bulk work isolated in subagents
3. **Less output** — "think ≤15 lines, then act"
4. **No wasted motion** — loop detection, duplicate-read blocking, paralysis abort, don't-stop-early guard

## Install

**From the Claude Code plugin marketplace:**

```
/plugin marketplace add russellbenzing/yeschef
/plugin install yeschef@yeschef
```

**From a private Git URL (e.g. self-hosted GitLab):** add the repo as a
marketplace, then install from it. `marketplace add` clones the repo and reads
`.claude-plugin/marketplace.json`; manual installs use your existing git
credentials (for background auto-updates set `GITLAB_TOKEN`).

```
/plugin marketplace add https://gitlab.callminerhq.callminer.net/Russell.Benzing/yeschef
/plugin install yeschef@yeschef
```

Or, for local development, launch Claude Code pointed at a clone (no install):

```
claude --plugin-dir /path/to/yeschef
```

Requires Claude Code ≥ 2.1 and Node ≥ 18 (which Claude Code already requires).
No install step: all hook/MCP bundles are pre-built and dependency-free.

Optional — the kitchen-display statusline (context %, cost, tokens trimmed,
waste blocked, active cooks). In `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"<path-to-installed-plugin>/dist/statusline.mjs\""
  }
}
```

## What's in the kitchen

| Layer | Pieces | What it does |
|---|---|---|
| **Hooks** | session-start, user-prompt, pre-tool, post-tool, stop, compact, subagent, session-end | Seed house rules; ~70-token/turn reminder; **loop guard** (3rd identical cycle denied); **duplicate-read guard**; **test-output compaction** + **oversize truncation** (overflow → file + pointer) via `updatedToolOutput`; failure-streak nudges; **paralysis abort** (36 progressless calls); **don't-stop-early guard** (open plan items block premature finish); budget warnings; post-compaction recovery |
| **MCP tools** | `folder_desc`, `batch_digest`, `notes`, `run_tests` | Pre-indexed repo tree in ~hundreds of tokens; many glob/grep/read ops in ONE call; shared mise-en-place scratchpad (goal/plan/discoveries/decisions) with structural compaction; test runner returning failures-only or a one-liner |
| **Brigade** (subagents) | `scout` (haiku, read-only), `line-cook`, `expeditor`, `researcher` | Bulk exploration / implementation / verification / web research in isolated contexts — only ≤30-40-line digest contracts return to your conversation |
| **Workflows** | `full-service.js`, `research-service.js` | Scripted Discover→Plan→Cook→Verify and Angles→Sweep→Cross-check→Synthesize; intermediate results live in script variables, never your context |
| **Skills** | `mise-en-place`, `brigade` | The methodology (3-turn floor, token-thrift rules) and the delegation playbook (ticket writing, service patterns) |
| **Commands** | `/yeschef:prep`, `/yeschef:cook`, `/yeschef:research`, `/yeschef:iterate`, `/yeschef:report`, `/yeschef:eighty-six` | Prep the kitchen · full coding service · cited research service · autonomous plan-driven iteration · savings report · clear stuck state |

## Three service modes

- **Coding** — `/yeschef:cook <task>`: scout digests, tickets get planned with
  disjoint file sets, line-cooks implement in parallel, expeditor gates the result.
- **Research** — `/yeschef:research <question>`: 2-4 angles fan out to
  researchers, non-solid claims are adversarially cross-checked, you get one
  cited report. Web results flow through the same compaction layer as build logs.
- **Iterations** — `/yeschef:iterate`: works the notes plan checklist item by
  item, each verified before check-off, expeditor every few items, bounded by
  the loop/paralysis/budget guards. The stop guard keeps it from quitting early;
  the notes survive compaction and restarts.

## Configuration

`.yeschef.json` in your project (or `~/.claude/yeschef/config.json`), merged over
defaults. Every guard has a dial: `"off" | "warn" | "block"`.

```json
{
  "enforcement": { "loopGuard": "block", "duplicateReadGuard": "warn", "stopGuard": "block" },
  "truncation": { "maxLines": 200, "maxChars": 8000, "headLines": 80, "tailLines": 10 },
  "paralysis": { "progresslessToolCalls": 36 },
  "budget": { "usd": 5.00, "warnAt": 0.75, "wrapUpAt": 0.9 },
  "reminder": { "enabled": true },
  "telemetry": { "enabled": true },
  "pricing": {
    "models": { "haiku": [1, 5], "sonnet": [3, 15], "fable": [10, 50], "opus": [5, 25] },
    "default": [5, 25],
    "cacheReadMult": 0.1,
    "cacheWriteMult": 1.25
  }
}
```

`pricing` drives the budget guard and the `/yeschef:report` cost breakdown (estimates, not billing). Each `models` key is a model-id substring → `[input, output]` $/MTok (first match wins); `default` covers unknown models. Cache reads/writes are billed as multiples of the input rate. Overrides merge per-key, so `{ "pricing": { "models": { "opus": [5, 25] } } }` retunes just Opus and keeps the rest.

Session state and telemetry live under `~/.claude/yeschef/` — nothing is written
into your repos. `/yeschef:report` aggregates the log; figures are estimates,
not billing data.

## Development

```
npm install
npm run verify   # type-check + build dist/ + run tests (incl. hook smoke tests)
```

`dist/` is committed on purpose: marketplace installs are git clones with no
install step. Source in `src/`, bundled per-entry by esbuild (`build.mjs`).
Test it locally with `claude --plugin-dir .` from a scratch project.

## Honesty notes

- Token/cost numbers are **estimates** (transcript usage + a rough price table).
- A plugin cannot rewrite message history, control prompt-cache block order, or
  force tool calls — see [DESIGN.md §3-4](DESIGN.md) for the full gap list,
  unknowns, and fallbacks.
- Subagents and workflows trade *total* tokens for *clean main context*; YesChef
  squeezes their cost back down with cheap-model routing, pre-indexing, and
  digest contracts — but a workflow run is still a fan-out. Scale it to the task.

## License

Apache-2.0. Methodology credit: [BouzéCode](https://github.com/Simon-Free/bouzecode)
by Simon-Free (also Apache-2.0).
