// SessionStart: BouzéCode's "seed placeholder" — the turn-1 injection that took
// methodology omission from 81.8% to 0%. House rules + folder digest + notes summary.
import { readHookInput, emit, emitNothing, loadConfig, logEvent } from "../lib/core.js";
import { getFolderDescription } from "../lib/folderdesc.js";
import { notesSummary } from "../lib/notes.js";

const HOUSE_RULES = `[yeschef] Kitchen open. House rules (token thrift + clean context):
1. BATCH: fire all independent Glob/Grep/Read calls as parallel tool_use blocks in ONE message. Target: Discover → Read → Act in 3 turns. The mcp__yeschef__batch_digest tool runs many discovery ops in a single call.
2. DELEGATE: bulk exploration goes to the 'scout' subagent (cheap model, returns a ≤40-line digest with file:line pointers). Parallel implementation goes to 'line-cook'. Verification goes to 'expeditor'.
3. NEVER RE-DUMP: reference earlier reads as file:line. Re-reading an unchanged file is blocked after repeated waste.
4. NOTES: keep goal/plan/discoveries in mcp__yeschef__notes (the mise en place). Check off plan items as you finish them — the stop guard reads this.
5. TESTS: run them via mcp__yeschef__run_tests (compacted output) instead of raw test commands when possible.
6. OUTPUT: think ≤15 lines, then act with tools. Final replies stay concise.`;

const input = readHookInput();
const cwd = input.cwd ?? process.cwd();
const sessionId = input.session_id ?? "unknown";
const cfg = loadConfig(cwd);

try {
  const parts = [HOUSE_RULES];
  try {
    parts.push("", getFolderDescription(cwd, 2));
  } catch { /* index unavailable — rules still land */ }
  const summary = notesSummary(cwd); // the shared kitchen notes — the only file the notes tool writes
  if (summary) parts.push("", `Mise en place (resumed notes):\n${summary}`);
  if (cfg.telemetry.enabled) logEvent(cwd, sessionId, "session-start", { source: input.source ?? "startup" });
  emit({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: parts.join("\n") },
  });
} catch {
  emitNothing();
}
