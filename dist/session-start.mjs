#!/usr/bin/env node

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
var READS_RETENTION_MS = 60 * 6e4;
var WALK_IGNORE = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".pytest_cache",
  ".mypy_cache",
  "coverage",
  ".idea",
  ".vscode",
  "bin",
  "obj",
  ".gradle",
  ".terraform",
  "vendor",
  ".yeschef"
]);
var WALK_DOT_ALLOW = /* @__PURE__ */ new Set([".github", ".claude", ".claude-plugin"]);
function logEvent(cwd2, sessionId2, event, data = {}) {
  try {
    const dir = ensureDir(join(yeschefHome(), "logs"));
    const line = JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), session: sessionId2, event, ...data });
    appendFileSync(join(dir, `${projectSlug(cwd2)}.jsonl`), line + "\n");
  } catch {
  }
}

// src/lib/folderdesc.ts
import { readdirSync as readdirSync2, readFileSync as readFileSync2, statSync as statSync2, existsSync as existsSync2, writeFileSync as writeFileSync2, mkdirSync as mkdirSync2 } from "node:fs";
import { join as join2, extname, basename } from "node:path";
var KEY_FILES = /^(package\.json|pyproject\.toml|setup\.py|cargo\.toml|go\.mod|pom\.xml|build\.gradle|.*\.csproj|.*\.sln|makefile|dockerfile|docker-compose\.ya?ml|readme\.md|claude\.md|index\.[tj]sx?|main\.[a-z]+|app\.[a-z]+|__init__\.py|mod\.rs|schema\.(sql|prisma|graphql))$/i;
function annotate(dir, entries) {
  const notes = [];
  if (entries.some((e) => /^package\.json$/i.test(e))) {
    try {
      const pkg = JSON.parse(readFileSync2(join2(dir, "package.json"), "utf8"));
      if (pkg.name) notes.push(`npm:${pkg.name}`);
      if (pkg.description) notes.push(String(pkg.description).slice(0, 70));
    } catch {
    }
  } else if (entries.some((e) => /^readme\.md$/i.test(e))) {
    try {
      const first = readFileSync2(join2(dir, entries.find((e) => /^readme\.md$/i.test(e))), "utf8").split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find((l) => l.length > 8);
      if (first) notes.push(first.slice(0, 80));
    } catch {
    }
  }
  if (entries.some((e) => /(^|\.)(test|spec)s?\./i.test(e) || /^(tests?|__tests__|specs?)$/i.test(e))) notes.push("tests");
  return notes.join(" \u2014 ");
}
function walk(root, rel, depth, maxDepth, acc, budget) {
  if (depth > maxDepth || budget.dirs <= 0) return;
  const abs = join2(root, rel);
  let entries;
  try {
    entries = readdirSync2(abs);
  } catch {
    return;
  }
  budget.dirs--;
  const sum = { path: rel || ".", files: 0, dirs: 0, exts: {}, note: "", keyFiles: [] };
  const subdirs = [];
  for (const e of entries) {
    if (e.startsWith(".") && !WALK_DOT_ALLOW.has(e)) continue;
    if (WALK_IGNORE.has(e)) continue;
    let st;
    try {
      st = statSync2(join2(abs, e));
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      sum.dirs++;
      subdirs.push(e);
    } else {
      sum.files++;
      const ext = extname(e).toLowerCase() || basename(e);
      sum.exts[ext] = (sum.exts[ext] ?? 0) + 1;
      if (KEY_FILES.test(e) && sum.keyFiles.length < 6) sum.keyFiles.push(e);
    }
  }
  sum.note = annotate(abs, entries);
  acc.push(sum);
  for (const d of subdirs) walk(root, rel ? `${rel}/${d}` : d, depth + 1, maxDepth, acc, budget);
}
function buildFolderDescription(root, maxDepth = 3, maxChars = 4500) {
  const acc = [];
  walk(root, "", 0, maxDepth, acc, { dirs: 400 });
  const lines = [`Folder description of ${root} (depth ${maxDepth}, generated by yeschef \u2014 cheap, trust it before exploring):`];
  for (const d of acc) {
    const ext = Object.entries(d.exts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([e, n]) => `${n}${e.startsWith(".") ? e : " " + e}`).join(", ");
    const bits = [
      `${d.path}/`,
      `${d.files}f${d.dirs ? `,${d.dirs}d` : ""}`,
      ext,
      d.keyFiles.length ? `key: ${d.keyFiles.join(" ")}` : "",
      d.note
    ].filter(Boolean);
    lines.push("  " + bits.join(" \xB7 "));
    if (lines.join("\n").length > maxChars) {
      lines.push(`  \u2026 ${acc.length - acc.indexOf(d)} more directories (raise depth/maxChars or target a subpath)`);
      break;
    }
  }
  return lines.join("\n");
}
function cachePath(root, depth) {
  const dir = join2(yeschefHome(), "cache");
  mkdirSync2(dir, { recursive: true });
  return join2(dir, `folderdesc-${projectSlug(root)}-d${depth}.json`);
}
function getFolderDescription(root, depth = 3, refresh = false) {
  const p = cachePath(root, depth);
  let rootMtime = 0;
  try {
    rootMtime = statSync2(root).mtimeMs;
  } catch {
  }
  if (!refresh && existsSync2(p)) {
    try {
      const c = JSON.parse(readFileSync2(p, "utf8"));
      if (c.depth === depth && c.rootMtime === rootMtime && Date.now() - c.builtAt < 6e5) return c.text;
    } catch {
    }
  }
  const text = buildFolderDescription(root, depth);
  try {
    writeFileSync2(p, JSON.stringify({ builtAt: Date.now(), rootMtime, text, depth }));
  } catch {
  }
  return text;
}

// src/lib/notes.ts
import { readFileSync as readFileSync3, writeFileSync as writeFileSync3, existsSync as existsSync3 } from "node:fs";
import { join as join3 } from "node:path";
var KITCHEN_ID = "kitchen";
var SECTION_HEADER_RE = /^##\s+(\w+)/;
function notesPath(cwd2) {
  return join3(ensureDir(stateDir(cwd2)), `notes-${KITCHEN_ID}.md`);
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
  if (!existsSync3(p)) return TEMPLATE;
  try {
    return readFileSync3(p, "utf8");
  } catch {
    return TEMPLATE;
  }
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
function openPlanItems(text) {
  const sections = splitSections(text);
  return (sections["plan"] ?? []).filter((l) => /^\s*-\s*\[ \]/.test(l)).map((l) => l.replace(/^\s*-\s*\[ \]\s*/, "").trim());
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

// src/hooks/session-start.ts
var HOUSE_RULES = `[yeschef] Kitchen open. House rules (token thrift + clean context):
1. BATCH: fire all independent Glob/Grep/Read calls as parallel tool_use blocks in ONE message. Target: Discover \u2192 Read \u2192 Act in 3 turns. The mcp__yeschef__batch_digest tool runs many discovery ops in a single call.
2. DELEGATE: bulk exploration goes to the 'scout' subagent (cheap model, returns a \u226440-line digest with file:line pointers). Parallel implementation goes to 'line-cook'. Verification goes to 'expeditor'.
3. NEVER RE-DUMP: reference earlier reads as file:line. Re-reading an unchanged file is blocked after repeated waste.
4. NOTES: keep goal/plan/discoveries in mcp__yeschef__notes (the mise en place). Check off plan items as you finish them \u2014 the stop guard reads this.
5. TESTS: run them via mcp__yeschef__run_tests (compacted output) instead of raw test commands when possible.
6. OUTPUT: think \u226415 lines, then act with tools. Final replies stay concise.`;
var input = readHookInput();
var cwd = input.cwd ?? process.cwd();
var sessionId = input.session_id ?? "unknown";
var cfg = loadConfig(cwd);
try {
  const parts = [HOUSE_RULES];
  try {
    parts.push("", getFolderDescription(cwd, 2));
  } catch {
  }
  const summary = notesSummary(cwd);
  if (summary) parts.push("", `Mise en place (resumed notes):
${summary}`);
  if (cfg.telemetry.enabled) logEvent(cwd, sessionId, "session-start", { source: input.source ?? "startup" });
  emit({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: parts.join("\n") }
  });
} catch {
  emitNothing();
}
