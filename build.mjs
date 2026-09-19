// Bundles every entry point into self-contained, zero-dependency dist/*.mjs files.
// dist/ is committed so `/plugin install` works with no install step on the user's machine.
import { build } from "esbuild";
import { rmSync, mkdirSync, readFileSync } from "node:fs";

// Single source of truth for the version. CI already pins plugin.json to
// package.json; injecting it here keeps the MCP server from drifting too.
const { version } = JSON.parse(readFileSync("package.json", "utf8"));

const entries = {
  "session-start": "src/hooks/session-start.ts",
  "user-prompt": "src/hooks/user-prompt.ts",
  "pre-tool": "src/hooks/pre-tool.ts",
  "post-tool": "src/hooks/post-tool.ts",
  "stop": "src/hooks/stop.ts",
  "compact": "src/hooks/compact.ts",
  "subagent": "src/hooks/subagent.ts",
  "session-end": "src/hooks/session-end.ts",
  "statusline": "src/statusline.ts",
  "mcp-server": "src/mcp/server.ts",
  "report": "src/report.ts",
  "eighty-six": "src/eighty-six.ts",
};

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");

for (const [name, entry] of Object.entries(entries)) {
  await build({
    entryPoints: [entry],
    outfile: `dist/${name}.mjs`,
    bundle: true,
    platform: "node",
    target: "node18",
    format: "esm",
    minify: false,
    sourcemap: false,
    banner: { js: "#!/usr/bin/env node" },
    define: { __YESCHEF_VERSION__: JSON.stringify(version) },
    // node: built-ins stay external automatically under platform:"node"
  });
  console.log(`built dist/${name}.mjs`);
}
