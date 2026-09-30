import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Claude Code exposes a plugin's MCP tools as mcp__plugin_<plugin>_<server>__<tool>.
// A wrong name silently strips the tool from agent `tools:` allowlists and
// points the model at a tool that doesn't exist.
const ROOT = join(__dirname, "..");
const PREFIX = "mcp__plugin_yeschef_yeschef__";
const SCANNED = ["agents", "commands", "skills", "workflows", "src"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

const sources = SCANNED.flatMap((d) => files(join(ROOT, d))).map((p) => ({ p, text: readFileSync(p, "utf8") }));
const registered = new Set(
  [...readFileSync(join(ROOT, "src/mcp/server.ts"), "utf8").matchAll(/server\.tool\(\s*"(\w+)"/g)].map((m) => m[1]),
);

describe("plugin MCP tool references", () => {
  it("finds the registered tools", () => {
    expect([...registered].sort()).toEqual(["batch_digest", "folder_desc", "notes", "run_tests"]);
  });

  it("never uses a non-plugin yeschef MCP prefix", () => {
    const bad = sources.filter(({ text }) => /mcp__yeschef__/.test(text)).map(({ p }) => p);
    expect(bad).toEqual([]);
  });

  it("only references tools the server registers", () => {
    const unknown = sources.flatMap(({ p, text }) =>
      [...text.matchAll(new RegExp(`${PREFIX}(\\w+)`, "g"))].filter((m) => !registered.has(m[1])).map((m) => `${p}: ${m[0]}`),
    );
    expect(unknown).toEqual([]);
  });

  it("grants every agent the plugin tools its body tells it to use", () => {
    for (const { p, text } of sources.filter(({ p }) => p.includes(join(ROOT, "agents")))) {
      const tools = text.match(/^tools:(.*)$/m)?.[1] ?? "";
      const body = text.split(/^---$/m).slice(2).join("---");
      for (const [, tool] of body.matchAll(new RegExp(`${PREFIX}(\\w+)`, "g"))) {
        expect(tools, `${p} body uses ${tool}`).toContain(PREFIX + tool);
      }
    }
  });
});
