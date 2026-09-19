// End-to-end smoke tests: spawn the BUILT dist bundles exactly as Claude Code
// would (JSON on stdin), assert on their JSON stdout. Run `npm run build` first
// (the verify script does).
import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIST = resolve(__dirname, "..", "dist");
let home: string;
let cwd: string;
const SID = "hook-smoke";

function runHook(bundle: string, input: Record<string, any>): any {
  const out = execFileSync(process.execPath, [join(DIST, bundle)], {
    input: JSON.stringify({ session_id: SID, cwd, ...input }),
    env: { ...process.env, YESCHEF_HOME: home },
    encoding: "utf8",
  });
  return out.trim() ? JSON.parse(out) : null;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "yeschef-hooks-home-"));
  cwd = mkdtempSync(join(tmpdir(), "yeschef-hooks-cwd-"));
});

// mirrors core.ts projectSlug — the path both state and telemetry are keyed by
function slug(p: string): string {
  return resolve(p).replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(-80);
}
function statePathOf(): string {
  return join(home, "state", slug(cwd), `${SID}.json`);
}
function readState(): any {
  return JSON.parse(readFileSync(statePathOf(), "utf8"));
}
function runCli(bundle: string): string {
  return execFileSync(process.execPath, [join(DIST, bundle)], {
    env: { ...process.env, YESCHEF_HOME: home, CLAUDE_PROJECT_DIR: cwd },
    encoding: "utf8",
  });
}
/** One Opus 4.8 usage line; uncached input at $5/MTok sets the estimated spend. */
function transcriptWith(contextTokens: number): string {
  const p = join(cwd, "transcript.jsonl");
  writeFileSync(p, JSON.stringify({ message: { model: "claude-opus-4-8", usage: { input_tokens: contextTokens, output_tokens: 0 } } }) + "\n");
  return p;
}

describe("pre-tool guard", () => {
  it("denies the 3rd identical call (loop)", () => {
    const call = { hook_event_name: "PreToolUse", tool_name: "Grep", tool_input: { pattern: "x" } };
    expect(runHook("pre-tool.mjs", call)).toBeNull();
    expect(runHook("pre-tool.mjs", call)).toBeNull();
    const third = runHook("pre-tool.mjs", call);
    expect(third.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(third.hookSpecificOutput.permissionDecisionReason).toContain("LoopWarning");
  });
  it("blocks repeated reads of an unchanged file", () => {
    const fp = join(cwd, "a.txt");
    writeFileSync(fp, "hello");
    const read = { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: fp } };
    const post = { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: fp }, tool_response: "hello" };
    expect(runHook("pre-tool.mjs", read)).toBeNull();   // first read: clean
    runHook("post-tool.mjs", post);                      // recorded
    const second = runHook("pre-tool.mjs", read);        // dup #2 -> warn
    expect(second.hookSpecificOutput.additionalContext).toContain("duplicate read");
    const third = runHook("pre-tool.mjs", read);         // dup #3 -> deny
    expect(third.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

describe("post-tool compression", () => {
  it("replaces huge bash output via hookSpecificOutput.updatedToolOutput (documented placement)", () => {
    const big = Array.from({ length: 900 }, (_, i) => `build line ${i}`).join("\n");
    const r = runHook("post-tool.mjs", {
      hook_event_name: "PostToolUse", tool_name: "Bash",
      tool_input: { command: "make build" }, tool_response: { stdout: big, stderr: "" },
    });
    expect(r.hookSpecificOutput.updatedToolOutput.stdout).toContain("[yeschef] truncated");
    expect(r.hookSpecificOutput.updatedToolOutput.stdout.length).toBeLessThan(big.length / 3);
    expect(r.updatedToolOutput).toBeUndefined(); // no undocumented top-level duplicate
  });
  it("still truncates huge test-command output the compactor does not recognize", () => {
    // Unknown reporter: compactTestOutput returns "unchanged" — the generic
    // size cap must catch it (same fallback run_tests applies in server.ts).
    const big = Array.from({ length: 900 }, (_, i) => `unrecognized reporter line ${i}`).join("\n");
    const r = runHook("post-tool.mjs", {
      hook_event_name: "PostToolUse", tool_name: "Bash",
      tool_input: { command: "npx vitest run --reporter=weird" }, tool_response: { stdout: big, stderr: "", exit_code: 0 },
    });
    expect(r.hookSpecificOutput.updatedToolOutput.stdout).toContain("[yeschef] truncated");
  });
  it("compacts failing pytest output and nudges after repeat failures", () => {
    const fail = "=== FAILURES ===\nAssertionError: boom\n=== 1 failed in 1s ===";
    const call = {
      hook_event_name: "PostToolUse", tool_name: "Bash",
      tool_input: { command: "pytest -q" }, tool_response: { stdout: fail, stderr: "", exit_code: 1 },
    };
    runHook("post-tool.mjs", call);
    const second = runHook("post-tool.mjs", call);
    expect(JSON.stringify(second)).toContain("failed twice");
  });
  it("compacts and classifies stderr-only test output (vitest/jest write results there)", () => {
    const fail = Array.from({ length: 50 }, () => "collecting…").join("\n") +
      "\n=== FAILURES ===\nAssertionError: kaboom\n=== 2 failed in 1s ===";
    const r = runHook("post-tool.mjs", {
      hook_event_name: "PostToolUse", tool_name: "Bash",
      tool_input: { command: "npx vitest run" }, tool_response: { stdout: "", stderr: fail, exit_code: 1 },
    });
    const out = r.hookSpecificOutput.updatedToolOutput;
    expect(out.stdout).toContain("kaboom");   // compacted text carried in stdout
    expect(out.stderr).toBe("");               // nothing survives uncompacted
    const status = JSON.parse(readFileSync(join(home, "state", slug(cwd), "test-status.json"), "utf8"));
    expect(status.failing).toBe(true);         // shared marker fed for the stop guard
  });
  it("treats a negative (crash) exit code as failing, not green", () => {
    runHook("post-tool.mjs", {
      hook_event_name: "PostToolUse", tool_name: "Bash",
      tool_input: { command: "npx vitest run" }, tool_response: { stdout: "12 passed", stderr: "", exit_code: -1073741819 },
    });
    const status = JSON.parse(readFileSync(join(home, "state", slug(cwd), "test-status.json"), "utf8"));
    expect(status.failing).toBe(true);
  });
});

describe("post-compaction recovery", () => {
  // Claude Code's hook-output schema rejects hookEventName "PostCompact", so the
  // compact hook must emit NOTHING and hand the notes re-seed to the next
  // context-bearing hook via state.compactRecoveryPending.
  const seedNotes = () => {
    const dir = join(home, "state", slug(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes-kitchen.md"), "# Mise en place\n## goal\nship the feature\n## plan\n- [ ] finish relay\n## discoveries\n## decisions\n");
  };
  it("PostCompact emits nothing (schema-safe) and arms the relay flag", () => {
    seedNotes();
    expect(runHook("compact.mjs", { hook_event_name: "PostCompact" })).toBeNull();
    const s = readState();
    expect(s.compactRecoveryPending).toBe(true);
    expect(s.reads).toEqual({}); // dedup records describe a context that no longer exists
  });
  it("PreCompact also emits nothing", () => {
    seedNotes();
    expect(runHook("compact.mjs", { hook_event_name: "PreCompact" })).toBeNull();
  });
  it("the next post-tool relays the notes re-seed exactly once", () => {
    seedNotes();
    runHook("compact.mjs", { hook_event_name: "PostCompact" });
    const fp = join(cwd, "f.txt");
    writeFileSync(fp, "x");
    const post = { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: fp }, tool_response: "x" };
    const r1 = runHook("post-tool.mjs", post);
    expect(r1.hookSpecificOutput.hookEventName).toBe("PostToolUse"); // a schema-valid carrier
    expect(r1.hookSpecificOutput.additionalContext).toContain("mise en place survives");
    expect(r1.hookSpecificOutput.additionalContext).toContain("ship the feature");
    const r2 = runHook("post-tool.mjs", post);
    expect(JSON.stringify(r2 ?? {})).not.toContain("mise en place survives");
  });
  it("a user prompt also relays it, exactly once", () => {
    seedNotes();
    runHook("compact.mjs", { hook_event_name: "PostCompact" });
    const r1 = runHook("user-prompt.mjs", { hook_event_name: "UserPromptSubmit" });
    expect(r1.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(r1.hookSpecificOutput.additionalContext).toContain("mise en place survives");
    const r2 = runHook("user-prompt.mjs", { hook_event_name: "UserPromptSubmit" });
    expect(r2.hookSpecificOutput.additionalContext).not.toContain("mise en place survives");
  });
  it("PostCompact with no notes does not arm the relay", () => {
    expect(runHook("compact.mjs", { hook_event_name: "PostCompact" })).toBeNull();
    expect(readState().compactRecoveryPending).toBe(false);
  });
});

describe("stop guard", () => {
  it("blocks a premature stop while plan items are open, then yields", () => {
    // Seed the SHARED kitchen notes — the same notes-kitchen.md the MCP notes
    // tool writes. The guard must read that namespace, not a per-session file,
    // or it never sees the plan the model actually keeps.
    const slug = cwd.replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(-80);
    const dir = join(home, "state", slug);
    execFileSync(process.execPath, ["-e", `require('fs').mkdirSync(${JSON.stringify(dir)},{recursive:true})`]);
    writeFileSync(join(dir, "notes-kitchen.md"), "# Mise en place\n## goal\nship\n## plan\n- [ ] unfinished thing\n## discoveries\n## decisions\n");
    const r1 = runHook("stop.mjs", { hook_event_name: "Stop" });
    expect(r1.decision).toBe("block");
    expect(r1.reason).toContain("unfinished thing");
    const r2 = runHook("stop.mjs", { hook_event_name: "Stop" });
    expect(r2.decision).toBe("block");
    const r3 = runHook("stop.mjs", { hook_event_name: "Stop" }); // max 2 consecutive blocks
    expect(r3).toBeNull();
  });
  it("never blocks when stop_hook_active is set", () => {
    expect(runHook("stop.mjs", { hook_event_name: "Stop", stop_hook_active: true })).toBeNull();
  });
  it("blocks on a fresh failing test marker (fed by run_tests or post-tool) but not a stale one", () => {
    const dir = join(home, "state", slug(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "test-status.json"), JSON.stringify({ failing: true, t: Date.now() }));
    const r = runHook("stop.mjs", { hook_event_name: "Stop" });
    expect(r.decision).toBe("block");
    expect(r.reason).toContain("FAILING");
    // a red run from a long-dead session must not hold later sessions hostage
    writeFileSync(join(dir, "test-status.json"), JSON.stringify({ failing: true, t: Date.now() - 7 * 3600_000 }));
    expect(runHook("stop.mjs", { hook_event_name: "Stop" })).toBeNull();
  });
});

describe("guard context scoping", () => {
  it("does not count the parent's reads against a subagent's first read", () => {
    const fp = join(cwd, "shared.txt");
    writeFileSync(fp, "content");
    const read = (transcript: string) => ({
      hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: fp }, transcript_path: transcript,
    });
    const record = (transcript: string) => ({
      hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: fp }, tool_response: "content", transcript_path: transcript,
    });
    // parent escalates to deny on its own transcript
    runHook("pre-tool.mjs", read("main.jsonl")); runHook("post-tool.mjs", record("main.jsonl"));
    runHook("pre-tool.mjs", read("main.jsonl"));
    const third = runHook("pre-tool.mjs", read("main.jsonl"));
    expect(third.hookSpecificOutput.permissionDecision).toBe("deny");
    // a subagent (different transcript) reads the same file for the FIRST time — must pass
    expect(runHook("pre-tool.mjs", read("agent-scout.jsonl"))).toBeNull();
  });
});

describe("session-start seed", () => {
  it("emits house rules and a folder digest", () => {
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "seed-fixture" }));
    const r = runHook("session-start.mjs", { hook_event_name: "SessionStart", source: "startup" });
    const ctx = r.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("House rules");
    expect(ctx).toContain("seed-fixture");
  });
});

describe("user-prompt budget thresholds", () => {
  // Contract (README/config): warn at warnAt (75%), order wrap-up at wrapUpAt (90%).
  beforeEach(() => writeFileSync(join(cwd, ".yeschef.json"), JSON.stringify({ budget: { usd: 5 } })));
  it("stays quiet below warnAt", () => {
    const r = runHook("user-prompt.mjs", { hook_event_name: "UserPromptSubmit", transcript_path: transcriptWith(300_000) }); // ~$1.50 = 30%
    const ctx = r.hookSpecificOutput.additionalContext;
    expect(ctx).not.toContain("budget:");
    expect(ctx).not.toContain("BUDGET:");
  });
  it("warns between warnAt and wrapUpAt, without ordering a wrap-up", () => {
    const r = runHook("user-prompt.mjs", { hook_event_name: "UserPromptSubmit", transcript_path: transcriptWith(780_000) }); // ~$3.90 = 78%
    const ctx = r.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("budget:");
    expect(ctx).not.toContain("BUDGET:");
  });
  it("orders a wrap-up past wrapUpAt", () => {
    const r = runHook("user-prompt.mjs", { hook_event_name: "UserPromptSubmit", transcript_path: transcriptWith(930_000) }); // ~$4.65 = 93%
    const ctx = r.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("BUDGET:");
    expect(ctx).toContain("Wrap up");
  });
});

describe("subagent brigade counters", () => {
  it("counts start/stop, resets stall accounting, and un-trips paralysis on a finished delegation", () => {
    runHook("subagent.mjs", { hook_event_name: "SubagentStart" });
    expect(readState().brigade).toEqual({ active: 1, finished: 0 });
    // simulate a paralysis-tripped kitchen mid-delegation
    writeFileSync(statePathOf(), JSON.stringify({ ...readState(), paralysisTripped: true, progresslessCalls: 30 }));
    runHook("subagent.mjs", { hook_event_name: "SubagentStop" });
    const s = readState();
    expect(s.brigade).toEqual({ active: 0, finished: 1 });
    expect(s.progresslessCalls).toBe(0);
    // "a finished delegation is progress" — progress un-trips paralysis (post-tool
    // does exactly this), otherwise the stop guard stays disabled for the session
    expect(s.paralysisTripped).toBe(false);
  });
  it("never drives the active count below zero on an orphan stop", () => {
    runHook("subagent.mjs", { hook_event_name: "SubagentStop" });
    expect(readState().brigade).toEqual({ active: 0, finished: 1 });
  });
});

describe("session-end tally", () => {
  it("logs turns and a cost estimate to the telemetry JSONL", () => {
    runHook("user-prompt.mjs", { hook_event_name: "UserPromptSubmit" }); // turn 1
    runHook("session-end.mjs", { hook_event_name: "SessionEnd", transcript_path: transcriptWith(100_000) });
    const log = readFileSync(join(home, "logs", `${slug(cwd)}.jsonl`), "utf8");
    const end = log.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.event === "session-end");
    expect(end.session).toBe(SID);
    expect(end.turns).toBe(1);
    expect(end.estCostUSD).toBeCloseTo(0.5); // 100k uncached input × $5/MTok (Opus 4.8)
  });
  // BouzeCode's metric is top-tier tokens, so session-end has to record the split,
  // not just the per-model cost breakdown.
  it("records the top-tier / delegated token split", () => {
    runHook("session-end.mjs", { hook_event_name: "SessionEnd", transcript_path: transcriptWith(100_000) });
    const log = readFileSync(join(home, "logs", `${slug(cwd)}.jsonl`), "utf8");
    const end = log.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.event === "session-end");
    expect(end.tiers.topMain).toBe(100_000);   // Opus 4.8 on the main thread
    expect(end.tiers.cheapMain).toBe(0);
    expect(end.tiers.topSide).toBe(0);
    expect(end.tiers.cheapSide).toBe(0);
  });
});

describe("report and 86 CLIs", () => {
  it("report aggregates the telemetry log", () => {
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(join(home, "logs", `${slug(cwd)}.jsonl`), [
      { session: "s1", event: "compacted", savedChars: 4000 },
      { session: "s1", event: "compacted", savedChars: 4000 },
      { session: "s1", event: "loop-blocked" },
      { session: "s1", event: "dup-read-blocked" },
      { session: "s1", event: "subagentstop" },
      { session: "s1", event: "session-end", estCostUSD: 1.25 },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const out = runCli("report.mjs");
    expect(out).toMatch(/tool results compacted\s*:\s*2/);
    expect(out).toMatch(/loops blocked\s*:\s*1/);
    expect(out).toMatch(/duplicate reads blocked\s*:\s*1/);
    expect(out).toMatch(/brigade runs finished\s*:\s*1/);
    expect(out).toContain("$1.25");
  });
  it("report surfaces top-tier tokens and the delegation rate", () => {
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(join(home, "logs", `${slug(cwd)}.jsonl`), [
      { session: "s1", event: "session-end", estCostUSD: 1,
        tiers: { topMain: 700, topSide: 100, cheapMain: 100, cheapSide: 100 } },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const out = runCli("report.mjs");
    expect(out).toMatch(/top-tier tokens/i);
    expect(out).toContain("800");   // 700 + 100 on the frontier model
    expect(out).toMatch(/20(.0)?%/); // 200 of 1000 tokens delegated to a cheaper tier
  });
  it("report survives a project with no telemetry", () => {
    expect(runCli("report.mjs")).toContain("No telemetry yet");
  });
  it("86 clears session state but preserves the kitchen notes", () => {
    const dir = join(home, "state", slug(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${SID}.json`), "{}");
    writeFileSync(join(dir, "notes-kitchen.md"), "# Mise en place\n## plan\n- [ ] keep me\n");
    const out = runCli("eighty-six.mjs");
    expect(out).toContain("cleared 1");
    expect(existsSync(join(dir, `${SID}.json`))).toBe(false);
    expect(existsSync(join(dir, "notes-kitchen.md"))).toBe(true);
  });
});

describe("statusline", () => {
  it("renders defensively from partial input", () => {
    const out = execFileSync(process.execPath, [join(DIST, "statusline.mjs")], {
      input: JSON.stringify({ model: { display_name: "Opus 4.6" }, workspace: { current_dir: cwd }, cost: { total_cost_usd: 1.23 } }),
      env: { ...process.env, YESCHEF_HOME: home },
      encoding: "utf8",
    });
    expect(out).toContain("yeschef");
    expect(out).toContain("$1.23");
  });
});
