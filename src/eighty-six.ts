// CLI for /yeschef:eighty-six — reset session state (guards, counters, test
// marker) and drop accumulated overflow files; keep the notes.
import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./lib/core.js";

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const dir = stateDir(cwd);
let cleared = 0;
let overflow = 0;
try {
  for (const f of readdirSync(dir)) {
    // notes are notes-*.md — the .json filter alone spares them
    if (f.endsWith(".json")) {
      try { unlinkSync(join(dir, f)); cleared++; } catch { /* in use */ }
    }
  }
} catch { /* nothing to clear */ }
try {
  for (const f of readdirSync(join(dir, "overflow"))) {
    try { unlinkSync(join(dir, "overflow", f)); overflow++; } catch { /* in use */ }
  }
} catch { /* no overflow dir */ }
console.log(`86'd: cleared ${cleared} session state file(s) and ${overflow} overflow file(s) in ${dir}. Notes preserved. Guards start fresh.`);
