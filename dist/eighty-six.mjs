#!/usr/bin/env node

// src/eighty-six.ts
import { readdirSync, unlinkSync } from "node:fs";
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

// src/eighty-six.ts
var cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
var dir = stateDir(cwd);
var cleared = 0;
var overflow = 0;
try {
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".json")) {
      try {
        unlinkSync(join2(dir, f));
        cleared++;
      } catch {
      }
    }
  }
} catch {
}
try {
  for (const f of readdirSync(join2(dir, "overflow"))) {
    try {
      unlinkSync(join2(dir, "overflow", f));
      overflow++;
    } catch {
    }
  }
} catch {
}
console.log(`86'd: cleared ${cleared} session state file(s) and ${overflow} overflow file(s) in ${dir}. Notes preserved. Guards start fresh.`);
