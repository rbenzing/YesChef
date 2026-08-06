// PostToolUse + PostToolUseFailure: result compression (BouzéCode lever 2 at the
// source) + progress tracking + failure-streak nudges. Uses updatedToolOutput to
// replace bloated results with compact ones BEFORE they enter context; overflow
// goes to disk.
import { statSync } from "node:fs";
import {
  readHookInput, emit, emitNothing, loadConfig, loadState, saveState, logEvent, overflowDir,
  hashCall, contextScope, setTestStatus,
} from "../lib/core.js";
import { compactTestOutput, truncateGeneric, looksLikeTestCommand, extractResponseText, isTestFailure, type CompactResult } from "../lib/compact.js";

const input = readHookInput();
const cwd = input.cwd ?? process.cwd();
const sessionId = input.session_id ?? "unknown";
const tool = input.tool_name ?? "";
const cfg = loadConfig(cwd);
const scope = contextScope(input.transcript_path);

function normalizeCmd(cmd: string): string {
  return cmd.replace(/\s+/g, " ").trim().slice(0, 200);
}

try {
  const state = loadState(cwd, sessionId);
  const hookOut: Record<string, any> = { hookEventName: input.hook_event_name ?? "PostToolUse" };
  let progress = false;
  const contexts: string[] = [];

  const bumpFailureStreak = (cmd: string) => {
    const key = normalizeCmd(cmd);
    state.failures[key] = (state.failures[key] ?? 0) + 1;
    const n = state.failures[key]!;
    if (n === 2) contexts.push(`[yeschef] '${key.slice(0, 60)}' failed twice in a row. Read the full error before retrying — what EXACTLY does it say? Check assumptions (paths, env, versions).`);
    if (n >= 3) contexts.push(`[yeschef] '${key.slice(0, 60)}' has failed ${n}x. STOP retrying it. Change approach: re-read the failing code, add a diagnostic, or delegate a focused investigation to scout. Note the blocker in mcp__yeschef__notes.`);
  };

  // updatedToolOutput lives ONLY inside hookSpecificOutput per the documented
  // schema — the old duplicate top-level copy doubled the payload for nothing.
  const applyCompaction = (r: CompactResult, rebuild: (t: string) => any, kind: string) => {
    if (r.kind === "unchanged") return;
    hookOut.updatedToolOutput = rebuild(r.text);
    state.compaction.results += 1;
    state.compaction.savedChars += r.savedChars;
    if (cfg.telemetry.enabled) logEvent(cwd, sessionId, "compacted", { kind, savedChars: r.savedChars });
  };

  if ((input.hook_event_name ?? "") === "PostToolUseFailure") {
    // Tool-level errors (timeout, interrupt, denial) — no tool_response to
    // compact; still feed the failure streak so retry storms get nudged.
    if (tool === "Bash" && cfg.failureNudges.enabled) {
      const cmd = String(input.tool_input?.command ?? "");
      if (cmd) bumpFailureStreak(cmd);
      if (looksLikeTestCommand(cmd)) { state.lastTestsFailing = true; setTestStatus(cwd, true); }
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
      try { mtime = statSync(fp).mtimeMs; } catch { /* deleted between call and hook */ }
      const rec = state.reads[key];
      if (!rec) progress = true; // new information
      // A changed file is NEW content — restart its duplicate count instead of
      // inheriting the escalation earned by a version that no longer exists.
      const count = rec && rec.mtime === mtime ? rec.count : 1;
      state.reads[key] = { count, t: Date.now(), mtime };
    }
  }

  if (tool === "Edit" || tool === "Write" || tool === "NotebookEdit") {
    progress = true;
    const fp = String(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? "");
    if (fp) {
      // invalidate this file's read records in EVERY scope (key = scope|fp|off|lim, scope is 8 hex chars)
      for (const key of Object.keys(state.reads)) {
        if (key.slice(9).startsWith(`${fp}|`)) delete state.reads[key];
      }
    }
  }

  if (tool === "Grep" || tool === "Glob") {
    // Novel discovery is progress; re-running an identical query is not.
    // pre-tool already pushed this call's hash, so "novel" = seen exactly once.
    const h = `${scope}:${hashCall(tool, input.tool_input)}`;
    if (state.calls.filter((x) => x === h).length <= 1) progress = true;
  }

  if (tool === "Bash") {
    const cmd = String(input.tool_input?.command ?? "");
    const resp = extractResponseText(input.tool_response);
    // Exit codes: 0 is success, ANY other number (including negative Windows
    // NTSTATUS crash codes) is failure; `> 0` classified segfaults as green.
    const ec = input.tool_response?.exit_code ?? input.tool_response?.code;
    const nonZero =
      (typeof ec === "number" && ec !== 0) ||
      input.tool_response?.is_error === true || input.tool_response?.interrupted === true;
    const text = resp?.text ?? "";

    // failure streaks → escalating corrective nudges
    if (cfg.failureNudges.enabled && cmd) {
      if (nonZero) {
        bumpFailureStreak(cmd);
      } else {
        if ((state.failures[normalizeCmd(cmd)] ?? 0) > 0) progress = true; // a previously failing command now works
        delete state.failures[normalizeCmd(cmd)];
      }
    }

    const isTest = looksLikeTestCommand(cmd);
    if (isTest) {
      // Update the test signal even when there's no output to compact —
      // a stale failing flag used to survive stderr-only green runs forever.
      const failing = isTestFailure(text, nonZero);
      state.lastTestsFailing = failing;
      setTestStatus(cwd, failing);
      if (!failing) progress = true;
    }

    if (text) {
      if (isTest && cfg.testCompaction.enabled) {
        applyCompaction(compactTestOutput(text, nonZero, overflowDir(cwd)), resp!.rebuild, "test");
      } else if (cfg.truncation.enabled) {
        applyCompaction(
          truncateGeneric(text, cfg.truncation.maxLines, cfg.truncation.maxChars, cfg.truncation.headLines, cfg.truncation.tailLines, overflowDir(cwd)),
          resp!.rebuild, "bash");
      }
    }
  }

  if ((tool === "WebFetch" || tool === "WebSearch") && cfg.truncation.enabled) {
    const resp = extractResponseText(input.tool_response);
    if (resp && resp.text) {
      // web results bloat research sessions the way build logs bloat coding ones
      applyCompaction(
        truncateGeneric(resp.text, cfg.truncation.maxLines * 2, cfg.truncation.maxChars * 2, cfg.truncation.headLines * 2, cfg.truncation.tailLines, overflowDir(cwd)),
        resp.rebuild, "web");
    }
    progress = true; // new external information
  }

  if (tool === "Agent" || tool === "Task") progress = true; // delegation moves work forward

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
