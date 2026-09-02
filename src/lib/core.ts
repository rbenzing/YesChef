// Core plumbing shared by every hook, the MCP server, and the statusline.
// Zero runtime dependencies; everything bundles into self-contained dist files.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, appendFileSync, statSync, openSync, readSync, closeSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

// ---------- hook stdin/stdout ----------

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: any;
  tool_response?: any;
  prompt?: string;
  stop_hook_active?: boolean;
  [k: string]: any;
}

export function readHookInput(): HookInput {
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Emit hook JSON and exit 0. Unknown fields are ignored by Claude Code, so we can be generous. */
export function emit(output: Record<string, any>): never {
  // On Windows, stdout-to-pipe writes are async; process.exit() can truncate a
  // payload larger than the pipe buffer. Force blocking writes so the JSON is
  // fully flushed before exit (no-op where unsupported).
  try { (process.stdout as any)._handle?.setBlocking?.(true); } catch { /* best effort */ }
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

export function emitNothing(): never {
  process.exit(0);
}

// ---------- paths & project identity ----------

export function projectSlug(cwd: string): string {
  const clean = resolve(cwd).replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return clean.slice(-80) || "root";
}

export function yeschefHome(): string {
  return process.env.YESCHEF_HOME || join(homedir(), ".claude", "yeschef");
}

export function stateDir(cwd: string): string {
  return join(yeschefHome(), "state", projectSlug(cwd));
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function overflowDir(cwd: string): string {
  return ensureDir(join(stateDir(cwd), "overflow"));
}

// ---------- config ----------

export type Dial = "off" | "warn" | "block";

export interface YesChefConfig {
  enforcement: { loopGuard: Dial; duplicateReadGuard: Dial; stopGuard: Dial };
  truncation: { enabled: boolean; maxLines: number; maxChars: number; headLines: number; tailLines: number };
  testCompaction: { enabled: boolean };
  failureNudges: { enabled: boolean };
  reminder: { enabled: boolean };
  paralysis: { enabled: boolean; progresslessToolCalls: number };
  budget: { usd: number | null; warnAt: number; wrapUpAt: number };
  notes: { compactAtChars: number };
  loop: { maxCycleSize: number; repeatsToBlock: number; windowSize: number };
  duplicateRead: { ttlMinutes: number; warnOn: number; blockOn: number };
  stop: { maxConsecutiveBlocks: number };
  telemetry: { enabled: boolean };
  pricing: {
    models: Record<string, [number, number]>;  // model-id substring → [inputUSD/MTok, outputUSD/MTok]; first match wins
    default: [number, number];                  // unknown model → this pair
    cacheReadMult: number;                       // cache-hit input multiplier (~0.1)
    cacheWriteMult: number;                      // cache-write input multiplier (~1.25 for the 5-minute cache)
  };
}

export const DEFAULTS: YesChefConfig = {
  enforcement: { loopGuard: "block", duplicateReadGuard: "block", stopGuard: "block" },
  truncation: { enabled: true, maxLines: 200, maxChars: 8000, headLines: 80, tailLines: 10 },
  testCompaction: { enabled: true },
  failureNudges: { enabled: true },
  reminder: { enabled: true },
  paralysis: { enabled: true, progresslessToolCalls: 36 },
  budget: { usd: null, warnAt: 0.75, wrapUpAt: 0.9 },
  notes: { compactAtChars: 20000 },
  loop: { maxCycleSize: 8, repeatsToBlock: 3, windowSize: 24 },
  duplicateRead: { ttlMinutes: 10, warnOn: 2, blockOn: 3 },
  stop: { maxConsecutiveBlocks: 2 },
  telemetry: { enabled: true },
  pricing: {
    models: { haiku: [1, 5], sonnet: [3, 15], fable: [10, 50], mythos: [10, 50], opus: [5, 25] },
    default: [5, 25],   // unknown model → Opus-tier
    cacheReadMult: 0.1,
    cacheWriteMult: 1.25,
  },
};

function deepMerge<T>(base: T, over: any): T {
  if (over === null || over === undefined) return base;
  if (typeof base !== "object" || base === null || Array.isArray(base)) return over as T;
  const out: any = { ...base };
  for (const k of Object.keys(over)) {
    out[k] = k in (base as any) ? deepMerge((base as any)[k], over[k]) : over[k];
  }
  return out;
}

export function loadConfig(cwd: string): YesChefConfig {
  let cfg = DEFAULTS;
  for (const p of [join(yeschefHome(), "config.json"), join(cwd, ".yeschef.json")]) {
    try {
      if (existsSync(p)) cfg = deepMerge(cfg, JSON.parse(readFileSync(p, "utf8")));
    } catch {
      /* bad config never breaks a session */
    }
  }
  return cfg;
}

// ---------- session state ----------

export interface SessionState {
  calls: string[];                           // ring buffer of scoped (tool+input) hashes
  reads: Record<string, { count: number; t: number; mtime: number }>;
  failures: Record<string, number>;          // normalized bash cmd -> consecutive failures
  progresslessCalls: number;
  paralysisTripped: boolean;
  stopBlocks: number;
  blocked: { loops: number; dupReads: number };
  compaction: { results: number; savedChars: number };
  brigade: { active: number; finished: number };
  lastTestsFailing: boolean;
  turn: number;
  // Set by the PostCompact hook (whose own output cannot carry context — the
  // schema rejects hookEventName "PostCompact"); cleared by the next
  // PostToolUse or UserPromptSubmit hook after it relays the notes re-seed.
  compactRecoveryPending: boolean;
}

const EMPTY_STATE: SessionState = {
  calls: [], reads: {}, failures: {}, progresslessCalls: 0, paralysisTripped: false,
  stopBlocks: 0, blocked: { loops: 0, dupReads: 0 }, compaction: { results: 0, savedChars: 0 },
  brigade: { active: 0, finished: 0 }, lastTestsFailing: false, turn: 0, compactRecoveryPending: false,
};

export function statePath(cwd: string, sessionId: string): string {
  return join(ensureDir(stateDir(cwd)), `${sessionId.replace(/[^\w-]/g, "")}.json`);
}

export function loadState(cwd: string, sessionId: string): SessionState {
  try {
    // Deep merge so partial nested objects from older schema versions keep their
    // missing subfields (a shallow spread left e.g. blocked.dupReads undefined,
    // and a later += produced NaN that persisted to disk forever).
    const s = deepMerge(structuredClone(EMPTY_STATE), JSON.parse(readFileSync(statePath(cwd, sessionId), "utf8")));
    // legacy migration: calls used to be [{h, t}] objects
    s.calls = (s.calls ?? []).map((c: any) => (typeof c === "string" ? c : c?.h)).filter(Boolean);
    return s;
  } catch {
    return structuredClone(EMPTY_STATE);
  }
}

const READS_RETENTION_MS = 60 * 60000; // > any configurable dup-read TTL
const READS_CAP = 500;

/** Last-writer-wins; hooks for parallel tool calls may interleave. Counters are heuristics, not ledgers. */
export function saveState(cwd: string, sessionId: string, s: SessionState): void {
  try {
    // Prune the read ledger: entries past retention are dead to the TTL-based
    // guard anyway, and unbounded growth makes every hook invocation pay
    // parse+stringify on hundreds of KB after a few thousand reads.
    const keys = Object.keys(s.reads);
    if (keys.length > 0) {
      const now = Date.now();
      for (const k of keys) {
        if (now - s.reads[k]!.t > READS_RETENTION_MS) delete s.reads[k];
      }
      const remaining = Object.keys(s.reads);
      if (remaining.length > READS_CAP) {
        remaining.sort((a, b) => s.reads[a]!.t - s.reads[b]!.t)
          .slice(0, remaining.length - READS_CAP)
          .forEach((k) => delete s.reads[k]);
      }
    }
    const p = statePath(cwd, sessionId);
    const tmp = `${p}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(s));
    renameSync(tmp, p);
  } catch {
    /* state loss degrades guards gracefully */
  }
}

// ---------- shared test-run status ----------

/**
 * Project-level "did the last test run fail?" marker. Both test paths write it —
 * the post-tool hook (raw Bash test commands) and the MCP run_tests tool (which
 * runs in the server process and has no session id, so per-session state can't
 * carry this signal). The stop guard reads it with a freshness window so a stale
 * red flag from a long-dead run can't block unrelated sessions forever.
 */
export function setTestStatus(cwd: string, failing: boolean): void {
  try {
    writeFileSync(join(ensureDir(stateDir(cwd)), "test-status.json"), JSON.stringify({ failing, t: Date.now() }));
  } catch { /* marker loss just weakens the stop guard */ }
}

export function getTestStatus(cwd: string, maxAgeMs: number): { failing: boolean; t: number } | null {
  try {
    const s = JSON.parse(readFileSync(join(stateDir(cwd), "test-status.json"), "utf8"));
    if (typeof s?.failing !== "boolean" || typeof s?.t !== "number") return null;
    if (Date.now() - s.t > maxAgeMs) return null;
    return s;
  } catch {
    return null;
  }
}

// ---------- shared file-walk exclusions ----------

/** One ignore set for every tree walker (batch_digest, folder_desc) — these drifted when defined per-file. */
export const WALK_IGNORE = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "target", ".next", ".nuxt",
  "__pycache__", ".venv", "venv", ".tox", ".pytest_cache", ".mypy_cache", "coverage",
  ".idea", ".vscode", "bin", "obj", ".gradle", ".terraform", "vendor", ".yeschef",
]);

/** Dot-directories that ARE worth walking despite the leading dot. */
export const WALK_DOT_ALLOW = new Set([".github", ".claude", ".claude-plugin"]);

// ---------- telemetry ----------

export function logEvent(cwd: string, sessionId: string, event: string, data: Record<string, any> = {}): void {
  try {
    const dir = ensureDir(join(yeschefHome(), "logs"));
    const line = JSON.stringify({ ts: new Date().toISOString(), session: sessionId, event, ...data });
    appendFileSync(join(dir, `${projectSlug(cwd)}.jsonl`), line + "\n");
  } catch {
    /* telemetry must never break the session */
  }
}

// ---------- hashing ----------

/**
 * Guard scope for the loop/dup-read ledgers. Subagents share the parent's
 * session_id but run on their own transcript, so keying guard entries by
 * session alone made a scout's FIRST read of a file count as the parent's
 * third (observed live: fresh subagents denied with "already in context").
 * Scoping by transcript path isolates each context; when the field is absent
 * everything degrades to the old shared behavior.
 */
export function contextScope(transcriptPath: string | undefined): string {
  return createHash("md5").update(transcriptPath ?? "").digest("hex").slice(0, 8);
}

export function hashCall(toolName: string, toolInput: any): string {
  return createHash("md5").update(toolName + "\u0000" + JSON.stringify(toolInput ?? {})).digest("hex");
}

// ---------- transcript usage (estimated budget) ----------

export interface TokenBuckets {
  inTok: number;      // uncached input tokens (billed 1×)
  cacheRead: number;  // cache-hit tokens (billed ~0.1×)
  cacheWrite: number; // cache-write tokens (billed ~1.25× for the 5-minute cache)
  out: number;        // output tokens
}

export interface UsageSnapshot {
  contextTokens: number;   // last turn's input+cache tokens ≈ live context window size
  buckets: TokenBuckets;   // summed across the read window — for cache-aware cost
  model: string | null;
}

export interface ModelUsage extends TokenBuckets {
  turns: number;           // usage-bearing turns attributed to this model
}

// $/MTok prices and cache multipliers live in config (YesChefConfig.pricing,
// overridable via ~/.claude/yeschef/config.json or <cwd>/.yeschef.json); the
// cost functions default to DEFAULTS.pricing so callers without a config still work.
export type Pricing = YesChefConfig["pricing"];

export function priceFor(model: string | null, pricing: Pricing = DEFAULTS.pricing): { in: number; out: number } {
  const m = (model ?? "").toLowerCase();
  for (const [key, [inP, outP]] of Object.entries(pricing.models)) {
    if (m.includes(key)) return { in: inP, out: outP };
  }
  const [inP, outP] = pricing.default;
  return { in: inP, out: outP };
}

/** Cache-aware cost of a token bucket at a model's rates. Estimate only, not billing data. */
export function costOfBuckets(b: TokenBuckets, model: string | null, pricing: Pricing = DEFAULTS.pricing): number {
  const { in: rIn, out: rOut } = priceFor(model, pricing);
  return (
    b.inTok * rIn +
    b.cacheRead * rIn * pricing.cacheReadMult +
    b.cacheWrite * rIn * pricing.cacheWriteMult +
    b.out * rOut
  ) / 1e6;
}

const emptyBuckets = (): TokenBuckets => ({ inTok: 0, cacheRead: 0, cacheWrite: 0, out: 0 });
function addUsage(b: TokenBuckets, u: any): void {
  b.inTok += u.input_tokens ?? 0;
  b.cacheRead += u.cache_read_input_tokens ?? 0;
  b.cacheWrite += u.cache_creation_input_tokens ?? 0;
  b.out += u.output_tokens ?? 0;
}

const USAGE_TAIL_BYTES = 262144;

/** Read only the tail of the transcript JSONL and pull the most recent usage block. Estimates only. */
export function readUsage(transcriptPath: string | undefined): UsageSnapshot | null {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  let fd = -1;
  try {
    const size = statSync(transcriptPath).size;
    // Read at most the last USAGE_TAIL_BYTES bytes instead of the whole file —
    // transcripts grow unbounded and this runs on every prompt when a budget is set.
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
    // A tail read may start mid-line/mid-char; that first partial line just fails to parse and is skipped.
    const lines = buf.toString("utf8", 0, read).split("\n").filter(Boolean);
    const buckets = emptyBuckets();
    let model: string | null = null;
    let contextTokens = 0;
    let seen = false;
    for (const line of lines) {
      if (!line.includes('"usage"')) continue;
      try {
        const obj = JSON.parse(line);
        const u = obj?.message?.usage ?? obj?.usage;
        if (u && typeof u === "object") {
          seen = true;
          addUsage(buckets, u);                 // sum across the tail window (each turn is billed separately)
          model = obj?.message?.model ?? model;
          contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        }
      } catch { /* partial line */ }
    }
    if (!seen) return null;
    return { contextTokens, buckets, model };
  } catch {
    return null;
  } finally {
    if (fd >= 0) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

/** Cache-aware cost of a tail snapshot. Estimate only, not billing data. */
export function estimateCostUSD(u: UsageSnapshot, pricing: Pricing = DEFAULTS.pricing): number {
  return costOfBuckets(u.buckets, u.model, pricing);
}

/** Accumulate every usage-bearing turn in a JSONL file into `models`, grouped by model. */
function scanUsageInto(filePath: string, models: Record<string, ModelUsage>): { seen: boolean; contextTokensLast: number | null } {
  let seen = false;
  let contextTokensLast: number | null = null;
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
    } catch { /* partial or non-JSON line */ }
  }
  return { seen, contextTokensLast };
}

/**
 * Group every usage-bearing turn by model — for the per-model cost breakdown in
 * /yeschef:report. Scans the main transcript AND its subagent transcripts, which
 * Claude Code writes to a sibling `<transcript>/subagents/*.jsonl` directory (brigade
 * turns don't appear in the main file — that's where scout/line-cook/expeditor cost
 * lives). Runs once per session (SessionEnd), so full reads are fine here, unlike the
 * tail-only readUsage on the hot path. Buckets are summed per line because each turn
 * is a separately billed API call. contextTokensLast reflects the MAIN transcript's
 * last turn (the live window), ignoring subagents.
 */
export function readUsageByModel(
  transcriptPath: string | undefined,
): { models: Record<string, ModelUsage>; contextTokensLast: number | null } | null {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  try {
    const models: Record<string, ModelUsage> = {};
    const main = scanUsageInto(transcriptPath, models);
    let seen = main.seen;
    const subDir = join(transcriptPath.replace(/\.jsonl$/i, ""), "subagents");
    if (existsSync(subDir)) {
      for (const f of readdirSync(subDir)) {
        if (!f.endsWith(".jsonl")) continue;   // skip .meta.json siblings
        try { if (scanUsageInto(join(subDir, f), models).seen) seen = true; } catch { /* skip unreadable */ }
      }
    }
    if (!seen) return null;
    return { models, contextTokensLast: main.contextTokensLast };
  } catch {
    return null;
  }
}

// ---------- shell invocation ----------

export interface ShellInvocation { file: string; args: string[]; verbatim: boolean }

/**
 * Build the argv for running a shell command line, matching child_process.exec's
 * platform behavior. On Windows we invoke `cmd.exe /d /s /c` with the WHOLE
 * command wrapped in one extra quote pair and windowsVerbatimArguments enabled;
 * `/s` then strips exactly that outer pair, so a command that itself starts with
 * a quoted path (e.g. `"C:\Program Files\nodejs\node.exe" script.js`) survives
 * intact instead of losing its leading quote. On POSIX we invoke `/bin/sh -c`
 * with the command passed as a single argument.
 */
export function buildShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): ShellInvocation {
  if (platform === "win32") {
    return { file: "cmd.exe", args: ["/d", "/s", "/c", `"${command}"`], verbatim: true };
  }
  return { file: "/bin/sh", args: ["-c", command], verbatim: false };
}
