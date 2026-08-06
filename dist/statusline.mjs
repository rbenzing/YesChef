#!/usr/bin/env node

// src/statusline.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join as join2 } from "node:path";

// src/lib/core.ts
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
var READS_RETENTION_MS = 60 * 6e4;

// src/statusline.ts
function latestState(cwd2, sessionId) {
  try {
    const dir = stateDir(cwd2);
    if (sessionId) {
      try {
        return JSON.parse(readFileSync(join2(dir, `${sessionId.replace(/[^\w-]/g, "")}.json`), "utf8"));
      } catch {
      }
    }
    const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("notes"));
    let best = null;
    for (const f of files) {
      const m = statSync(join2(dir, f)).mtimeMs;
      if (!best || m > best.m) best = { p: join2(dir, f), m };
    }
    return best ? JSON.parse(readFileSync(best.p, "utf8")) : null;
  } catch {
    return null;
  }
}
function pick(obj, paths) {
  for (const path of paths) {
    let cur = obj;
    for (const key of path.split(".")) cur = cur?.[key];
    if (cur !== void 0 && cur !== null) return cur;
  }
  return null;
}
var input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
}
var cwd = pick(input, ["workspace.current_dir", "cwd", "workspace.project_dir"]) ?? process.cwd();
var model = pick(input, ["model.display_name", "model.id", "model"]) ?? "";
var cost = pick(input, ["cost.total_cost_usd", "total_cost_usd"]);
var ctxPct = pick(input, [
  "context.used_percent",
  "context.filled_percent",
  "context_window.used_percent",
  "context_usage_percent"
]);
var s = latestState(String(cwd), pick(input, ["session_id"]) ?? void 0);
var parts = ["\u{1F468}\u200D\u{1F373} yeschef"];
if (model) parts.push(String(model).toLowerCase().replace(/^claude[- ]?/, ""));
if (typeof ctxPct === "number") parts.push(`ctx ${Math.round(ctxPct)}%`);
if (typeof cost === "number") parts.push(`$${cost.toFixed(2)}`);
if (s) {
  const saved = s.compaction?.savedChars ?? 0;
  if (saved > 0) parts.push(`trimmed ~${saved >= 4e3 ? Math.round(saved / 4e3) + "k" : Math.round(saved / 4)} tok`);
  const blocked = (s.blocked?.loops ?? 0) + (s.blocked?.dupReads ?? 0);
  if (blocked > 0) parts.push(`86'd ${blocked}`);
  if ((s.brigade?.active ?? 0) > 0) parts.push(`${s.brigade.active} cook${s.brigade.active > 1 ? "s" : ""} on`);
  if (s.paralysisTripped) parts.push("\u26A0 stalled");
}
process.stdout.write(parts.join(" | "));
