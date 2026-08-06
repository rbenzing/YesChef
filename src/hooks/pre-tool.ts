// PreToolUse: the two hard guardrails — loop detection (BouzéCode's MD5-batch
// cycle detector, adapted) and the duplicate-read guard. Guardrail philosophy:
// deny only clear waste, always teach the cheaper alternative, honor the dials.
import { statSync } from "node:fs";
import { readHookInput, emit, emitNothing, loadConfig, loadState, saveState, hashCall, contextScope, logEvent } from "../lib/core.js";
import { detectLoop, pushCall, LOOP_WARNING } from "../lib/loop.js";

const input = readHookInput();
const cwd = input.cwd ?? process.cwd();
const sessionId = input.session_id ?? "unknown";
const tool = input.tool_name ?? "";
const cfg = loadConfig(cwd);
// Guard ledgers are per-context: a subagent's reads/loops must not count
// against the parent conversation's (and vice versa).
const scope = contextScope(input.transcript_path);

function deny(reason: string): never {
  emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
}
function warn(context: string): never {
  emit({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: context } });
}

try {
  const state = loadState(cwd, sessionId);

  // ---- loop guard ----
  if (cfg.enforcement.loopGuard !== "off") {
    const h = `${scope}:${hashCall(tool, input.tool_input)}`;
    const verdict = detectLoop(state.calls, h, cfg.loop.maxCycleSize, cfg.loop.repeatsToBlock);
    state.calls = pushCall(state.calls, h, cfg.loop.windowSize);
    if (verdict.looping) {
      state.blocked.loops += 1;
      saveState(cwd, sessionId, state);
      if (cfg.telemetry.enabled) logEvent(cwd, sessionId, "loop-blocked", { tool, cycleSize: verdict.cycleSize });
      if (cfg.enforcement.loopGuard === "block") deny(LOOP_WARNING(verdict.cycleSize, verdict.repeats));
      warn(LOOP_WARNING(verdict.cycleSize, verdict.repeats));
    }
  }

  // ---- duplicate-read guard ----
  if (tool === "Read" && cfg.enforcement.duplicateReadGuard !== "off") {
    const fp = String(input.tool_input?.file_path ?? "");
    if (fp) {
      const key = `${scope}|${fp}|${input.tool_input?.offset ?? 0}|${input.tool_input?.limit ?? 0}`;
      const rec = state.reads[key];
      let mtime = 0;
      try { mtime = statSync(fp).mtimeMs; } catch { /* missing file: let Read produce its own error */ }
      const fresh = !rec || rec.mtime !== mtime || Date.now() - rec.t > cfg.duplicateRead.ttlMinutes * 60000;
      if (fresh && rec) delete state.reads[key]; // changed/expired: the old escalation count no longer applies
      if (!fresh) {
        const count = rec.count + 1;
        state.reads[key] = { count, t: Date.now(), mtime };
        const msg =
          `[yeschef] duplicate read #${count} of ${fp} — the file has NOT changed since you read it. ` +
          `Its content is already in context (or summarized in your notes). Reference it by file:line. ` +
          `If you genuinely need a fragment again, read a narrow range (offset/limit) or use mcp__yeschef__batch_digest.`;
        if (count >= cfg.duplicateRead.blockOn && cfg.enforcement.duplicateReadGuard === "block") {
          state.blocked.dupReads += 1;
          saveState(cwd, sessionId, state);
          if (cfg.telemetry.enabled) logEvent(cwd, sessionId, "dup-read-blocked", { file: fp, count });
          deny(msg);
        }
        if (count >= cfg.duplicateRead.warnOn) {
          saveState(cwd, sessionId, state);
          warn(msg);
        }
      }
    }
  }

  saveState(cwd, sessionId, state);
  emitNothing();
} catch {
  emitNothing(); // a broken guard must never block real work
}
