# YesChef eval suite

Behavioral evals for the YesChef plugin, run with `claude plugin eval`.

YesChef's claim is about *process*, not output text: fewer turns, leaner context,
work routed to the right brigade member, nothing declared done unverified. These
cases therefore grade the **trace** (what the assistant did) at least as much as
the final message.

## Running

```bash
claude plugin eval .                       # all cases, with/without ablation
claude plugin eval . --case no-skill-*     # one case
claude plugin eval . --ablation none --runs 1   # cheap iteration on graders
```

Defaults are `runs: 3` per arm and a with/without ablation arm, so a full run is
~30 agent runs. Use `--ablation none --runs 1` while tuning graders.

## Cases

| Case | Asserts |
|---|---|
| `mise-triggers-on-multistep` | A multi-file task opens with `mise-en-place`: batched discovery, goal + concrete plan before code. |
| `brigade-delegates-exploration` | Broad exploration is delegated to a subagent; raw file content stays out of the main context. |
| `no-skill-on-trivial-question` | **Discrimination guard** — a one-line lookup is answered directly, with no skill and no subagent. |
| `expeditor-before-done` | A completion claim is backed by an independent check and real evidence, with honest limits. |
| `research-fans-out` | An external question fans out to researchers and returns cited claims, answer first. |

`no-skill-on-trivial-question` is the most important case in the suite. The other
four can be satisfied by triggering more machinery; only this one fails if the
plugin over-triggers. Its graders use `arm: both` so they score in the no-plugin
arm too — a plugin that adds ceremony to trivial questions shows up as a
*negative* delta here.

## Grader conventions

- `arm: with-only` — plugin-fired indicators (`Skill` invocations, brigade
  delegation). Excluded from the without-plugin arm so they don't inflate Δ.
- `arm: both` — assertions that must hold with or without the plugin (correct
  answers, honesty, no over-triggering).
- Unmarked graders are scored in both arms by the default rules.

Prefer free graders (`regex`, `tool_used`, `tool_order`, `file_exists`) over
`llm` where a deterministic check is possible; each `llm` grader costs ~3 judge
calls per run.

## Note on `Bash`

These cases deliberately stay within the default read-only toolset
(`Read`/`Glob`/`Grep`/`Skill`/`Agent`), so no `--allow-tools` grant is needed.
That is partly by necessity: granting `Bash` requires an OS-level sandbox
backend, which **Windows native does not have** — Bash-granting evals are
refused there (use WSL2). Cases that need to execute the plugin's `dist/*.mjs`
entry points would have to run under WSL2 or Linux CI.

Results land in `evals/results/<timestamp>/` and are gitignored.
