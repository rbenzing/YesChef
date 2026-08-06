// batch_digest: BouzéCode's DAG-parallel Discover turn collapsed into ONE tool call.
// Accepts a list of glob / grep / read-range ops, runs them all, returns a single
// merged, size-capped digest. Pure JS (no ripgrep dependency), bounded everywhere.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { WALK_IGNORE, WALK_DOT_ALLOW } from "./core.js";

const MAX_FILES_SCANNED = 4000;
const MAX_FILE_SIZE = 1_500_000;

export type DigestOp =
  | { glob: string; limit?: number }
  | { grep: string; glob?: string; ignoreCase?: boolean; limit?: number }
  | { read: string; start?: number; end?: number };

function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") { re += "(?:.*)"; i++; if (glob[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (".+^${}()|[]\\".includes(c)) re += "\\" + c;
    else if (c === "/") re += "/";
    else re += c;
  }
  return new RegExp(`^${re}$`, "i");
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [""];
  while (stack.length && out.length < MAX_FILES_SCANNED) {
    const rel = stack.pop()!;
    let entries;
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith(".") && !WALK_DOT_ALLOW.has(e.name)) continue;
      if (e.isDirectory()) { if (!WALK_IGNORE.has(e.name)) stack.push(rel ? `${rel}/${e.name}` : e.name); }
      else out.push(rel ? `${rel}/${e.name}` : e.name);
    }
  }
  return out;
}

function runGlob(root: string, files: string[], pattern: string, limit: number): string {
  const re = globToRegex(pattern.replace(/\\/g, "/"));
  const hits = files.filter((f) => re.test(f));
  const shown = hits.slice(0, limit);
  return [
    `GLOB ${pattern} → ${hits.length} file(s)`,
    ...shown.map((f) => `  ${f}`),
    hits.length > shown.length ? `  … ${hits.length - shown.length} more` : "",
  ].filter(Boolean).join("\n");
}

function isProbablyBinary(buf: string): boolean {
  return buf.includes("\u0000");
}

function runGrep(root: string, files: string[], pattern: string, glob: string | undefined, ignoreCase: boolean, limit: number): string {
  let re: RegExp;
  try { re = new RegExp(pattern, ignoreCase ? "i" : ""); } catch { return `GREP ${pattern} → invalid regex`; }
  const fileRe = glob ? globToRegex(glob.replace(/\\/g, "/")) : null;
  const lines: string[] = [];
  let total = 0;
  for (const f of files) {
    if (fileRe && !fileRe.test(f)) continue;
    let text: string;
    try {
      if (statSync(join(root, f)).size > MAX_FILE_SIZE) continue;
      text = readFileSync(join(root, f), "utf8");
    } catch { continue; }
    if (isProbablyBinary(text.slice(0, 1000))) continue;
    const fileLines = text.split("\n");
    let perFile = 0;
    for (let i = 0; i < fileLines.length; i++) {
      if (re.test(fileLines[i]!)) {
        total++;
        if (total <= limit && perFile < 5) {
          lines.push(`  ${f}:${i + 1}: ${fileLines[i]!.trim().slice(0, 160)}`);
          perFile++;
        }
      }
    }
    if (total > limit * 3) break;
  }
  return [`GREP /${pattern}/${ignoreCase ? "i" : ""}${glob ? ` in ${glob}` : ""} → ${total} match(es)`, ...lines,
    total > lines.length ? `  … capped (5/file, ${limit} shown)` : ""].filter(Boolean).join("\n");
}

function runRead(root: string, file: string, start: number, end: number): string {
  let text: string;
  const rel = file.replace(/\\/g, "/");
  try { text = readFileSync(join(root, rel), "utf8"); } catch (e) { return `READ ${rel} → unreadable (${(e as Error).message.split(sep).pop()})`; }
  const lines = text.split("\n");
  const s = Math.max(1, start);
  const e = Math.min(lines.length, end || s + 79);
  const body = lines.slice(s - 1, e).map((l, i) => `  ${s + i}\t${l.length > 200 ? l.slice(0, 200) + "…" : l}`);
  return [`READ ${rel} lines ${s}-${e} of ${lines.length}`, ...body].join("\n");
}

export function runBatchDigest(root: string, ops: DigestOp[], maxChars = 9000): string {
  if (!Array.isArray(ops) || ops.length === 0) return "batch_digest: no ops given";
  const capped = ops.slice(0, 20);
  const needsList = capped.some((o) => "glob" in o || "grep" in o);
  const files = needsList ? listFiles(root) : [];
  const parts: string[] = [];
  for (const op of capped) {
    try {
      if ("grep" in op && op.grep !== undefined) parts.push(runGrep(root, files, op.grep, op.glob, op.ignoreCase ?? true, op.limit ?? 30));
      else if ("glob" in op && op.glob !== undefined) parts.push(runGlob(root, files, op.glob, op.limit ?? 40));
      else if ("read" in op && op.read !== undefined) parts.push(runRead(root, op.read, op.start ?? 1, op.end ?? 0));
      else parts.push(`unknown op: ${JSON.stringify(op).slice(0, 80)}`);
    } catch (e) {
      parts.push(`op failed: ${(e as Error).message}`);
    }
  }
  let out = parts.join("\n\n");
  if (ops.length > capped.length) out += `\n\n[yeschef] ${ops.length - capped.length} ops dropped (max 20 per call)`;
  if (out.length > maxChars) out = out.slice(0, maxChars) + `\n[yeschef] digest capped at ${maxChars} chars — narrow your ops or read specific ranges`;
  return out;
}
