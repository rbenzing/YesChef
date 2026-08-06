// PreCompact + PostCompact (one entry, dispatched on hook_event_name):
// after compaction, earlier file reads may no longer be in context, so the
// duplicate-read guard must reset; the mise notes summary gets re-seeded.
import { readHookInput, emit, emitNothing, loadConfig, loadState, saveState, logEvent } from "../lib/core.js";
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
  saveState(cwd, sessionId, state);
  if (cfg.telemetry.enabled) logEvent(cwd, sessionId, "post-compact", {});

  const summary = notesSummary(cwd);
  if (summary) {
    emit({
      hookSpecificOutput: {
        hookEventName: event || "PostCompact",
        additionalContext: `[yeschef] context was compacted. Your mise en place survives:\n${summary}\nFull notes: mcp__yeschef__notes(action:"read").`,
      },
    });
  }
  emitNothing();
} catch {
  emitNothing();
}
