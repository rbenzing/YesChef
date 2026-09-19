#!/usr/bin/env node

// src/report.ts
import { readFileSync as readFileSync2, existsSync as existsSync2 } from "node:fs";
import { join as join2 } from "node:path";

// src/lib/core.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, appendFileSync, statSync, openSync, readSync, closeSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
function projectSlug(cwd2) {
  const clean = resolve(cwd2).replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return clean.slice(-80) || "root";
}
function yeschefHome() {
  return process.env.YESCHEF_HOME || join(homedir(), ".claude", "yeschef");
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
  let cfg2 = DEFAULTS;
  for (const p of [join(yeschefHome(), "config.json"), join(cwd2, ".yeschef.json")]) {
    try {
      if (existsSync(p)) cfg2 = deepMerge(cfg2, JSON.parse(readFileSync(p, "utf8")));
    } catch {
    }
  }
  return cfg2;
}
var READS_RETENTION_MS = 60 * 6e4;

// src/report.ts
var cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
var cfg = loadConfig(cwd);
var logPath = join2(yeschefHome(), "logs", `${projectSlug(cwd)}.jsonl`);
if (!existsSync2(logPath)) {
  console.log(`No telemetry yet for this project (expected at ${logPath}).`);
  process.exit(0);
}
var t = {
  sessions: /* @__PURE__ */ new Set(),
  loopsBlocked: 0,
  loopTools: {},
  dupReadsBlocked: 0,
  dupReadFiles: {},
  compacted: 0,
  savedChars: 0,
  compactByKind: {},
  ctxCompactions: 0,
  digestOps: 0,
  digestCalls: 0,
  paralysis: 0,
  stopBlocks: 0,
  stopBlocksRed: 0,
  brigade: 0,
  brigadeByAgent: {},
  estCost: 0,
  costSessions: 0,
  modelUsage: {},
  modelCostSessions: 0,
  turns: 0,
  turnSessions: 0,
  ctxTokensLast: null,
  firstTs: null,
  lastTs: null
};
var bump = (m, k) => {
  if (k) m[k] = (m[k] ?? 0) + 1;
};
var lines = readFileSync2(logPath, "utf8").split("\n").filter(Boolean).slice(-5e3);
var lastSession = "";
for (const line of lines) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  const ts = e.ts ? Date.parse(e.ts) : NaN;
  if (!Number.isNaN(ts)) {
    if (t.firstTs === null || ts < t.firstTs) t.firstTs = ts;
    if (t.lastTs === null || ts > t.lastTs) t.lastTs = ts;
  }
  if (e.session && e.session !== "mcp") {
    t.sessions.add(e.session);
    lastSession = e.session;
  }
  switch (e.event) {
    case "loop-blocked":
      t.loopsBlocked++;
      bump(t.loopTools, e.tool);
      break;
    case "dup-read-blocked":
      t.dupReadsBlocked++;
      bump(t.dupReadFiles, e.file);
      break;
    case "compacted": {
      t.compacted++;
      t.savedChars += e.savedChars ?? 0;
      const k = t.compactByKind[e.kind ?? "other"] ?? (t.compactByKind[e.kind ?? "other"] = { n: 0, chars: 0 });
      k.n++;
      k.chars += e.savedChars ?? 0;
      break;
    }
    case "run-tests": {
      t.compacted++;
      t.savedChars += e.savedChars ?? 0;
      const k = t.compactByKind["run_tests"] ?? (t.compactByKind["run_tests"] = { n: 0, chars: 0 });
      k.n++;
      k.chars += e.savedChars ?? 0;
      break;
    }
    case "batch-digest":
      t.digestCalls++;
      t.digestOps += e.ops ?? 0;
      break;
    case "pre-compact":
    case "post-compact":
      t.ctxCompactions++;
      break;
    case "paralysis-tripped":
      t.paralysis++;
      break;
    case "stop-blocked":
      t.stopBlocks++;
      if (e.testsFailing) t.stopBlocksRed++;
      break;
    case "subagentstop":
      t.brigade++;
      bump(t.brigadeByAgent, e.agent);
      break;
    case "session-end":
      if (typeof e.estCostUSD === "number") {
        t.estCost += e.estCostUSD;
        t.costSessions++;
      }
      if (e.perModel && typeof e.perModel === "object") {
        t.modelCostSessions++;
        for (const [model, mu] of Object.entries(e.perModel)) {
          const g = t.modelUsage[model] ?? (t.modelUsage[model] = { inTok: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, out: 0, turns: 0, cost: 0 });
          g.inTok += mu.inTok ?? 0;
          g.cacheRead += mu.cacheRead ?? 0;
          g.cacheWrite += mu.cacheWrite ?? 0;
          g.cacheWrite1h += mu.cacheWrite1h ?? 0;
          g.out += mu.out ?? 0;
          g.turns += mu.turns ?? 0;
          g.cost += mu.costUSD ?? 0;
        }
      }
      if (typeof e.turns === "number") {
        t.turns += e.turns;
        t.turnSessions++;
      }
      if (typeof e.contextTokens === "number") t.ctxTokensLast = e.contextTokens;
      break;
  }
}
t.ctxCompactions = Math.ceil(t.ctxCompactions / 2);
var estTokens = Math.round(t.savedChars / 4);
var num = (n) => n.toLocaleString();
var top = (m, n = 3) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(", ");
var fmtSpan = (ms) => {
  const days = ms / 864e5;
  if (days >= 1) return `${days.toFixed(days >= 10 ? 0 : 1)} days`;
  const hrs = ms / 36e5;
  if (hrs >= 1) return `${hrs.toFixed(1)} hours`;
  return `${Math.max(1, Math.round(ms / 6e4))} min`;
};
console.log(`YesChef kitchen report \u2014 project: ${cwd}`);
var range = "";
if (t.firstTs !== null && t.lastTs !== null && t.lastTs > t.firstTs) {
  range = `, spanning ${fmtSpan(t.lastTs - t.firstTs)} (${new Date(t.firstTs).toISOString().slice(0, 10)} \u2192 ${new Date(t.lastTs).toISOString().slice(0, 10)})`;
}
console.log(`log: ${logPath} (last ${lines.length} events, ${t.sessions.size} session(s)${range})`);
console.log("");
console.log(`tool results compacted : ${t.compacted}  (~${num(t.savedChars)} chars \u2248 ${num(estTokens)} tokens kept OUT of context)`);
if (t.compacted > 0) {
  console.log(`  avg ${num(Math.round(t.savedChars / t.compacted))} chars/compaction` + (Object.keys(t.compactByKind).length ? `  \xB7  by kind: ${top(Object.fromEntries(Object.entries(t.compactByKind).map(([k, v]) => [`${k}(${num(Math.round(v.chars / 4))}tok)`, v.n])))}` : ""));
}
if (t.digestCalls > 0) console.log(`batch_digest discovery  : ${t.digestOps} ops across ${t.digestCalls} call(s) (${(t.digestOps / t.digestCalls).toFixed(1)} ops/call collapsed into one result)`);
if (t.ctxCompactions > 0) console.log(`context compactions     : ${t.ctxCompactions} (full-window auto-compact events)`);
console.log(`duplicate reads blocked: ${t.dupReadsBlocked}` + (Object.keys(t.dupReadFiles).length ? `  \xB7  hottest: ${top(t.dupReadFiles)}` : ""));
console.log(`loops blocked          : ${t.loopsBlocked}` + (Object.keys(t.loopTools).length ? `  \xB7  by tool: ${top(t.loopTools)}` : ""));
console.log(`paralysis aborts       : ${t.paralysis}`);
console.log(`premature stops caught : ${t.stopBlocks}` + (t.stopBlocksRed ? `  (${t.stopBlocksRed} with tests still failing)` : ""));
console.log(`brigade runs finished  : ${t.brigade}` + (Object.keys(t.brigadeByAgent).length ? `  \xB7  ${top(t.brigadeByAgent, 4)}` : ""));
if (t.turnSessions > 0) console.log(`turns (last ${t.turnSessions} ended session(s)): ${num(t.turns)} total, ${(t.turns / t.turnSessions).toFixed(1)} avg/session`);
if (t.costSessions > 0) {
  console.log(`est. cost (last ${t.costSessions} ended session(s)): $${t.estCost.toFixed(2)} total, $${(t.estCost / t.costSessions).toFixed(2)} avg/session \u2014 estimate, not billing data`);
}
var modelRows = Object.entries(t.modelUsage).sort((a, b) => b[1].cost - a[1].cost);
if (modelRows.length) {
  const totalCost = modelRows.reduce((s, [, v]) => s + v.cost, 0) || 1;
  console.log(`cost by model (cache-aware estimate):`);
  for (const [model, v] of modelRows) {
    const ctx = v.inTok + v.cacheRead + v.cacheWrite;
    console.log(`  ${model.padEnd(20)} $${v.cost.toFixed(2)}  (${Math.round(v.cost / totalCost * 100)}%)  \xB7  ${num(ctx)} in+cache / ${num(v.out)} out tok \xB7 ${v.turns} turns`);
  }
  console.log(`  cache reads priced ${cfg.pricing.cacheReadMult}\xD7 of base input (0.025\xD7 on Fable/Mythos 5.1), writes ${cfg.pricing.cacheWriteMult}\xD7 (5m) / ${cfg.pricing.cacheWrite1hMult}\xD7 (1h); brigade (subagent) models included.`);
}
if (t.costSessions > t.modelCostSessions) {
  const gap = t.costSessions - t.modelCostSessions;
  console.log(`  note: ${gap} earlier cost session(s) predate per-model tracking \u2014 counted in the total above, not broken down by model.`);
}
if (t.ctxTokensLast) console.log(`latest session context : ~${num(t.ctxTokensLast)} tokens`);
console.log("");
console.log(`note: context tokens avoided compound \u2014 every chunk kept out is NOT resent on every later turn.`);
if (lastSession) console.log(`current/latest session id: ${lastSession}`);
