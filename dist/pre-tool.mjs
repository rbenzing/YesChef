#!/usr/bin/env node

// src/hooks/pre-tool.ts
import { statSync as statSync2 } from "node:fs";

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
function contextScope(transcriptPath) {
  return createHash("md5").update(transcriptPath ?? "").digest("hex").slice(0, 8);
}
function hashCall(toolName, toolInput) {
  return createHash("md5").update(toolName + "\0" + JSON.stringify(toolInput ?? {})).digest("hex");
}

// src/lib/loop.ts
function detectLoop(history, next, maxCycleSize, repeatsToBlock) {
  const seq = [...history, next];
  for (let k = 1; k <= maxCycleSize; k++) {
    if (seq.length < k * repeatsToBlock) continue;
    const tail = seq.slice(-k * repeatsToBlock);
    const cycle = tail.slice(0, k).join("|");
    let ok = true;
    for (let r = 1; r < repeatsToBlock; r++) {
      if (tail.slice(r * k, (r + 1) * k).join("|") !== cycle) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return { looping: true, cycleSize: k, repeats: repeatsToBlock };
    }
  }
  return { looping: false, cycleSize: 0, repeats: 0 };
}
function pushCall(history, hash, windowSize) {
  const next = [...history, hash];
  return next.length > windowSize ? next.slice(next.length - windowSize) : next;
}
var LOOP_WARNING = (cycleSize, repeats) => `[yeschef] LoopWarning: this exact tool call completes a cycle of ${cycleSize} call(s) repeated ${repeats}x with no new information. Stop and change approach: re-read the last error fully, state what you expected vs. what happened in your mise notes, then try a DIFFERENT tool or different inputs. Do not reissue the same call.`;

// src/hooks/pre-tool.ts
var input = readHookInput();
var cwd = input.cwd ?? process.cwd();
var sessionId = input.session_id ?? "unknown";
var tool = input.tool_name ?? "";
var cfg = loadConfig(cwd);
var scope = contextScope(input.transcript_path);
function deny(reason) {
  emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
}
function warn(context) {
  emit({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: context } });
}
try {
  const state = loadState(cwd, sessionId);
  if (cfg.enforcement.loopGuard !== "off") {
    const h = `${scope}:${hashCall(tool, input.tool_input)}`;
    const verdict = detectLoop(state.calls, h, cfg.loop.maxCycleSize, cfg.loop.repeatsToBlock);
    state.calls = pushCall(state.calls, h, cfg.loop.windowSize);
    if (verdict.looping) {
      state.blocked.loops += 1;
      saveState(cwd, sessionId, state);
      if (cfg.telemetry.enabled) logEvent(cwd, sessionId, "loop-blocked", { tool, cycleSize: verdict.cycleSize });
      if (cfg.enforcement.loopGuard === "block") deny(LOOP_WARNING(verdict.cycleSize, verdict.repeats));
      warn(LOOP_WARNING(verdict.cycleSize, verdict.repeats));
    }
  }
  if (tool === "Read" && cfg.enforcement.duplicateReadGuard !== "off") {
    const fp = String(input.tool_input?.file_path ?? "");
    if (fp) {
      const key = `${scope}|${fp}|${input.tool_input?.offset ?? 0}|${input.tool_input?.limit ?? 0}`;
      const rec = state.reads[key];
      let mtime = 0;
      try {
        mtime = statSync2(fp).mtimeMs;
      } catch {
      }
      const fresh = !rec || rec.mtime !== mtime || Date.now() - rec.t > cfg.duplicateRead.ttlMinutes * 6e4;
      if (fresh && rec) delete state.reads[key];
      if (!fresh) {
        const count = rec.count + 1;
        state.reads[key] = { count, t: Date.now(), mtime };
        const msg = `[yeschef] duplicate read #${count} of ${fp} \u2014 the file has NOT changed since you read it. Its content is already in context (or summarized in your notes). Reference it by file:line. If you genuinely need a fragment again, read a narrow range (offset/limit) or use mcp__yeschef__batch_digest.`;
        if (count >= cfg.duplicateRead.blockOn && cfg.enforcement.duplicateReadGuard === "block") {
          state.blocked.dupReads += 1;
          saveState(cwd, sessionId, state);
          if (cfg.telemetry.enabled) logEvent(cwd, sessionId, "dup-read-blocked", { file: fp, count });
          deny(msg);
        }
        if (count >= cfg.duplicateRead.warnOn) {
          saveState(cwd, sessionId, state);
          warn(msg);
        }
      }
    }
  }
  saveState(cwd, sessionId, state);
  emitNothing();
} catch {
  emitNothing();
}
