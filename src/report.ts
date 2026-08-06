// CLI for /yeschef:report — aggregates the telemetry JSONL for this project.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { yeschefHome, projectSlug, loadConfig } from "./lib/core.js";

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const cfg = loadConfig(cwd);
const logPath = join(yeschefHome(), "logs", `${projectSlug(cwd)}.jsonl`);

if (!existsSync(logPath)) {
  console.log(`No telemetry yet for this project (expected at ${logPath}).`);
  process.exit(0);
}

interface Tally {
  sessions: Set<string>;
  loopsBlocked: number;
  loopTools: Record<string, number>;   // which tools drove loops
  dupReadsBlocked: number;
  dupReadFiles: Record<string, number>; // which files got re-read
  compacted: number;
  savedChars: number;
  compactByKind: Record<string, { n: number; chars: number }>; // Bash / Read / run_tests …
  ctxCompactions: number;              // pre/post-compact (whole-context compaction events)
  digestOps: number;                   // discovery ops collapsed into batch_digest calls
  digestCalls: number;
  paralysis: number;
  stopBlocks: number;
  stopBlocksRed: number;               // stops caught while tests were failing
  brigade: number;
  brigadeByAgent: Record<string, number>; // scout / line-cook / expeditor / researcher
  estCost: number;
  costSessions: number;
  modelUsage: Record<string, { inTok: number; cacheRead: number; cacheWrite: number; out: number; turns: number; cost: number }>;
  modelCostSessions: number;           // cost sessions that carried a per-model breakdown
  turns: number;                       // summed across ended sessions
  turnSessions: number;
  ctxTokensLast: number | null;        // most recent session-end context size
  firstTs: number | null;
  lastTs: number | null;
}
const t: Tally = {
  sessions: new Set(), loopsBlocked: 0, loopTools: {}, dupReadsBlocked: 0, dupReadFiles: {},
  compacted: 0, savedChars: 0, compactByKind: {}, ctxCompactions: 0, digestOps: 0, digestCalls: 0,
  paralysis: 0, stopBlocks: 0, stopBlocksRed: 0, brigade: 0, brigadeByAgent: {},
  estCost: 0, costSessions: 0, modelUsage: {}, modelCostSessions: 0, turns: 0, turnSessions: 0, ctxTokensLast: null, firstTs: null, lastTs: null,
};

const bump = (m: Record<string, number>, k: string | undefined) => { if (k) m[k] = (m[k] ?? 0) + 1; };

const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean).slice(-5000);
let lastSession = "";
for (const line of lines) {
  let e: any;
  try { e = JSON.parse(line); } catch { continue; }
  const ts = e.ts ? Date.parse(e.ts) : NaN;
  if (!Number.isNaN(ts)) { if (t.firstTs === null || ts < t.firstTs) t.firstTs = ts; if (t.lastTs === null || ts > t.lastTs) t.lastTs = ts; }
  if (e.session && e.session !== "mcp") { t.sessions.add(e.session); lastSession = e.session; }
  switch (e.event) {
    case "loop-blocked": t.loopsBlocked++; bump(t.loopTools, e.tool); break;
    case "dup-read-blocked": t.dupReadsBlocked++; bump(t.dupReadFiles, e.file); break;
    case "compacted": {
      t.compacted++; t.savedChars += e.savedChars ?? 0;
      const k = t.compactByKind[e.kind ?? "other"] ?? (t.compactByKind[e.kind ?? "other"] = { n: 0, chars: 0 });
      k.n++; k.chars += e.savedChars ?? 0; break;
    }
    case "run-tests": {
      t.compacted++; t.savedChars += e.savedChars ?? 0; // MCP run_tests compaction — was invisible to the report
      const k = t.compactByKind["run_tests"] ?? (t.compactByKind["run_tests"] = { n: 0, chars: 0 });
      k.n++; k.chars += e.savedChars ?? 0; break;
    }
    case "batch-digest": t.digestCalls++; t.digestOps += e.ops ?? 0; break;
    case "pre-compact": case "post-compact": t.ctxCompactions++; break;
    case "paralysis-tripped": t.paralysis++; break;
    case "stop-blocked": t.stopBlocks++; if (e.testsFailing) t.stopBlocksRed++; break;
    case "subagentstop": t.brigade++; bump(t.brigadeByAgent, e.agent); break;
    case "session-end":
      if (typeof e.estCostUSD === "number") { t.estCost += e.estCostUSD; t.costSessions++; }
      if (e.perModel && typeof e.perModel === "object") {
        t.modelCostSessions++;
        for (const [model, mu] of Object.entries<any>(e.perModel)) {
          const g = t.modelUsage[model] ?? (t.modelUsage[model] = { inTok: 0, cacheRead: 0, cacheWrite: 0, out: 0, turns: 0, cost: 0 });
          g.inTok += mu.inTok ?? 0; g.cacheRead += mu.cacheRead ?? 0; g.cacheWrite += mu.cacheWrite ?? 0;
          g.out += mu.out ?? 0; g.turns += mu.turns ?? 0; g.cost += mu.costUSD ?? 0;
        }
      }
      if (typeof e.turns === "number") { t.turns += e.turns; t.turnSessions++; }
      if (typeof e.contextTokens === "number") t.ctxTokensLast = e.contextTokens;
      break;
  }
}

// pre/post-compact fire as a pair per compaction event; report the pair count.
t.ctxCompactions = Math.ceil(t.ctxCompactions / 2);

const estTokens = Math.round(t.savedChars / 4);
const num = (n: number) => n.toLocaleString();
// Render a "detail" breakdown as a compact ranked list, top few only.
const top = (m: Record<string, number>, n = 3) =>
  Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(", ");
const fmtSpan = (ms: number) => {
  const days = ms / 86_400_000;
  if (days >= 1) return `${days.toFixed(days >= 10 ? 0 : 1)} days`;
  const hrs = ms / 3_600_000;
  if (hrs >= 1) return `${hrs.toFixed(1)} hours`;
  return `${Math.max(1, Math.round(ms / 60_000))} min`;
};

console.log(`YesChef kitchen report — project: ${cwd}`);
let range = "";
if (t.firstTs !== null && t.lastTs !== null && t.lastTs > t.firstTs) {
  range = `, spanning ${fmtSpan(t.lastTs - t.firstTs)} (${new Date(t.firstTs).toISOString().slice(0, 10)} → ${new Date(t.lastTs).toISOString().slice(0, 10)})`;
}
console.log(`log: ${logPath} (last ${lines.length} events, ${t.sessions.size} session(s)${range})`);
console.log("");

console.log(`tool results compacted : ${t.compacted}  (~${num(t.savedChars)} chars ≈ ${num(estTokens)} tokens kept OUT of context)`);
if (t.compacted > 0) {
  console.log(`  avg ${num(Math.round(t.savedChars / t.compacted))} chars/compaction` + (Object.keys(t.compactByKind).length ? `  ·  by kind: ${top(Object.fromEntries(Object.entries(t.compactByKind).map(([k, v]) => [`${k}(${num(Math.round(v.chars / 4))}tok)`, v.n])))}` : ""));
}
if (t.digestCalls > 0) console.log(`batch_digest discovery  : ${t.digestOps} ops across ${t.digestCalls} call(s) (${(t.digestOps / t.digestCalls).toFixed(1)} ops/call collapsed into one result)`);
if (t.ctxCompactions > 0) console.log(`context compactions     : ${t.ctxCompactions} (full-window auto-compact events)`);
console.log(`duplicate reads blocked: ${t.dupReadsBlocked}` + (Object.keys(t.dupReadFiles).length ? `  ·  hottest: ${top(t.dupReadFiles)}` : ""));
console.log(`loops blocked          : ${t.loopsBlocked}` + (Object.keys(t.loopTools).length ? `  ·  by tool: ${top(t.loopTools)}` : ""));
console.log(`paralysis aborts       : ${t.paralysis}`);
console.log(`premature stops caught : ${t.stopBlocks}` + (t.stopBlocksRed ? `  (${t.stopBlocksRed} with tests still failing)` : ""));
console.log(`brigade runs finished  : ${t.brigade}` + (Object.keys(t.brigadeByAgent).length ? `  ·  ${top(t.brigadeByAgent, 4)}` : ""));
if (t.turnSessions > 0) console.log(`turns (last ${t.turnSessions} ended session(s)): ${num(t.turns)} total, ${(t.turns / t.turnSessions).toFixed(1)} avg/session`);
if (t.costSessions > 0) {
  console.log(`est. cost (last ${t.costSessions} ended session(s)): $${t.estCost.toFixed(2)} total, $${(t.estCost / t.costSessions).toFixed(2)} avg/session — estimate, not billing data`);
}
const modelRows = Object.entries(t.modelUsage).sort((a, b) => b[1].cost - a[1].cost);
if (modelRows.length) {
  const totalCost = modelRows.reduce((s, [, v]) => s + v.cost, 0) || 1;
  console.log(`cost by model (cache-aware estimate):`);
  for (const [model, v] of modelRows) {
    const ctx = v.inTok + v.cacheRead + v.cacheWrite;
    console.log(`  ${model.padEnd(20)} $${v.cost.toFixed(2)}  (${Math.round((v.cost / totalCost) * 100)}%)  ·  ${num(ctx)} in+cache / ${num(v.out)} out tok · ${v.turns} turns`);
  }
  console.log(`  cache reads priced ~${cfg.pricing.cacheReadMult}×, writes ~${cfg.pricing.cacheWriteMult}× of base input; brigade (subagent) models included.`);
}
if (t.costSessions > t.modelCostSessions) {
  const gap = t.costSessions - t.modelCostSessions;
  console.log(`  note: ${gap} earlier cost session(s) predate per-model tracking — counted in the total above, not broken down by model.`);
}
if (t.ctxTokensLast) console.log(`latest session context : ~${num(t.ctxTokensLast)} tokens`);
console.log("");
console.log(`note: context tokens avoided compound — every chunk kept out is NOT resent on every later turn.`);
if (lastSession) console.log(`current/latest session id: ${lastSession}`);
