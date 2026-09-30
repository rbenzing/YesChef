// The YesChef kitchen: a bundled stdio MCP server exposing four token-thrift tools.
//   folder_desc  — pre-indexed annotated repo tree (BouzéCode's GetFolderDescription)
//   batch_digest — many discovery ops in ONE tool call (the Discover turn, collapsed)
//   notes        — shared mise-en-place scratchpad (goal/plan/discoveries/decisions)
//   run_tests    — test runner with compacted output (failures only, or a one-liner)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { getFolderDescription } from "../lib/folderdesc.js";
import { runBatchDigest, type DigestOp } from "../lib/digest.js";
import { readNotes, setSection, appendToSection, checkPlanItem, maybeCompact, SECTIONS, type Section } from "../lib/notes.js";
import { compactTestOutput, truncateGeneric, isTestFailure } from "../lib/compact.js";
import { loadConfig, overflowDir, logEvent, buildShellCommand, setTestStatus } from "../lib/core.js";

// One notes namespace per project (not per session) — baked into the notes lib.
const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const cfg = loadConfig(cwd);

// Injected by build.mjs from package.json so this can't drift from the plugin
// manifest. `typeof` (not `??`) because the identifier is genuinely undeclared
// when the file runs unbundled, e.g. under vitest.
declare const __YESCHEF_VERSION__: string;
const VERSION = typeof __YESCHEF_VERSION__ !== "undefined" ? __YESCHEF_VERSION__ : "0.0.0-dev";

const server = new McpServer({ name: "yeschef", version: VERSION });

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

server.tool(
  "folder_desc",
  "Annotated description of the repo (or a subpath) in a few hundred tokens: per-directory file counts, dominant languages, key files, package/readme one-liners. Use it to orient before exploring with Glob/LS. It returns no file contents or symbols. Results are cached for up to 10 minutes (reset when the top-level directory changes); pass refresh:true after adding or moving files deeper in the tree. A path outside the project root returns an error.",
  {
    path: z.string().optional().describe("Subpath relative to the project root (default: root)"),
    depth: z.number().int().min(1).max(6).optional().describe("Tree depth (default 3)"),
    refresh: z.boolean().optional().describe("Force rebuild, ignoring the cache"),
  },
  async ({ path, depth, refresh }) => {
    // Resolve and fence: '../' must not escape the project, and a bad path must
    // error loudly — naive concatenation turned absolute paths into nonexistent
    // roots whose empty walk looked like an empty repo.
    const root = resolve(cwd, path ?? "");
    if (!(root === resolve(cwd) || root.startsWith(resolve(cwd) + sep))) {
      return text(`error: path escapes the project root (${path})`);
    }
    if (!existsSync(root)) return text(`error: no such directory: ${path}`);
    return text(getFolderDescription(root, depth ?? 3, refresh ?? false));
  }
);

const opSchema = z.object({
  glob: z.string().optional(),
  grep: z.string().optional(),
  read: z.string().optional(),
  start: z.number().int().optional(),
  end: z.number().int().optional(),
  ignoreCase: z.boolean().optional(),
  limit: z.number().int().optional(),
}).describe("One op: {glob} | {grep, glob?, ignoreCase?, limit?} | {read, start?, end?}");

server.tool(
  "batch_digest",
  "Run up to 20 discovery ops (glob / grep / read line-range) in one call and get one merged digest, in op order; one call replaces a round of separate Glob/Grep/Read calls. Paths are project-root-relative with forward slashes, and a glob must match the whole path: '*.ts' matches root files only, '**/*.ts' matches all. grep takes a JavaScript regex, case-insensitive unless ignoreCase:false, and shows at most 5 hits per file and 30 in total (limit). glob lists 40 paths by default (limit). read returns lines start..end (default: 80 lines from start), each cut at 200 chars. Dot-directories, ignored dirs, binary files and files over 1.5 MB are skipped. The digest is capped at 9000 chars; if it is cut, narrow the ops.",
  { ops: z.array(opSchema).min(1).max(20).describe("Ops to run, in order; results are merged into one digest") },
  async ({ ops }) => {
    const mapped = ops.map((o): DigestOp =>
      o.glob !== undefined && o.grep === undefined && o.read === undefined ? { glob: o.glob, limit: o.limit }
        : o.grep !== undefined ? { grep: o.grep, glob: o.glob, ignoreCase: o.ignoreCase, limit: o.limit }
          : { read: o.read ?? "", start: o.start, end: o.end }
    );
    logEvent(cwd, "mcp", "batch-digest", { ops: mapped.length });
    return text(runBatchDigest(cwd, mapped));
  }
);

server.tool(
  "notes",
  "The project's shared mise-en-place notes (sections goal / plan / discoveries / decisions). They persist across sessions and every brigade subagent reads them. read returns the whole file; set replaces one section; append adds lines to it; check marks the first open '- [ ]' plan item containing the given text (case-insensitive) as '- [x]'. The stop guard blocks finishing while '- [ ]' items remain in plan. Above a size threshold the notes are compacted: duplicate lines dropped, checked items replaced by a count, older discoveries archived.",
  {
    action: z.enum(["read", "set", "append", "check"]).describe("read all | set a section | append to a section | check off a plan item"),
    section: z.enum(SECTIONS).optional().describe("Required for set/append"),
    content: z.string().optional().describe("Markdown for set/append; for 'check', a substring of the plan item"),
  },
  async ({ action, section, content }) => {
    if (action === "read") return text(readNotes(cwd));
    if (action === "check") {
      // An empty needle would match every plan line and check off an arbitrary item.
      if (!content?.trim()) return text("error: 'check' needs content — a substring of the plan item to check off");
      const updated = checkPlanItem(cwd, content);
      return text(updated ? `checked off: ${content}` : `no open plan item matching: ${content}`);
    }
    if (!section || content === undefined) return text("error: set/append need both section and content");
    const updated = action === "set"
      ? setSection(cwd, section as Section, content)
      : appendToSection(cwd, section as Section, content);
    const saved = maybeCompact(cwd, cfg.notes.compactAtChars);
    return text(`ok (notes ${updated.length} chars${saved ? `, structurally compacted, saved ${saved}` : ""})`);
  }
);

server.tool(
  "run_tests",
  "Run a test command in the project root and return compacted output: first line 'exit N', then failures + summary when red or a one-liner when green; the full output is saved to disk with a pointer. Each run records pass/fail, and the stop guard blocks finishing after a recent failing run. Default timeout 300s (max 900). Prefer this over raw Bash for tests.",
  {
    command: z.string().describe("Full test command, e.g. 'npx vitest run' or 'python -m pytest -q'"),
    timeoutSeconds: z.number().int().min(5).max(900).optional().describe("Default 300"),
  },
  async ({ command, timeoutSeconds }) => {
    const sh = buildShellCommand(command);
    const result = await new Promise<{ out: string; code: number }>((resolvePromise) => {
      execFile(sh.file, sh.args, {
        cwd, timeout: (timeoutSeconds ?? 300) * 1000, maxBuffer: 32 * 1024 * 1024, windowsVerbatimArguments: sh.verbatim,
      }, (err: any, stdout, stderr) => {
        resolvePromise({ out: `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}`, code: err ? (typeof err.code === "number" ? err.code : 1) : 0 });
      });
    });
    // Feed the stop guard: run_tests runs in the server process (no session id),
    // so the shared project-level marker is how red/green reaches the Stop hook.
    setTestStatus(cwd, isTestFailure(result.out, result.code !== 0));
    let r = compactTestOutput(result.out || "(no output)", result.code !== 0, overflowDir(cwd));
    if (r.kind === "unchanged") {
      // Unrecognized output shape — still enforce the size cap. Without this the
      // token-thrift tool itself could return up to 32MB (maxBuffer) verbatim.
      r = truncateGeneric(result.out || "(no output)", cfg.truncation.maxLines, cfg.truncation.maxChars, cfg.truncation.headLines, cfg.truncation.tailLines, overflowDir(cwd));
    }
    logEvent(cwd, "mcp", "run-tests", { exit: result.code, savedChars: r.savedChars });
    return text(`exit ${result.code}\n${r.text}`);
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
