#!/usr/bin/env node

// src/lib/core.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, appendFileSync, statSync, openSync, readSync, closeSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
function readHookInput() {
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function emit(output) {
  try {
    process.stdout._handle?.setBlocking?.(true);
  } catch {
  }
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
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
  let cfg2 = DEFAULTS;
  for (const p of [join(yeschefHome(), "config.json"), join(cwd2, ".yeschef.json")]) {
    try {
      if (existsSync(p)) cfg2 = deepMerge(cfg2, JSON.parse(readFileSync(p, "utf8")));
    } catch {
    }
  }
  return cfg2;
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
var READS_CAP = 500;
function saveState(cwd2, sessionId2, s) {
  try {
    const keys = Object.keys(s.reads);
    if (keys.length > 0) {
      const now = Date.now();
      for (const k of keys) {
        if (now - s.reads[k].t > READS_RETENTION_MS) delete s.reads[k];
      }
      const remaining = Object.keys(s.reads);
      if (remaining.length > READS_CAP) {
        remaining.sort((a, b) => s.reads[a].t - s.reads[b].t).slice(0, remaining.length - READS_CAP).forEach((k) => delete s.reads[k]);
      }
    }
    const p = statePath(cwd2, sessionId2);
    const tmp = `${p}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(s));
    renameSync(tmp, p);
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
var USAGE_TAIL_BYTES = 262144;
function readUsage(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  let fd = -1;
  try {
    const size = statSync(transcriptPath).size;
    const start = Math.max(0, size - USAGE_TAIL_BYTES);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    fd = openSync(transcriptPath, "r");
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    const lines = buf.toString("utf8", 0, read).split("\n").filter(Boolean);
    const buckets = emptyBuckets();
    let model = null;
    let contextTokens = 0;
    let seen = false;
    for (const line of lines) {
      if (!line.includes('"usage"')) continue;
      try {
        const obj = JSON.parse(line);
        const u = obj?.message?.usage ?? obj?.usage;
        if (u && typeof u === "object") {
          seen = true;
          addUsage(buckets, u);
          model = obj?.message?.model ?? model;
          contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        }
      } catch {
      }
    }
    if (!seen) return null;
    return { contextTokens, buckets, model };
  } catch {
    return null;
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
      }
    }
  }
}
function estimateCostUSD(u, pricing = DEFAULTS.pricing) {
  return costOfBuckets(u.buckets, u.model, pricing);
}

// src/hooks/user-prompt.ts
var REMINDER = `[yeschef] Batch all independent discovery/read calls into ONE message. Reference earlier reads by file:line \u2014 never re-dump. Bulk exploration \u2192 scout subagent. Keep mcp__yeschef__notes current; check off finished plan items. Think \u226415 lines, then act.`;
var input = readHookInput();
var cwd = input.cwd ?? process.cwd();
var sessionId = input.session_id ?? "unknown";
var cfg = loadConfig(cwd);
try {
  const state = loadState(cwd, sessionId);
  state.turn += 1;
  state.stopBlocks = 0;
  saveState(cwd, sessionId, state);
  const parts = [];
  if (cfg.reminder.enabled) parts.push(REMINDER);
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
