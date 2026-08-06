// Kitchen display: one-line statusline. Reads Claude Code's statusline JSON from
// stdin (schema varies across versions — parse defensively, render what exists)
// and merges YesChef session state (waste blocked, compaction savings, brigade).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stateDir, type SessionState } from "./lib/core.js";

function latestState(cwd: string, sessionId?: string): SessionState | null {
  try {
    const dir = stateDir(cwd);
    if (sessionId) {
      try { return JSON.parse(readFileSync(join(dir, `${sessionId.replace(/[^\w-]/g, "")}.json`), "utf8")); } catch { /* fall through */ }
    }
    const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("notes"));
    let best: { p: string; m: number } | null = null;
    for (const f of files) {
      const m = statSync(join(dir, f)).mtimeMs;
      if (!best || m > best.m) best = { p: join(dir, f), m };
    }
    return best ? JSON.parse(readFileSync(best.p, "utf8")) : null;
  } catch {
    return null;
  }
}

function pick(obj: any, paths: string[]): any {
  for (const path of paths) {
    let cur = obj;
    for (const key of path.split(".")) cur = cur?.[key];
    if (cur !== undefined && cur !== null) return cur;
  }
  return null;
}

let input: any = {};
try { input = JSON.parse(readFileSync(0, "utf8")); } catch { /* render from state only */ }

const cwd = pick(input, ["workspace.current_dir", "cwd", "workspace.project_dir"]) ?? process.cwd();
const model = pick(input, ["model.display_name", "model.id", "model"]) ?? "";
const cost = pick(input, ["cost.total_cost_usd", "total_cost_usd"]);
const ctxPct = pick(input, [
  "context.used_percent", "context.filled_percent", "context_window.used_percent", "context_usage_percent",
]);

const s = latestState(String(cwd), pick(input, ["session_id"]) ?? undefined);

const parts: string[] = ["👨‍🍳 yeschef"];
if (model) parts.push(String(model).toLowerCase().replace(/^claude[- ]?/, ""));
if (typeof ctxPct === "number") parts.push(`ctx ${Math.round(ctxPct)}%`);
if (typeof cost === "number") parts.push(`$${cost.toFixed(2)}`);
if (s) {
  const saved = s.compaction?.savedChars ?? 0;
  if (saved > 0) parts.push(`trimmed ~${saved >= 4000 ? Math.round(saved / 4000) + "k" : Math.round(saved / 4)} tok`);
  const blocked = (s.blocked?.loops ?? 0) + (s.blocked?.dupReads ?? 0);
  if (blocked > 0) parts.push(`86'd ${blocked}`);
  if ((s.brigade?.active ?? 0) > 0) parts.push(`${s.brigade.active} cook${s.brigade.active > 1 ? "s" : ""} on`);
  if (s.paralysisTripped) parts.push("⚠ stalled");
}
process.stdout.write(parts.join(" | "));
