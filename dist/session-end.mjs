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
  pricing: {
    models: { haiku: [1, 5], sonnet: [3, 15], fable: [10, 50], mythos: [10, 50], opus: [5, 25] },
    default: [5, 25],
    // unknown model → Opus-tier
    cacheReadMult: 0.1,
    cacheWriteMult: 1.25
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
  turn: 0
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
function priceFor(model, pricing = DEFAULTS.pricing) {
  const m = (model ?? "").toLowerCase();
  for (const [key, [inP2, outP2]] of Object.entries(pricing.models)) {
    if (m.includes(key)) return { in: inP2, out: outP2 };
  }
  const [inP, outP] = pricing.default;
  return { in: inP, out: outP };
}
function costOfBuckets(b, model, pricing = DEFAULTS.pricing) {
  const { in: rIn, out: rOut } = priceFor(model, pricing);
  return (b.inTok * rIn + b.cacheRead * rIn * pricing.cacheReadMult + b.cacheWrite * rIn * pricing.cacheWriteMult + b.out * rOut) / 1e6;
}
var emptyBuckets = () => ({ inTok: 0, cacheRead: 0, cacheWrite: 0, out: 0 });
function addUsage(b, u) {
  b.inTok += u.input_tokens ?? 0;
  b.cacheRead += u.cache_read_input_tokens ?? 0;
  b.cacheWrite += u.cache_creation_input_tokens ?? 0;
  b.out += u.output_tokens ?? 0;
}
function scanUsageInto(filePath, models) {
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
    const main = scanUsageInto(transcriptPath, models);
    let seen = main.seen;
    const subDir = join(transcriptPath.replace(/\.jsonl$/i, ""), "subagents");
    if (existsSync(subDir)) {
      for (const f of readdirSync(subDir)) {
        if (!f.endsWith(".jsonl")) continue;
        try {
          if (scanUsageInto(join(subDir, f), models).seen) seen = true;
        } catch {
        }
      }
    }
    if (!seen) return null;
    return { models, contextTokensLast: main.contextTokensLast };
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
      estCostUSD,
      perModel
    });
  }
} catch {
}
emitNothing();
