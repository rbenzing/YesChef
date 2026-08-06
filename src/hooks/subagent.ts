// SubagentStart/SubagentStop: brigade activity counters for the statusline & report.
import { readHookInput, emitNothing, loadState, saveState, loadConfig, logEvent } from "../lib/core.js";

const input = readHookInput();
const cwd = input.cwd ?? process.cwd();
const sessionId = input.session_id ?? "unknown";

try {
  const state = loadState(cwd, sessionId);
  if ((input.hook_event_name ?? "") === "SubagentStart") {
    state.brigade.active += 1;
  } else {
    state.brigade.active = Math.max(0, state.brigade.active - 1);
    state.brigade.finished += 1;
    state.progresslessCalls = 0; // a finished delegation is progress
    state.paralysisTripped = false; // …and progress un-trips paralysis (as post-tool does), re-arming the stop guard
  }
  saveState(cwd, sessionId, state);
  if (loadConfig(cwd).telemetry.enabled) {
    logEvent(cwd, sessionId, (input.hook_event_name ?? "subagent").toLowerCase(), { agent: input.agent_type ?? input.subagent_type ?? "unknown" });
  }
} catch { /* counters only */ }
emitNothing();
