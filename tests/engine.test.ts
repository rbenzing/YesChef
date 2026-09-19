import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectLoop, pushCall } from "../src/lib/loop.js";
import { compactTestOutput, truncateGeneric, looksLikeTestCommand, extractResponseText, isTestFailure } from "../src/lib/compact.js";
import { runBatchDigest } from "../src/lib/digest.js";
import { buildFolderDescription } from "../src/lib/folderdesc.js";
import { buildShellCommand, readUsage, estimateCostUSD } from "../src/lib/core.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "yeschef-test-"));
}

describe("loop detection", () => {
  it("flags 3x identical single calls", () => {
    let h = pushCall([], "aaa", 24);
    h = pushCall(h, "aaa", 24);
    expect(detectLoop(h, "aaa", 8, 3).looping).toBe(true);
  });
  it("flags an A-B-A-B-A-B cycle", () => {
    let h: any[] = [];
    for (const x of ["a", "b", "a", "b", "a"]) h = pushCall(h, x, 24);
    expect(detectLoop(h, "b", 8, 3).looping).toBe(true);
  });
  it("does not flag varied work", () => {
    let h: any[] = [];
    for (const x of ["a", "b", "c", "a", "d", "e"]) h = pushCall(h, x, 24);
    expect(detectLoop(h, "f", 8, 3).looping).toBe(false);
  });
  it("does not flag a single retry", () => {
    const h = pushCall([], "aaa", 24);
    expect(detectLoop(h, "aaa", 8, 3).looping).toBe(false);
  });
  it("respects the window cap", () => {
    let h: any[] = [];
    for (let i = 0; i < 40; i++) h = pushCall(h, `x${i}`, 10);
    expect(h.length).toBe(10);
  });
});

describe("test output compaction", () => {
  const dir = tmp();
  it("recognizes test commands", () => {
    expect(looksLikeTestCommand("python -m pytest -q tests/")).toBe(true);
    expect(looksLikeTestCommand("npx vitest run")).toBe(true);
    expect(looksLikeTestCommand("npm test")).toBe(true);
    expect(looksLikeTestCommand("npm t")).toBe(true);
    expect(looksLikeTestCommand("make test")).toBe(true);
    expect(looksLikeTestCommand("./gradlew test")).toBe(true);
    expect(looksLikeTestCommand("mvn clean test")).toBe(true);
    expect(looksLikeTestCommand("ctest --output-on-failure")).toBe(true);
    expect(looksLikeTestCommand("node_modules/.bin/jest --ci")).toBe(true);
    expect(looksLikeTestCommand("CI=true jest")).toBe(true);
    expect(looksLikeTestCommand("npm run build && npx vitest run")).toBe(true);
    expect(looksLikeTestCommand("git status")).toBe(false);
  });
  it("does not classify runner names in ARGUMENTS as test runs", () => {
    // A false positive routes output through the test path (skipping the
    // generic size cap) and can flip the shared red/green signal the stop
    // guard reads — from a grep result.
    expect(looksLikeTestCommand("cat jest.config.js")).toBe(false);
    expect(looksLikeTestCommand("grep -r vitest src/")).toBe(false);
    expect(looksLikeTestCommand("git log --grep=mocha")).toBe(false);
    expect(looksLikeTestCommand("ls tests/jest/")).toBe(false);
    expect(looksLikeTestCommand("cat ./scripts/jest-report.sh")).toBe(false);
    expect(looksLikeTestCommand("make build")).toBe(false);
    expect(looksLikeTestCommand("mvn clean install")).toBe(false);
  });
  it("compacts green pytest to a one-liner", () => {
    const out = Array.from({ length: 300 }, (_, i) => `tests/test_x.py::test_${i} PASSED`).join("\n") +
      "\n========== 300 passed in 2.41s ==========";
    const r = compactTestOutput(out, false, dir);
    expect(r.kind).toBe("tests-green");
    expect(r.text.length).toBeLessThan(400);
    expect(r.text).toContain("300 passed");
  });
  it("trusts a zero exit + green summary over 'Error'/'FAILED' in test names", () => {
    // A passing run whose test NAMES mention error/fail must stay green — the
    // FAIL_MARK substring heuristic must not override a known-zero exit.
    const out = [
      "✓ throws Error when input is invalid (12ms)",
      "✓ returns 500 on the FAILED-auth path (4ms)",
      "✓ handles error recovery gracefully (3ms)",
      "✓ logs Error details without crashing (2ms)",
      "",
      "Test Files  1 passed (1)",
      "Tests  4 passed (4)",
      "Duration  1.2s",
    ].join("\n");
    const r = compactTestOutput(out, false, dir);
    expect(r.kind).toBe("tests-green");
  });
  it("keeps failure sections on red runs", () => {
    const out = [
      ...Array.from({ length: 100 }, (_, i) => `collecting item ${i}`),
      "=================================== FAILURES ===================================",
      "_______ test_login _______",
      "AssertionError: expected 200 got 401",
      "=========================== short test summary info ============================",
      "FAILED tests/test_auth.py::test_login - AssertionError",
      "========================= 1 failed, 41 passed in 3.02s =========================",
    ].join("\n");
    const r = compactTestOutput(out, true, dir);
    expect(r.kind).toBe("tests-failed");
    expect(r.text).toContain("AssertionError: expected 200 got 401");
    expect(r.text).not.toContain("collecting item 50");
  });
  it("char-caps the kept failure section (one-line jest diffs must not flood context)", () => {
    // 100 kept lines × 5k chars sails under the 220-LINE cap at ~500KB —
    // the char ceiling has to bound it.
    const out = "=== FAILURES ===\n" +
      Array.from({ length: 100 }, (_, i) => `AssertionError ${i}: ${"x".repeat(5000)}`).join("\n") +
      "\n=== 100 failed in 3s ===";
    const r = compactTestOutput(out, true, dir);
    expect(r.kind).toBe("tests-failed");
    expect(r.text.length).toBeLessThan(25_000);
    expect(r.text).toContain("char-capped");
  });
});

describe("generic truncation", () => {
  const dir = tmp();
  it("leaves small output alone", () => {
    expect(truncateGeneric("hello\nworld", 200, 8000, 80, 10, dir).kind).toBe("unchanged");
  });
  it("enforces the char cap even when the output is few huge lines", () => {
    // Truncation must bound CHARS, not just lines: a minified bundle / one-line
    // JSON blob of 50k chars in a single line must not sail through the "head"
    // untouched and land in context anyway.
    const out = "x".repeat(50_000);
    const r = truncateGeneric(out, 200, 8000, 80, 10, dir);
    expect(r.kind).toBe("truncated");
    expect(r.text.length).toBeLessThan(12_000); // maxChars + tail + pointer slack
    expect(r.savedChars).toBeGreaterThan(30_000);
  });
  it("truncates huge output with head, tail and pointer", () => {
    const out = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const r = truncateGeneric(out, 200, 8000, 80, 10, dir);
    expect(r.kind).toBe("truncated");
    expect(r.text).toContain("line 0");
    expect(r.text).toContain("line 999");
    expect(r.text).toContain("Full output:");
    expect(r.savedChars).toBeGreaterThan(0);
  });
});

describe("response text extraction", () => {
  it("handles strings, {stdout}, and content blocks", () => {
    expect(extractResponseText("x")!.text).toBe("x");
    const o = extractResponseText({ stdout: "out", stderr: "" })!;
    expect(o.rebuild("new")).toEqual({ stdout: "new", stderr: "" });
    const c = extractResponseText({ content: [{ type: "text", text: "t" }] })!;
    expect(c.rebuild("u").content[0].text).toBe("u");
  });
  it("includes stderr in the extracted text and empties it on rebuild", () => {
    // vitest/jest/npm write results to stderr; extraction that only saw stdout
    // let 200KB of stderr enter context uncompacted (and skipped the failing-
    // tests signal entirely when stdout was empty).
    const r = extractResponseText({ stdout: "", stderr: "3 failed", exit_code: 1 })!;
    expect(r.text).toBe("3 failed");
    expect(r.rebuild("compacted")).toEqual({ stdout: "compacted", stderr: "", exit_code: 1 });
    const both = extractResponseText({ stdout: "out", stderr: "err" })!;
    expect(both.text).toBe("out\nerr");
  });
  it("extracts ALL content text blocks and empties the extras on rebuild", () => {
    // Rewriting only the largest block let a dump split across several medium
    // blocks stay over the size cap while the savings were credited anyway.
    const dump = "x".repeat(500);
    const r = extractResponseText({ content: [{ type: "text", text: "summary" }, { type: "text", text: dump }, { type: "image", data: "d" }] })!;
    expect(r.text).toBe(`summary\n${dump}`);
    const rebuilt = r.rebuild("small");
    expect(rebuilt.content[0].text).toBe("small");     // compacted text lands in the first text block
    expect(rebuilt.content[1].text).toBe("");          // nothing survives uncompacted
    expect(rebuilt.content[2]).toEqual({ type: "image", data: "d" }); // non-text untouched
  });
});

describe("batch digest", () => {
  let root: string;
  beforeEach(() => {
    root = tmp();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "main.ts"), "export function handler() {\n  return 42;\n}\n");
    writeFileSync(join(root, "src", "util.ts"), "export const helper = () => 'handler-adjacent';\n");
    writeFileSync(join(root, "readme.md"), "# Fixture\n");
  });
  it("runs glob, grep and read ops in one call", () => {
    const out = runBatchDigest(root, [
      { glob: "**/*.ts" },
      { grep: "handler", glob: "**/*.ts" },
      { read: "src/main.ts", start: 1, end: 3 },
    ]);
    expect(out).toContain("GLOB **/*.ts → 2 file(s)");
    expect(out).toContain("src/main.ts:1");
    expect(out).toContain("READ src/main.ts lines 1-3");
    expect(out).toContain("export function handler()");
  });
  it("caps oversized digests", () => {
    writeFileSync(join(root, "big.txt"), Array.from({ length: 500 }, (_, i) => `match ${i}`).join("\n"));
    const out = runBatchDigest(root, [{ read: "big.txt", start: 1, end: 500 }], 1000);
    expect(out.length).toBeLessThan(1200);
    expect(out).toContain("capped");
  });
});

describe("folder description", () => {
  it("annotates dirs with counts and key files", () => {
    const root = tmp();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-pkg", description: "a fixture" }));
    writeFileSync(join(root, "src", "index.ts"), "//");
    const text = buildFolderDescription(root, 2);
    expect(text).toContain("npm:fixture-pkg");
    expect(text).toContain("src/");
    expect(text).toContain("key: package.json");
  });
});

describe("test-outcome classification", () => {
  it("treats a zero exit + green summary as passing despite failure words in test names", () => {
    expect(isTestFailure("✓ handles the FAILED-auth case\nTests  2 passed (2)", false)).toBe(false);
    expect(isTestFailure("✓ throws Error on bad input\n5 passed", false)).toBe(false);
  });
  it("flags a nonzero exit, or failure markers with no green summary", () => {
    expect(isTestFailure("panic: boom", true)).toBe(true);
    expect(isTestFailure("Error: crash with no green summary here", false)).toBe(true);
  });
  it("lets an explicit failure count beat a green summary even on a zero exit", () => {
    // `vitest run | tail` exits 0 (pipe takes tail's code) — the OUTPUT is the
    // only truth. "1 failed | 16 passed" satisfies both regexes; failed must win.
    expect(isTestFailure("Tests  1 failed | 16 passed (17)", false)).toBe(true);
    expect(isTestFailure("Tests: 2 failed, 5 passed, 7 total", false)).toBe(true);
    expect(isTestFailure("1 failed, 41 passed in 3.02s", false)).toBe(true);
    expect(isTestFailure("5 examples, 2 failures", false)).toBe(true); // rspec, no colon
    expect(isTestFailure("Tests  0 failed | 38 passed (38)", false)).toBe(false); // zero failed stays green
    expect(isTestFailure("5 examples, 0 failures", false)).toBe(false);
  });
  it("does not let a failure count INSIDE a passing test's name flip a green run", () => {
    // The count signal is line-scoped: "✓ retries 3 failed requests" names the
    // test's subject; only summary-style lines carry the failure verdict.
    expect(isTestFailure("✓ retries 3 failed requests (2ms)\nTests  5 passed (5)", false)).toBe(false);
    expect(isTestFailure("ok 4 - handles 2 failed logins\n1..4", false)).toBe(false);
  });
  it("classifies TAP output correctly despite the exit-code laundering", () => {
    // "not ok" must not satisfy the green \bok\b, and TAP's lowercase
    // "# fail  1" summary must register as a failure.
    expect(isTestFailure("not ok 1 - thing\n# fail  1", false)).toBe(true);
    expect(isTestFailure("ok 1 - thing\nok 2 - other\n# pass  2", false)).toBe(false);
    expect(isTestFailure("ok  \texample.com/pkg\t0.31s", false)).toBe(false); // go test green
  });
});

describe("transcript usage (budget estimation)", () => {
  it("returns null for a missing or absent transcript", () => {
    expect(readUsage(undefined)).toBeNull();
    expect(readUsage(join(tmp(), "does-not-exist.jsonl"))).toBeNull();
  });
  it("sums token buckets across the tail, takes context from the LAST block, skips junk lines", () => {
    const p = join(tmp(), "transcript.jsonl");
    writeFileSync(p, [
      JSON.stringify({ message: { model: "claude-haiku-4-5", usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50 } } }),
      JSON.stringify({ type: "note", text: "no usage on this line" }),
      '{ "usage": this-is-not-valid-json',   // contains "usage" but unparseable → skipped
      JSON.stringify({ message: { model: "claude-sonnet-5", usage: { input_tokens: 200, output_tokens: 20, cache_creation_input_tokens: 30 } } }),
    ].join("\n") + "\n");
    const u = readUsage(p)!;
    expect(u.contextTokens).toBe(230);   // last block only: 200 input + 30 cache_creation
    expect(u.buckets.inTok).toBe(300);   // 100 + 200 across blocks
    expect(u.buckets.cacheRead).toBe(50);
    expect(u.buckets.cacheWrite).toBe(30);
    expect(u.buckets.out).toBe(30);      // 10 + 20 across blocks
    expect(u.model).toBe("claude-sonnet-5");
  });
  // Claude Code splits cache writes by TTL under cache_creation; the 1h slice bills at
  // 2x base input instead of 1.25x, so it has to survive into its own bucket.
  it("captures the 1-hour slice of cache writes without double-counting the total", () => {
    const p = join(tmp(), "transcript-ttl.jsonl");
    writeFileSync(p, [
      JSON.stringify({ message: { model: "claude-opus-5", usage: {
        input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 1000,
        cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 },
      } } }),
      JSON.stringify({ message: { model: "claude-opus-5", usage: {
        input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 500,
      } } }),   // no TTL breakdown → treated as 5-minute
    ].join("\n") + "\n");
    const u = readUsage(p)!;
    expect(u.buckets.cacheWrite).toBe(1500);    // total across both blocks
    expect(u.buckets.cacheWrite1h).toBe(600);   // subset billed at 2x
    // 20 in x $5 + 5 out x $25 + 900 write @1.25x$5 + 600 write @2x$5 = per MTok
    expect(estimateCostUSD(u)).toBeCloseTo((20 * 5 + 5 * 25 + 900 * 6.25 + 600 * 10) / 1e6);
  });
});

describe("cost estimation (cache-aware, by model tier)", () => {
  const cost = (model: string | null, b: Partial<{ inTok: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; out: number }>) =>
    estimateCostUSD({ contextTokens: 0, model, buckets: { inTok: 0, cacheRead: 0, cacheWrite: 0, out: 0, ...b } });
  it("prices input + output per tier, defaulting unknown to Opus", () => {
    expect(cost("claude-haiku-4-5", { inTok: 1e6, out: 1e6 })).toBeCloseTo(6);   // 1 + 5
    expect(cost("claude-sonnet-5", { inTok: 1e6, out: 1e6 })).toBeCloseTo(12);   // 2 + 10
    expect(cost("claude-opus-4-8", { inTok: 1e6, out: 1e6 })).toBeCloseTo(30);   // 5 + 25
    expect(cost("claude-fable-5", { inTok: 1e6, out: 1e6 })).toBeCloseTo(60);    // 10 + 50
    expect(cost(null, { inTok: 1e6, out: 1e6 })).toBeCloseTo(30);
  });
  // Sonnet 5 is $2/$10 while Sonnet 4.6 and 4.5 stayed at $3/$15, so the specific
  // key has to beat the family key regardless of declaration order.
  it("matches the most specific model key, not the first one declared", () => {
    expect(cost("claude-sonnet-5", { inTok: 1e6, out: 1e6 })).toBeCloseTo(12);   // 2 + 10
    expect(cost("claude-sonnet-4-6", { inTok: 1e6, out: 1e6 })).toBeCloseTo(18); // 3 + 15
    expect(cost("claude-sonnet-4-5", { inTok: 1e6, out: 1e6 })).toBeCloseTo(18); // 3 + 15
    expect(cost("sonnet", { inTok: 1e6, out: 1e6 })).toBeCloseTo(12);            // bare alias → current gen
    expect(cost("opus", { inTok: 1e6, out: 1e6 })).toBeCloseTo(30);              // bare alias → current gen
    expect(cost("haiku", { inTok: 1e6, out: 1e6 })).toBeCloseTo(6);              // bare alias → current gen
    expect(cost("claude-opus-4-1", { inTok: 1e6, out: 1e6 })).toBeCloseTo(90);   // 15 + 75
    expect(cost("claude-opus-5", { inTok: 1e6, out: 1e6 })).toBeCloseTo(30);     // 5 + 25
  });
  it("discounts cache reads (0.1×) and surcharges cache writes (1.25× at 5m, 2× at 1h)", () => {
    expect(cost("claude-opus-4-8", { cacheRead: 1e6 })).toBeCloseTo(0.5);   // 5 × 0.1
    expect(cost("claude-opus-4-8", { cacheWrite: 1e6 })).toBeCloseTo(6.25); // 5 × 1.25, no TTL split → 5m
    // cacheWrite1h is a SUBSET of cacheWrite: 1M total of which 1M at the 1h rate.
    expect(cost("claude-opus-4-8", { cacheWrite: 1e6, cacheWrite1h: 1e6 })).toBeCloseTo(10);   // 5 × 2
    expect(cost("claude-opus-4-8", { cacheWrite: 2e6, cacheWrite1h: 1e6 })).toBeCloseTo(16.25); // 6.25 + 10
  });
  // Cache hits on Fable/Mythos 5.1 are 0.025× base input, not the usual 0.1×.
  it("applies the Fable/Mythos 5.1 cache-read exception", () => {
    expect(cost("claude-fable-5-1", { cacheRead: 1e6 })).toBeCloseTo(0.25);  // 10 × 0.025
    expect(cost("claude-mythos-5-1", { cacheRead: 1e6 })).toBeCloseTo(0.25); // 10 × 0.025
    expect(cost("claude-fable-5", { cacheRead: 1e6 })).toBeCloseTo(1);       // 10 × 0.1
  });
});

describe("shell invocation (run_tests)", () => {
  // Model what `cmd.exe /s /c` does to its command string: if the first char is
  // a quote, strip the first and last quote. The whole reason run_tests wraps the
  // command is so this strip recovers exactly the original — no lost leading quote.
  const cmdSlashS = (s: string) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);

  it("uses /bin/sh -c and passes the command verbatim on POSIX", () => {
    const sh = buildShellCommand("npx vitest run", "linux");
    expect(sh).toEqual({ file: "/bin/sh", args: ["-c", "npx vitest run"], verbatim: false });
  });

  it("wraps the command for cmd.exe /d /s /c with verbatim args on Windows", () => {
    const sh = buildShellCommand("npm test", "win32");
    expect(sh.file).toBe("cmd.exe");
    expect(sh.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(sh.args[3]).toBe('"npm test"');
    expect(sh.verbatim).toBe(true);
  });

  it("survives cmd /s stripping for plain, quoted-path, and internal-quote commands", () => {
    for (const command of [
      "npm test",
      '"C:\\Program Files\\nodejs\\node.exe" script.js',   // starts with a quoted path
      'node "C:\\My Tests\\run.js" --flag',                 // internal quotes
      "pytest -q && echo done",                             // shell operator preserved
    ]) {
      const passedToCmd = buildShellCommand(command, "win32").args[3]!;
      expect(cmdSlashS(passedToCmd)).toBe(command);
    }
  });

  it("actually executes on the host and captures stdout", () => {
    const sh = buildShellCommand("echo yeschef-marker");
    // @types/node@18 omits windowsVerbatimArguments from the sync options type
    // (the async execFile the server uses has it); pass as any and stringify.
    const opts: any = { windowsVerbatimArguments: sh.verbatim, encoding: "utf8" };
    const out = String(execFileSync(sh.file, sh.args, opts));
    expect(out).toContain("yeschef-marker");
  });
});
