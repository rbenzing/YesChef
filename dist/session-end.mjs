#!/usr/bin/env node

// src/hooks/session-end.ts
import { readdirSync as readdirSync2, statSync as statSync2, unlinkSync } from "node:fs";
import { join as join2 } from "node:path";

// src/lib/core.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, appendFileSync, statSync, openSync, readSync, closeSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
function readHookInput() {
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
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
  let cfg = DEFAULTS;
  for (const p of [join(yeschefHome(), "config.json"), join(cwd2, ".yeschef.json")]) {
    try {
      if (existsSync(p)) cfg = deepMerge(cfg, JSON.parse(readFileSync(p, "utf8")));
    } catch {
    }
  }
  return cfg;
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
function logEvent(cwd2, sessionId2, event, data = {}) {
  try {
    const dir = ensureDir(join(yeschefHome(), "logs"));
    const line = JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), session: sessionId2, event, ...data });
    appendFileSync(join(dir, `${projectSlug(cwd2)}.jsonl`), line + "\n");
  } catch {
  }
}
function isTopTierModel(model) {
  const m = (model ?? "").toLowerCase();
  if (!m) return true;
  return !/haiku|sonnet/.test(m);
}
var emptyTiers = () => ({ topMain: 0, topSide: 0, cheapMain: 0, cheapSide: 0 });
function matchBySubstring(model, table) {
  const m = (model ?? "").toLowerCase();
  for (const key of Object.keys(table).sort((a, b) => b.length - a.length)) {
    if (m.includes(key)) return table[key];
  }
  return void 0;
}
function priceFor(model, pricing = DEFAULTS.pricing) {
  const [inP, outP] = matchBySubstring(model, pricing.models) ?? pricing.default;
  return { in: inP, out: outP };
}
function cacheReadMultFor(model, pricing = DEFAULTS.pricing) {
  return matchBySubstring(model, pricing.cacheReadMultByModel ?? {}) ?? pricing.cacheReadMult;
}
function costOfBuckets(b, model, pricing = DEFAULTS.pricing) {
  const { in: rIn, out: rOut } = priceFor(model, pricing);
  const write1h = Math.min(b.cacheWrite1h ?? 0, b.cacheWrite);
  const write5m = b.cacheWrite - write1h;
  return (b.inTok * rIn + b.cacheRead * rIn * cacheReadMultFor(model, pricing) + write5m * rIn * pricing.cacheWriteMult + write1h * rIn * (pricing.cacheWrite1hMult ?? pricing.cacheWriteMult) + b.out * rOut) / 1e6;
}
var emptyBuckets = () => ({ inTok: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, out: 0 });
function addUsage(b, u) {
  b.inTok += u.input_tokens ?? 0;
  b.cacheRead += u.cache_read_input_tokens ?? 0;
  b.cacheWrite += u.cache_creation_input_tokens ?? 0;
  b.cacheWrite1h = (b.cacheWrite1h ?? 0) + (u.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  b.out += u.output_tokens ?? 0;
}
function scanUsageInto(filePath, models, tiers, fromSubagentFile) {
  let seen = false;
  let contextTokensLast = null;
  const lines = readFileSync(filePath, "utf8").split("\n");
  for (const line of lines) {
    if (!line.includes('"usage"')) continue;
    try {
      const obj = JSON.parse(line);
      const u = obj?.message?.usage ?? obj?.usage;
      if (u && typeof u === "object") {
        seen = true;
        const model = obj?.message?.model ?? obj?.model ?? "unknown";
        const mu = models[model] ?? (models[model] = { ...emptyBuckets(), turns: 0 });
        addUsage(mu, u);
        mu.turns++;
        const tok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
        const side = obj?.isSidechain === true || fromSubagentFile;
        if (isTopTierModel(model)) {
          if (side) tiers.topSide += tok;
          else tiers.topMain += tok;
        } else {
          if (side) tiers.cheapSide += tok;
          else tiers.cheapMain += tok;
        }
        contextTokensLast = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      }
    } catch {
    }
  }
  return { seen, contextTokensLast };
}
function readUsageByModel(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  try {
    const models = {};
    const tiers = emptyTiers();
    const main = scanUsageInto(transcriptPath, models, tiers, false);
    let seen = main.seen;
    const subDir = join(transcriptPath.replace(/\.jsonl$/i, ""), "subagents");
    if (existsSync(subDir)) {
      for (const f of readdirSync(subDir)) {
        if (!f.endsWith(".jsonl")) continue;
        try {
          if (scanUsageInto(join(subDir, f), models, tiers, true).seen) seen = true;
        } catch {
        }
      }
    }
    if (!seen) return null;
    return { models, contextTokensLast: main.contextTokensLast, tiers };
  } catch {
    return null;
  }
}

// src/hooks/session-end.ts
var OVERFLOW_RETENTION_MS = 7 * 24 * 36e5;
var input = readHookInput();
var cwd = input.cwd ?? process.cwd();
var sessionId = input.session_id ?? "unknown";
try {
  const dir = overflowDir(cwd);
  const now = Date.now();
  for (const f of readdirSync2(dir)) {
    try {
      if (now - statSync2(join2(dir, f)).mtimeMs > OVERFLOW_RETENTION_MS) unlinkSync(join2(dir, f));
    } catch {
    }
  }
} catch {
}
try {
  const cfg = loadConfig(cwd);
  if (cfg.telemetry.enabled) {
    const state = loadState(cwd, sessionId);
    const usage = readUsageByModel(input.transcript_path);
    let perModel = null;
    let estCostUSD = null;
    if (usage) {
      perModel = {};
      let total = 0;
      for (const [model, mu] of Object.entries(usage.models)) {
        const cost = costOfBuckets(mu, model, cfg.pricing);
        total += cost;
        perModel[model] = {
          inTok: mu.inTok,
          cacheRead: mu.cacheRead,
          cacheWrite: mu.cacheWrite,
          cacheWrite1h: mu.cacheWrite1h ?? 0,
          out: mu.out,
          turns: mu.turns,
          costUSD: Number(cost.toFixed(4))
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
      tiers: usage?.tiers ?? null,
      // BouzeCode's metric: top-tier vs delegated tokens
      estCostUSD,
      perModel
    });
  }
} catch {
}
emitNothing();
