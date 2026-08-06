# 👨‍🍳 YesChef

<div align="center">

[![Build](https://img.shields.io/github/actions/workflow/status/rbenzing/YesChef/release.yml?style=for-the-badge)](https://github.com/rbenzing/YesChef/actions/workflows/release.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=for-the-badge)](https://www.apache.org/licenses/LICENSE-2.0)
[![Platform](https://img.shields.io/badge/platform-Claude%20Code-lightgrey?style=for-the-badge)](https://claude.ai)
[![Release](https://img.shields.io/github/v/release/rbenzing/YesChef?style=for-the-badge)](https://github.com/rbenzing/YesChef/releases/latest)
[![Node](https://img.shields.io/badge/node-%3E=%2018-green?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/russellbenzing)

**A kitchen-brigade AI harness for Claude Code — token thrift, clean context, autonomous service.**

YesChef ports the methodology of [BouzéCode](https://simon-free.github.io/bouzecode/) — a standalone harness that demonstrated ~10x token reduction at equal model capability — into a Claude Code plugin: disciplined hooks, a bundled MCP server for token-cheap tools, a subagent brigade for context isolation, and scripted workflows for orchestration. See [DESIGN.md](DESIGN.md) for the methodology mapping and tracked unknowns.

[Features](#-features) • [Install](#-install) • [What's in the kitchen](#-whats-in-the-kitchen) • [Configuration](#-configuration) • [Development](#-development) • [License](#-license)

</div>

---

## Why

Agentic context grows quadratically: every turn resends the whole history, so a single 5,000-token dump costs you 5,000 tokens × every remaining turn. YesChef attacks all four levers at once:

1. **Fewer turns** — batch discipline, folder indexing, one-call batch discovery
2. **Less context** — results compacted *before* they land; bulk work isolated in subagents
3. **Less output** — "think ≤15 lines, then act"
4. **No wasted motion** — loop detection, duplicate-read blocking, paralysis abort, don't-stop-early guard

---

## ✨ Features

- Token-thrift MCP tools and pre-indexed folder digests
- Subagent brigade for isolated bulk work (scout, line-cook, expeditor, researcher)
- Hook points: session-start, user-prompt, pre-tool, post-tool, stop, compact, subagent, session-end
- Loop guard, duplicate-read guard, stop guard, and configurable enforcement dials
- Workflows: scripted Discover→Plan→Cook→Verify and Research→Cross-check→Synthesize
- Compacting and batching to keep main context small and useful

---

## 📦 Install

**From the Claude Code plugin marketplace:**

```
/plugin marketplace add russellbenzing/yeschef
/plugin install yeschef@yeschef
```

**From a private Git URL:**

```
/plugin marketplace add https://gitlab.callminerhq.callminer.net/Russell.Benzing/yeschef
/plugin install yeschef@yeschef
```

**Local development (no install):**

```
claude --plugin-dir /path/to/yeschef
```

Requires Claude Code ≥ 2.1 and Node ≥ 18. No install step — all hook/MCP bundles are pre-built and dependency-free.

Optional statusline (context %, cost, tokens trimmed, waste blocked): add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"<path-to-installed-plugin>/dist/statusline.mjs\""
  }
}
```

---

## What's in the kitchen

| Layer | Pieces | What it does |
|---|---|---|
| **Hooks** | session-start, user-prompt, pre-tool, post-tool, stop, compact, subagent, session-end | Seed house rules; short reminder; loop guard; duplicate-read blocking |
| **MCP tools** | `folder_desc`, `batch_digest`, `notes`, `run_tests` | Pre-indexed repo tree in a few hundred tokens; many glob/grep/read ops in ONE call; shared mise-en-place scratchpad |
| **Brigade** (subagents) | `scout` (haiku, read-only), `line-cook`, `expeditor`, `researcher` | Bulk exploration/implementation/verification/research in isolated contexts — results compacted before returning |
| **Workflows** | `full-service.js`, `research-service.js` | Scripted Discover→Plan→Cook→Verify and Angles→Sweep→Cross-check→Synthesize; intermediate results live in script variables |
| **Skills** | `mise-en-place`, `brigade` | The methodology and delegation playbook |
| **Commands** | `/yeschef:prep`, `/yeschef:cook`, `/yeschef:research`, `/yeschef:iterate`, `/yeschef:report`, `/yeschef:eighty-six` | Prep the kitchen · full coding service · cited research service · iterations · reporting · abort |

---

## Three service modes

- **Coding** — `/yeschef:cook <task>`: scout digests, tickets planned with disjoint file sets, line-cooks implement in parallel, expeditor gates the result.
- **Research** — `/yeschef:research <question>`: 2–4 angles fan out to researchers; non-solid claims are adversarially cross-checked; you get one cited report.
- **Iterations** — `/yeschef:iterate`: works the notes plan checklist item by item, each verified before check-off, bounded by loop/paralysis/budget guards.

---

## Configuration

`.yeschef.json` in your project (or `~/.claude/yeschef/config.json`), merged over defaults. Every guard has a dial: `"off" | "warn" | "block"`.

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

Session state and telemetry live under `~/.claude/yeschef/` — nothing is written into your repos. `/yeschef:report` aggregates the log; figures are estimates, not billing data.

---

## Development

```
npm install
npm run verify   # type-check + build dist/ + run tests (incl. hook smoke tests)
```

`dist/` is committed on purpose: marketplace installs are git clones with no install step. Test locally with `claude --plugin-dir .` from a scratch project.

---

## Honesty notes

- Token/cost numbers are **estimates** (transcript usage + a rough price table).
- A plugin cannot rewrite message history, control prompt-cache block order, or force tool calls — see [DESIGN.md §3-4](DESIGN.md) for the full gap list and tracked unknowns.
- Subagents and workflows trade *total* tokens for *clean main context*; YesChef squeezes their cost back down with cheap-model routing, pre-indexing, and digest contracts — but a workflow run is still a fan-out. Scale it to the task.

---

## License

YesChef is licensed under the [Apache-2.0](LICENSE) license.

---

## 👤 About the Author

Built by **Russell Benzing**. Methodology credit: [BouzéCode](https://github.com/Simon-Free/bouzecode).

---

## 🆘 Support

- **Issues**: https://github.com/rbenzing/YesChef/issues
- **Releases**: https://github.com/rbenzing/YesChef/releases

If YesChef is useful to you, you can support the work:

<div align="center">

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/russellbenzing)

</div>
