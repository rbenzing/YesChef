// UserPromptSubmit: BouzéCode's "bigctx-reminder" — ~70 fresh tokens, every turn,
// stable wording. Plus budget status and a stall hint when warranted.
import { readHookInput, emit, emitNothing, loadConfig, loadState, saveState, readUsage, estimateCostUSD } from "../lib/core.js";

const REMINDER =
  `[yeschef] Batch all independent discovery/read calls into ONE message. Reference earlier reads by file:line — never re-dump. ` +
  `Bulk exploration → scout subagent. Keep mcp__yeschef__notes current; check off finished plan items. Think ≤15 lines, then act.`;

const input = readHookInput();
const cwd = input.cwd ?? process.cwd();
const sessionId = input.session_id ?? "unknown";
const cfg = loadConfig(cwd);

try {
  const state = loadState(cwd, sessionId);
  state.turn += 1;
  // a fresh user prompt is new information — reset stall accounting
  state.stopBlocks = 0;
  saveState(cwd, sessionId, state);

  const parts: string[] = [];
  if (cfg.reminder.enabled) parts.push(REMINDER);

  // Coerce and validate: a string "5" from hand-edited JSON would crash .toFixed
  // (swallowed by the catch, silently killing the reminder too); usd <= 0 means off.
  const usd = Number(cfg.budget.usd);
  if (Number.isFinite(usd) && usd > 0) {
    const usage = readUsage(input.transcript_path);
    if (usage) {
      const est = estimateCostUSD(usage, cfg.pricing);
      const frac = est / usd;
      if (frac >= cfg.budget.wrapUpAt) {
        parts.push(`[yeschef] BUDGET: ~$${est.toFixed(2)} of $${usd.toFixed(2)} (${Math.round(frac * 100)}%, estimated). Wrap up now: finish the current step only, update notes with a handoff, and stop.`);
      } else if (frac >= cfg.budget.warnAt) {
        parts.push(`[yeschef] budget: ~$${est.toFixed(2)} of $${usd.toFixed(2)} (${Math.round(frac * 100)}%, estimated). Prioritize the remaining plan items; defer nice-to-haves.`);
      }
    }
  }

  if (cfg.paralysis.enabled && state.progresslessCalls >= Math.floor(cfg.paralysis.progresslessToolCalls * 0.75) && !state.paralysisTripped) {
    parts.push(`[yeschef] stall warning: ${state.progresslessCalls} tool calls without progress (no edits, no new reads, no passing tests). State the blocker in notes and change approach.`);
  }

  if (parts.length === 0) emitNothing();
  emit({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: parts.join("\n") } });
} catch {
  emitNothing();
}
