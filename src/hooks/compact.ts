// PreCompact + PostCompact (one entry, dispatched on hook_event_name):
// after compaction, earlier file reads may no longer be in context, so the
// duplicate-read guard must reset.
//
// NOTE: Claude Code's hook-output schema accepts NO hookSpecificOutput for
// compact events — hookEventName "PostCompact" fails validation (confirmed
// empirically 2026-09; only PreToolUse/UserPromptSubmit/PostToolUse/
// PostToolBatch/Stop variants carry additionalContext). So the mise-notes
// recovery is NOT emitted here: we set state.compactRecoveryPending and the
// next PostToolUse or UserPromptSubmit hook relays it, whichever fires first.
import { readHookInput, emitNothing, loadConfig, loadState, saveState, logEvent } from "../lib/core.js";
import { notesSummary, maybeCompact } from "../lib/notes.js";

const input = readHookInput();
const cwd = input.cwd ?? process.cwd();
const sessionId = input.session_id ?? "unknown";
const cfg = loadConfig(cwd);

try {
  const event = input.hook_event_name ?? "";
  if (event === "PreCompact") {
    // housekeeping moment: structurally compact our own notes too
    const saved = maybeCompact(cwd, cfg.notes.compactAtChars);
    if (cfg.telemetry.enabled) logEvent(cwd, sessionId, "pre-compact", { notesCharsSaved: saved });
    emitNothing();
  }

  // PostCompact: read-dedup records describe a context that no longer exists
  const state = loadState(cwd, sessionId);
  state.reads = {};
  state.calls = [];
  // Flag the re-seed for the relay hooks only when there are notes worth
  // re-seeding; the relay regenerates the summary at emit time.
  if (notesSummary(cwd)) state.compactRecoveryPending = true;
  saveState(cwd, sessionId, state);
  if (cfg.telemetry.enabled) logEvent(cwd, sessionId, "post-compact", {});
  emitNothing();
} catch {
  emitNothing();
}
