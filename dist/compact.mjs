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
function logEvent(cwd2, sessionId2, event, data = {}) {
  try {
    const dir = ensureDir(join(yeschefHome(), "logs"));
    const line = JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), session: sessionId2, event, ...data });
    appendFileSync(join(dir, `${projectSlug(cwd2)}.jsonl`), line + "\n");
  } catch {
  }
}

// src/lib/notes.ts
import { readFileSync as readFileSync2, writeFileSync as writeFileSync2, existsSync as existsSync2 } from "node:fs";
import { join as join2 } from "node:path";
var SECTIONS = ["goal", "plan", "discoveries", "decisions"];
var KITCHEN_ID = "kitchen";
var SECTION_HEADER_RE = /^##\s+(\w+)/;
function notesPath(cwd2) {
  return join2(ensureDir(stateDir(cwd2)), `notes-${KITCHEN_ID}.md`);
}
var TEMPLATE = `# Mise en place
## goal
(unset \u2014 write one sentence)
## plan
## discoveries
## decisions
`;
function readNotes(cwd2) {
  const p = notesPath(cwd2);
  if (!existsSync2(p)) return TEMPLATE;
  try {
    return readFileSync2(p, "utf8");
  } catch {
    return TEMPLATE;
  }
}
function writeNotes(cwd2, text) {
  writeFileSync2(notesPath(cwd2), text);
}
function splitSections(text) {
  const out = /* @__PURE__ */ Object.create(null);
  let current = "_preamble";
  out[current] = [];
  for (const line of text.split("\n")) {
    const m = line.match(SECTION_HEADER_RE);
    if (m) {
      current = m[1].toLowerCase();
      out[current] = out[current] ?? [];
      continue;
    }
    out[current].push(line);
  }
  return out;
}
function joinSections(sections) {
  const lines = ["# Mise en place"];
  const preamble = (sections["_preamble"] ?? []).filter((l) => l.trim() && l.trim() !== "# Mise en place");
  lines.push(...preamble);
  for (const s of SECTIONS) {
    lines.push(`## ${s}`);
    const body = (sections[s] ?? []).filter((l, i, a) => !(l.trim() === "" && (a[i - 1] ?? "").trim() === ""));
    lines.push(...body);
  }
  for (const name of Object.keys(sections)) {
    if (name === "_preamble" || SECTIONS.includes(name)) continue;
    const body = (sections[name] ?? []).filter((l) => l.trim());
    if (body.length === 0) continue;
    lines.push(`## ${name}`);
    lines.push(...body);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}
function openPlanItems(text) {
  const sections = splitSections(text);
  return (sections["plan"] ?? []).filter((l) => /^\s*-\s*\[ \]/.test(l)).map((l) => l.replace(/^\s*-\s*\[ \]\s*/, "").trim());
}
function compactNotes(text) {
  const before = text.length;
  const sections = splitSections(text);
  for (const s of SECTIONS) {
    const seen = /* @__PURE__ */ new Set();
    sections[s] = (sections[s] ?? []).filter((l) => {
      const key = l.trim();
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  const plan = sections["plan"] ?? [];
  const done = plan.filter((l) => /^\s*-\s*\[x\]/i.test(l)).length;
  if (done > 0) {
    sections["plan"] = [`(${done} completed item${done > 1 ? "s" : ""} archived)`, ...plan.filter((l) => !/^\s*-\s*\[x\]/i.test(l))];
  }
  const disc = sections["discoveries"] ?? [];
  if (disc.length > 120) sections["discoveries"] = [`(${disc.length - 100} older discovery lines archived)`, ...disc.slice(-100)];
  const out = joinSections(sections);
  return { text: out, saved: Math.max(0, before - out.length) };
}
function maybeCompact(cwd2, threshold) {
  const text = readNotes(cwd2);
  if (text.length <= threshold) return 0;
  const { text: out, saved } = compactNotes(text);
  writeNotes(cwd2, out);
  return saved;
}
function notesSummary(cwd2, maxChars = 1200) {
  const text = readNotes(cwd2);
  const sections = splitSections(text);
  const goal = (sections["goal"] ?? []).map((l) => l.trim()).filter((l) => l && !l.startsWith("(unset")).join(" ");
  const open = openPlanItems(text);
  const disc = (sections["discoveries"] ?? []).map((l) => l.trim()).filter(Boolean).slice(-5);
  const parts = [
    goal ? `Goal: ${goal}` : "",
    open.length ? `Open plan items:
${open.slice(0, 8).map((i) => `- [ ] ${i}`).join("\n")}` : "",
    disc.length ? `Recent discoveries:
${disc.map((d) => `- ${d}`).join("\n")}` : ""
  ].filter(Boolean);
  return parts.join("\n").slice(0, maxChars);
}

// src/hooks/compact.ts
var input = readHookInput();
var cwd = input.cwd ?? process.cwd();
var sessionId = input.session_id ?? "unknown";
var cfg = loadConfig(cwd);
try {
  const event = input.hook_event_name ?? "";
  if (event === "PreCompact") {
    const saved = maybeCompact(cwd, cfg.notes.compactAtChars);
    if (cfg.telemetry.enabled) logEvent(cwd, sessionId, "pre-compact", { notesCharsSaved: saved });
    emitNothing();
  }
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
        additionalContext: `[yeschef] context was compacted. Your mise en place survives:
${summary}
Full notes: mcp__yeschef__notes(action:"read").`
      }
    });
  }
  emitNothing();
} catch {
  emitNothing();
}
