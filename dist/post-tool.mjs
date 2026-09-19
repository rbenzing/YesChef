#!/usr/bin/env node

// src/hooks/post-tool.ts
import { statSync as statSync2 } from "node:fs";

// src/lib/core.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, appendFileSync, statSync, openSync, readSync, closeSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
function readHookInput() {
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function emit(output) {
  try {
    process.stdout._handle?.setBlocking?.(true);
  } catch {
  }
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}
function emitNothing() {
  process.exit(0);
}
function projectSlug(cwd2) {
  const clean = resolve(cwd2).replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return clean.slice(-80) || "root";
}
function yeschefHome() {
  return process.env.YESCHEF_HOME || join(homedir(), ".claude", "yeschef");
}
function stateDir(cwd2) {
  return join(yeschefHome(), "state", projectSlug(cwd2));
}
function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}
function overflowDir(cwd2) {
  return ensureDir(join(stateDir(cwd2), "overflow"));
}
var DEFAULTS = {
  enforcement: { loopGuard: "block", duplicateReadGuard: "block", stopGuard: "block" },
  truncation: { enabled: true, maxLines: 200, maxChars: 8e3, headLines: 80, tailLines: 10 },
  testCompaction: { enabled: true },
  failureNudges: { enabled: true },
  reminder: { enabled: true },
  paralysis: { enabled: true, progresslessToolCalls: 36 },
  budget: { usd: null, warnAt: 0.75, wrapUpAt: 0.9 },
  notes: { compactAtChars: 2e4 },
  loop: { maxCycleSize: 8, repeatsToBlock: 3, windowSize: 24 },
  duplicateRead: { ttlMinutes: 10, warnOn: 2, blockOn: 3 },
  stop: { maxConsecutiveBlocks: 2 },
  telemetry: { enabled: true },
  // Rates verified against platform.claude.com/docs/en/about-claude/pricing (2026-09-18).
  // Keys match as substrings of the model id, LONGEST key first. A bare family key is
  // the current generation's rate, because Claude Code also writes bare aliases
  // ("sonnet", "opus") into the transcript; older generations that are priced
  // differently get their own, more specific key. Retired models are listed because
  // they remain billable on partner clouds after first-party retirement.
  pricing: {
    models: {
      "haiku-3-5": [0.8, 4],
      // retired (Bedrock/Google Cloud only)
      haiku: [1, 5],
      // Haiku 4.5
      "sonnet-4": [3, 15],
      // Sonnet 4.6 / 4.5 / 4
      sonnet: [2, 10],
      // Sonnet 5
      fable: [10, 50],
      mythos: [10, 50],
      "opus-4-1": [15, 75],
      // retired (Bedrock/Google Cloud only)
      "opus-4-2025": [15, 75],
      // Opus 4, dated id, retired (Google Cloud only)
      opus: [5, 25]
      // Opus 5 / 4.8 / 4.7 / 4.6 / 4.5
    },
    default: [5, 25],
    // unknown model → Opus-tier
    cacheReadMult: 0.1,
    cacheReadMultByModel: { "fable-5-1": 0.025, "mythos-5-1": 0.025 },
    cacheWriteMult: 1.25,
    cacheWrite1hMult: 2
  }
};
function deepMerge(base, over) {
  if (over === null || over === void 0) return base;
  if (typeof base !== "object" || base === null || Array.isArray(base)) return over;
  const out = { ...base };
  for (const k of Object.keys(over)) {
    out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}
function loadConfig(cwd2) {
  let cfg2 = DEFAULTS;
  for (const p of [join(yeschefHome(), "config.json"), join(cwd2, ".yeschef.json")]) {
    try {
      if (existsSync(p)) cfg2 = deepMerge(cfg2, JSON.parse(readFileSync(p, "utf8")));
    } catch {
    }
  }
  return cfg2;
}
var EMPTY_STATE = {
  calls: [],
  reads: {},
  failures: {},
  progresslessCalls: 0,
  paralysisTripped: false,
  stopBlocks: 0,
  blocked: { loops: 0, dupReads: 0 },
  compaction: { results: 0, savedChars: 0 },
  brigade: { active: 0, finished: 0 },
  lastTestsFailing: false,
  turn: 0,
  compactRecoveryPending: false
};
function statePath(cwd2, sessionId2) {
  return join(ensureDir(stateDir(cwd2)), `${sessionId2.replace(/[^\w-]/g, "")}.json`);
}
function loadState(cwd2, sessionId2) {
  try {
    const s = deepMerge(structuredClone(EMPTY_STATE), JSON.parse(readFileSync(statePath(cwd2, sessionId2), "utf8")));
    s.calls = (s.calls ?? []).map((c) => typeof c === "string" ? c : c?.h).filter(Boolean);
    return s;
  } catch {
    return structuredClone(EMPTY_STATE);
  }
}
var READS_RETENTION_MS = 60 * 6e4;
var READS_CAP = 500;
function saveState(cwd2, sessionId2, s) {
  try {
    const keys = Object.keys(s.reads);
    if (keys.length > 0) {
      const now = Date.now();
      for (const k of keys) {
        if (now - s.reads[k].t > READS_RETENTION_MS) delete s.reads[k];
      }
      const remaining = Object.keys(s.reads);
      if (remaining.length > READS_CAP) {
        remaining.sort((a, b) => s.reads[a].t - s.reads[b].t).slice(0, remaining.length - READS_CAP).forEach((k) => delete s.reads[k]);
      }
    }
    const p = statePath(cwd2, sessionId2);
    const tmp = `${p}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(s));
    renameSync(tmp, p);
  } catch {
  }
}
function setTestStatus(cwd2, failing) {
  try {
    writeFileSync(join(ensureDir(stateDir(cwd2)), "test-status.json"), JSON.stringify({ failing, t: Date.now() }));
  } catch {
  }
}
function logEvent(cwd2, sessionId2, event, data = {}) {
  try {
    const dir = ensureDir(join(yeschefHome(), "logs"));
    const line = JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), session: sessionId2, event, ...data });
    appendFileSync(join(dir, `${projectSlug(cwd2)}.jsonl`), line + "\n");
  } catch {
  }
}
function contextScope(transcriptPath) {
  return createHash("md5").update(transcriptPath ?? "").digest("hex").slice(0, 8);
}
function hashCall(toolName, toolInput) {
  return createHash("md5").update(toolName + "\0" + JSON.stringify(toolInput ?? {})).digest("hex");
}

// src/lib/compact.ts
import { writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
import { createHash as createHash2 } from "node:crypto";
var RUNNERS = String.raw`pytest|py\.test|jest|vitest|phpunit|rspec|mocha|tape|ava|tox|ctest|unittest`;
var LAUNCHERS = String.raw`(?:npx\s+|bunx\s+|(?:pnpm|yarn)\s+(?:exec|dlx)\s+|uv\s+run\s+|python3?\s+-m\s+|py\s+-m\s+)?`;
var TEST_CMD = new RegExp(
  String.raw`(?:^|[;&|\n]|\$\()\s*` + String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*` + // CI=true ...
  String.raw`(?:sudo\s+|time\s+)?` + String.raw`(?:` + LAUNCHERS + String.raw`(?:\S*[\\/])?(?:${RUNNERS})\b(?![.\\/-])` + // runner exe, optionally path-invoked; excludes jest.config.js / jest-report.sh
  String.raw`|go\s+test\b|dotnet\s+test\b|cargo\s+(?:test|nextest)\b` + String.raw`|(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?test\b|npm\s+t\b` + String.raw`|make\s+test\b|(?:\S*[\\/])?gradlew(?:\.bat)?\s+[^;&|\n]*\btest\b|mvn\s+[^;&|\n]*\btest\b` + String.raw`)`
);
function looksLikeTestCommand(command) {
  return TEST_CMD.test(command);
}
var FAIL_CHAR_CAP = 2e4;
function saveOverflow(dir, label, full) {
  const name = `${label}-${createHash2("md5").update(full).digest("hex").slice(0, 8)}.txt`;
  const p = join2(dir, name);
  try {
    writeFileSync2(p, full);
  } catch {
    return null;
  }
  return p;
}
function extractFailureLines(lines) {
  const kept = [];
  let inSection = false;
  const sectionStart = /^(=+\s*(FAILURES|ERRORS)\s*=+|FAIL\b|●\s|✗|✖|Error:|\s*\d+\)\s|FAILED\b|panic:|--- FAIL)/;
  const summary = /(=+ .*(passed|failed|error).* =+|Tests?:.*|Test Suites:.*|^FAILED\b.*|^OK\b.*|\d+ pass(ed|ing).*|\d+ fail(ed|ing).*|--- FAIL.*|^ok\s|^FAIL\s|Results?:.*|Finished in .*|\d+ examples?, \d+ failures?)/i;
  for (const line of lines) {
    if (sectionStart.test(line)) inSection = true;
    else if (/^=+\s*(warnings summary|short test summary)/i.test(line)) inSection = false;
    if (inSection) kept.push(line);
    else if (summary.test(line)) kept.push(line);
  }
  return kept;
}
var GREEN_SUMMARY = /(\d+ (passed|passing)|^ok\b|Tests?:\s.*pass|All tests passed|test result: ok)/im;
var FAIL_MARK = /(\bFAILED\b|\bFAIL\b|✗|✖|●|\bError\b|panic:|failures?:\s*[1-9]|\d+ (failed|failing))/;
var HARD_FAIL = /([1-9]\d*\s+fail(ed|ing|ures?)\b|failures?:\s*[1-9])/i;
var TAP_FAIL_LINE = /^(not ok\b|#\s*fail\w*\s+[1-9])/i;
var PASS_NAME_LINE = /^\s*(✓|✔|ok\s+\d|PASS\b)/;
function isTestFailure(output, exitCodeNonZero) {
  if (exitCodeNonZero) return true;
  for (const line of output.split("\n")) {
    if (TAP_FAIL_LINE.test(line)) return true;
    if (HARD_FAIL.test(line) && !PASS_NAME_LINE.test(line)) return true;
  }
  const looksGreen = GREEN_SUMMARY.test(output);
  const looksFailed = FAIL_MARK.test(output) && !/0 failed/i.test(output);
  return looksFailed && !looksGreen;
}
function compactTestOutput(output, exitCodeNonZero, overflowPath) {
  const lines = output.split("\n");
  const failed = isTestFailure(output, exitCodeNonZero);
  if (!failed && GREEN_SUMMARY.test(output)) {
    const summaryLines = lines.filter((l) => GREEN_SUMMARY.test(l)).slice(-3);
    const text = `[yeschef] tests green. ${summaryLines.join(" | ").trim() || "all passed"}`;
    return finish(text, output, overflowPath, "tests-green");
  }
  if (failed) {
    let kept = extractFailureLines(lines);
    if (kept.length === 0) kept = lines.slice(-60);
    if (kept.length > 220) kept = [...kept.slice(0, 180), `  \u2026 ${kept.length - 200} failure lines omitted \u2026`, ...kept.slice(-20)];
    let body = kept.join("\n");
    if (body.length > FAIL_CHAR_CAP) {
      body = body.slice(0, FAIL_CHAR_CAP - 1500) + "\n  \u2026[yeschef] failure detail char-capped\u2026\n" + body.slice(-1200);
    }
    const text = `[yeschef] test failures (compacted):
${body}`;
    return finish(text, output, overflowPath, "tests-failed");
  }
  return { text: output, savedChars: 0, kind: "unchanged" };
}
function finish(text, full, overflowDir2, kind) {
  if (text.length >= full.length) return { text: full, savedChars: 0, kind: "unchanged" };
  const p = saveOverflow(overflowDir2, "test", full);
  const out = p ? `${text}
[yeschef] full output: ${p}` : text;
  return { text: out, savedChars: full.length - out.length, kind };
}
function truncateGeneric(output, maxLines, maxChars, headLines, tailLines, overflowDir2) {
  const lines = output.split("\n");
  if (lines.length <= maxLines && output.length <= maxChars) {
    return { text: output, savedChars: 0, kind: "unchanged" };
  }
  const p = saveOverflow(overflowDir2, "bash", output);
  let head = lines.slice(0, headLines).join("\n");
  const headClipped = head.length > maxChars;
  if (headClipped) head = head.slice(0, maxChars) + "\u2026[clipped at char cap]";
  let tail = tailLines > 0 && lines.length > headLines + tailLines ? lines.slice(-tailLines).join("\n") : "";
  const tailCap = Math.max(500, Math.floor(maxChars / 8));
  if (tail.length > tailCap) tail = "\u2026" + tail.slice(-tailCap);
  const omitted = Math.max(0, lines.length - headLines - (tail ? tailLines : 0));
  const what = [omitted > 0 ? `${omitted} lines` : "", headClipped ? "long lines char-clipped" : ""].filter(Boolean).join(", ") || "content";
  const text = `${head}
[yeschef] truncated: ${what} (${output.length} chars total) omitted. ` + (p ? `Full output: ${p}
` : "") + `Re-run with a filter (grep/head) or read specific ranges if you need more.` + (tail ? `
--- tail ---
${tail}` : "");
  return { text, savedChars: Math.max(0, output.length - text.length), kind: "truncated" };
}
function extractResponseText(resp) {
  if (typeof resp === "string") return { text: resp, rebuild: (t) => t };
  if (resp && typeof resp === "object") {
    if (typeof resp.stdout === "string") {
      const err = typeof resp.stderr === "string" ? resp.stderr : "";
      return {
        text: err ? resp.stdout ? `${resp.stdout}
${err}` : err : resp.stdout,
        rebuild: (t) => ({ ...resp, stdout: t, ...err ? { stderr: "" } : {} })
      };
    }
    if (typeof resp.output === "string") {
      return { text: resp.output, rebuild: (t) => ({ ...resp, output: t }) };
    }
    if (Array.isArray(resp.content)) {
      const idx = [];
      for (let i = 0; i < resp.content.length; i++) {
        const b = resp.content[i];
        if (b?.type === "text" && typeof b.text === "string") idx.push(i);
      }
      if (idx.length > 0) {
        return {
          text: idx.map((i) => resp.content[i].text).join("\n"),
          rebuild: (t) => ({
            ...resp,
            content: resp.content.map((b, i) => i === idx[0] ? { ...b, text: t } : idx.includes(i) ? { ...b, text: "" } : b)
          })
        };
      }
    }
  }
  return null;
}

// src/lib/notes.ts
import { readFileSync as readFileSync2, writeFileSync as writeFileSync3, existsSync as existsSync2 } from "node:fs";
import { join as join3 } from "node:path";
var KITCHEN_ID = "kitchen";
var SECTION_HEADER_RE = /^##\s+(\w+)/;
function notesPath(cwd2) {
  return join3(ensureDir(stateDir(cwd2)), `notes-${KITCHEN_ID}.md`);
}
var TEMPLATE = `# Mise en place
## goal
(unset \u2014 write one sentence)
## plan
## discoveries
## decisions
`;
function readNotes(cwd2) {
  const p = notesPath(cwd2);
  if (!existsSync2(p)) return TEMPLATE;
  try {
    return readFileSync2(p, "utf8");
  } catch {
    return TEMPLATE;
  }
}
function splitSections(text) {
  const out = /* @__PURE__ */ Object.create(null);
  let current = "_preamble";
  out[current] = [];
  for (const line of text.split("\n")) {
    const m = line.match(SECTION_HEADER_RE);
    if (m) {
      current = m[1].toLowerCase();
      out[current] = out[current] ?? [];
      continue;
    }
    out[current].push(line);
  }
  return out;
}
function openPlanItems(text) {
  const sections = splitSections(text);
  return (sections["plan"] ?? []).filter((l) => /^\s*-\s*\[ \]/.test(l)).map((l) => l.replace(/^\s*-\s*\[ \]\s*/, "").trim());
}
function compactRecoveryContext(cwd2) {
  const summary = notesSummary(cwd2);
  if (!summary) return null;
  return `[yeschef] context was compacted. Your mise en place survives:
${summary}
Full notes: mcp__yeschef__notes(action:"read").`;
}
function notesSummary(cwd2, maxChars = 1200) {
  const text = readNotes(cwd2);
  const sections = splitSections(text);
  const goal = (sections["goal"] ?? []).map((l) => l.trim()).filter((l) => l && !l.startsWith("(unset")).join(" ");
  const open = openPlanItems(text);
  const disc = (sections["discoveries"] ?? []).map((l) => l.trim()).filter(Boolean).slice(-5);
  const parts = [
    goal ? `Goal: ${goal}` : "",
    open.length ? `Open plan items:
${open.slice(0, 8).map((i) => `- [ ] ${i}`).join("\n")}` : "",
    disc.length ? `Recent discoveries:
${disc.map((d) => `- ${d}`).join("\n")}` : ""
  ].filter(Boolean);
  return parts.join("\n").slice(0, maxChars);
}

// src/hooks/post-tool.ts
var input = readHookInput();
var cwd = input.cwd ?? process.cwd();
var sessionId = input.session_id ?? "unknown";
var tool = input.tool_name ?? "";
var cfg = loadConfig(cwd);
var scope = contextScope(input.transcript_path);
function normalizeCmd(cmd) {
  return cmd.replace(/\s+/g, " ").trim().slice(0, 200);
}
try {
  const state = loadState(cwd, sessionId);
  const hookOut = { hookEventName: input.hook_event_name ?? "PostToolUse" };
  let progress = false;
  const contexts = [];
  if (state.compactRecoveryPending) {
    state.compactRecoveryPending = false;
    const recovery = compactRecoveryContext(cwd);
    if (recovery) contexts.push(recovery);
  }
  const bumpFailureStreak = (cmd) => {
    const key = normalizeCmd(cmd);
    state.failures[key] = (state.failures[key] ?? 0) + 1;
    const n = state.failures[key];
    if (n === 2) contexts.push(`[yeschef] '${key.slice(0, 60)}' failed twice in a row. Read the full error before retrying \u2014 what EXACTLY does it say? Check assumptions (paths, env, versions).`);
    if (n >= 3) contexts.push(`[yeschef] '${key.slice(0, 60)}' has failed ${n}x. STOP retrying it. Change approach: re-read the failing code, add a diagnostic, or delegate a focused investigation to scout. Note the blocker in mcp__yeschef__notes.`);
  };
  const applyCompaction = (r, rebuild, kind) => {
    if (r.kind === "unchanged") return;
    hookOut.updatedToolOutput = rebuild(r.text);
    state.compaction.results += 1;
    state.compaction.savedChars += r.savedChars;
    if (cfg.telemetry.enabled) logEvent(cwd, sessionId, "compacted", { kind, savedChars: r.savedChars });
  };
  if ((input.hook_event_name ?? "") === "PostToolUseFailure") {
    if (tool === "Bash" && cfg.failureNudges.enabled) {
      const cmd = String(input.tool_input?.command ?? "");
      if (cmd) bumpFailureStreak(cmd);
      if (looksLikeTestCommand(cmd)) {
        state.lastTestsFailing = true;
        setTestStatus(cwd, true);
      }
    }
    state.progresslessCalls += 1;
    saveState(cwd, sessionId, state);
    if (contexts.length) emit({ hookSpecificOutput: { ...hookOut, additionalContext: contexts.join("\n") } });
    emitNothing();
  }
  if (tool === "Read") {
    const fp = String(input.tool_input?.file_path ?? "");
    if (fp) {
      const key = `${scope}|${fp}|${input.tool_input?.offset ?? 0}|${input.tool_input?.limit ?? 0}`;
      let mtime = 0;
      try {
        mtime = statSync2(fp).mtimeMs;
      } catch {
      }
      const rec = state.reads[key];
      if (!rec) progress = true;
      const count = rec && rec.mtime === mtime ? rec.count : 1;
      state.reads[key] = { count, t: Date.now(), mtime };
    }
  }
  if (tool === "Edit" || tool === "Write" || tool === "NotebookEdit") {
    progress = true;
    const fp = String(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? "");
    if (fp) {
      for (const key of Object.keys(state.reads)) {
        if (key.slice(9).startsWith(`${fp}|`)) delete state.reads[key];
      }
    }
  }
  if (tool === "Grep" || tool === "Glob") {
    const h = `${scope}:${hashCall(tool, input.tool_input)}`;
    if (state.calls.filter((x) => x === h).length <= 1) progress = true;
  }
  if (tool === "Bash") {
    const cmd = String(input.tool_input?.command ?? "");
    const resp = extractResponseText(input.tool_response);
    const ec = input.tool_response?.exit_code ?? input.tool_response?.code;
    const nonZero = typeof ec === "number" && ec !== 0 || input.tool_response?.is_error === true || input.tool_response?.interrupted === true;
    const text = resp?.text ?? "";
    if (cfg.failureNudges.enabled && cmd) {
      if (nonZero) {
        bumpFailureStreak(cmd);
      } else {
        if ((state.failures[normalizeCmd(cmd)] ?? 0) > 0) progress = true;
        delete state.failures[normalizeCmd(cmd)];
      }
    }
    const isTest = looksLikeTestCommand(cmd);
    if (isTest) {
      const failing = isTestFailure(text, nonZero);
      state.lastTestsFailing = failing;
      setTestStatus(cwd, failing);
      if (!failing) progress = true;
    }
    if (text) {
      let r = { text, savedChars: 0, kind: "unchanged" };
      let kind = "bash";
      if (isTest && cfg.testCompaction.enabled) {
        r = compactTestOutput(text, nonZero, overflowDir(cwd));
        kind = "test";
      }
      if (r.kind === "unchanged" && cfg.truncation.enabled) {
        r = truncateGeneric(text, cfg.truncation.maxLines, cfg.truncation.maxChars, cfg.truncation.headLines, cfg.truncation.tailLines, overflowDir(cwd));
        kind = "bash";
      }
      applyCompaction(r, resp.rebuild, kind);
    }
  }
  if ((tool === "WebFetch" || tool === "WebSearch") && cfg.truncation.enabled) {
    const resp = extractResponseText(input.tool_response);
    if (resp && resp.text) {
      applyCompaction(
        truncateGeneric(resp.text, cfg.truncation.maxLines * 2, cfg.truncation.maxChars * 2, cfg.truncation.headLines * 2, cfg.truncation.tailLines, overflowDir(cwd)),
        resp.rebuild,
        "web"
      );
    }
    progress = true;
  }
  if (tool === "Agent" || tool === "Task") progress = true;
  state.progresslessCalls = progress ? 0 : state.progresslessCalls + 1;
  if (cfg.paralysis.enabled && state.progresslessCalls >= cfg.paralysis.progresslessToolCalls && !state.paralysisTripped) {
    state.paralysisTripped = true;
    contexts.push(`[yeschef] PARALYSIS: ${state.progresslessCalls} consecutive tool calls produced no progress (no edits, no new files read, no tests passing). Stop and either (a) report what's blocking you and what you tried, or (b) take one decisive different action. Burning more identical calls is not an option.`);
    if (cfg.telemetry.enabled) logEvent(cwd, sessionId, "paralysis-tripped", { calls: state.progresslessCalls });
  }
  if (progress) state.paralysisTripped = false;
  saveState(cwd, sessionId, state);
  if (contexts.length) hookOut.additionalContext = contexts.join("\n");
  if (Object.keys(hookOut).length > 1) emit({ hookSpecificOutput: hookOut });
  emitNothing();
} catch {
  emitNothing();
}
