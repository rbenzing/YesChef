// Stop: the don't-stop-early guard. Blocks a premature stop when the mise notes
// still list open plan items or the last test run was failing — unless paralysis
// tripped (then stopping IS the right move) or we already blocked twice.
import { readHookInput, emit, emitNothing, loadConfig, loadState, saveState, logEvent, getTestStatus } from "../lib/core.js";
import { readNotes, openPlanItems } from "../lib/notes.js";

// Only a recent red run should block a stop — a stale flag from a long-dead
// session must not hold every later session hostage.
const TEST_STATUS_MAX_AGE_MS = 6 * 3600_000;

const input = readHookInput();
const cwd = input.cwd ?? process.cwd();
const sessionId = input.session_id ?? "unknown";
const cfg = loadConfig(cwd);

try {
  const state = loadState(cwd, sessionId);

  const allowStop = (reason?: string): never => {
    state.stopBlocks = 0;
    saveState(cwd, sessionId, state);
    if (reason && cfg.telemetry.enabled) logEvent(cwd, sessionId, "stop-allowed", { reason });
    emitNothing();
  };

  if (cfg.enforcement.stopGuard === "off") allowStop("dial-off");
  if (input.stop_hook_active === true) allowStop("already-blocked-this-cycle");
  if (state.paralysisTripped) allowStop("paralysis"); // graceful stop + report beats burning tokens
  if (state.stopBlocks >= cfg.stop.maxConsecutiveBlocks) allowStop("max-blocks-reached");

  const open = openPlanItems(readNotes(cwd));
  const reasons: string[] = [];
  if (open.length > 0) {
    reasons.push(`Open plan items in your mise notes:\n${open.slice(0, 5).map((i) => `- [ ] ${i}`).join("\n")}${open.length > 5 ? `\n  …and ${open.length - 5} more` : ""}`);
  }
  // Project-level marker written by BOTH test paths (raw Bash via post-tool AND
  // mcp run_tests) — per-session state alone was blind to the recommended path.
  const tests = getTestStatus(cwd, TEST_STATUS_MAX_AGE_MS);
  if (tests?.failing) {
    reasons.push("The last test run was FAILING.");
  }

  if (reasons.length > 0) {
    state.stopBlocks += 1;
    saveState(cwd, sessionId, state);
    if (cfg.telemetry.enabled) logEvent(cwd, sessionId, "stop-blocked", { openItems: open.length, testsFailing: tests?.failing ?? false });
    const msg =
      `[yeschef] Service isn't finished:\n${reasons.join("\n")}\n` +
      `Keep cooking: complete the next open item, or — if an item is genuinely done or obsolete — check it off / remove it via mcp__yeschef__notes and explain. ` +
      `If you are truly blocked, say exactly what's blocking you.`;
    if (cfg.enforcement.stopGuard === "block") emit({ decision: "block", reason: msg });
    emit({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: msg } }); // warn mode
  }

  allowStop();
} catch {
  emitNothing();
}
