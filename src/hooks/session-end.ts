// SessionEnd: write the session's final tally into the telemetry log for /yeschef:report,
// and prune old overflow files (full copies of compacted outputs otherwise accumulate forever).
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readHookInput, emitNothing, loadState, loadConfig, logEvent, readUsageByModel, costOfBuckets, overflowDir } from "../lib/core.js";

const OVERFLOW_RETENTION_MS = 7 * 24 * 3600_000;

const input = readHookInput();
const cwd = input.cwd ?? process.cwd();
const sessionId = input.session_id ?? "unknown";

try {
  const dir = overflowDir(cwd);
  const now = Date.now();
  for (const f of readdirSync(dir)) {
    try { if (now - statSync(join(dir, f)).mtimeMs > OVERFLOW_RETENTION_MS) unlinkSync(join(dir, f)); } catch { /* in use */ }
  }
} catch { /* pruning is best-effort */ }

try {
  const cfg = loadConfig(cwd);
  if (cfg.telemetry.enabled) {
    const state = loadState(cwd, sessionId);
    const usage = readUsageByModel(input.transcript_path);
    let perModel: Record<string, any> | null = null;
    let estCostUSD: number | null = null;
    if (usage) {
      perModel = {};
      let total = 0;
      for (const [model, mu] of Object.entries(usage.models)) {
        const cost = costOfBuckets(mu, model, cfg.pricing);
        total += cost;
        perModel[model] = {
          inTok: mu.inTok, cacheRead: mu.cacheRead, cacheWrite: mu.cacheWrite,
          out: mu.out, turns: mu.turns, costUSD: Number(cost.toFixed(4)),
        };
      }
      estCostUSD = Number(total.toFixed(4));
    }
    logEvent(cwd, sessionId, "session-end", {
      turns: state.turn,
      blocked: state.blocked,
      compaction: state.compaction,
      brigade: state.brigade,
      contextTokens: usage?.contextTokensLast ?? null,
      estCostUSD,
      perModel,
    });
  }
} catch { /* telemetry only */ }
emitNothing();
