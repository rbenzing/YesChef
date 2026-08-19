// Tool-result compression: BouzéCode's pytest compaction generalized to common
// test runners, plus generic truncation with overflow-to-disk pointers.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface CompactResult {
  text: string;
  savedChars: number;
  kind: "tests-failed" | "tests-green" | "truncated" | "unchanged";
}

// A runner name must sit at a COMMAND position — start of a shell segment
// (after ;|&, $( or a newline), past env assignments and known launchers —
// so a mere mention in an argument (`cat jest.config.js`, `grep vitest src/`)
// doesn't route the output through the test path (which would skip truncation
// and corrupt the shared red/green test signal the stop guard reads).
const RUNNERS = String.raw`pytest|py\.test|jest|vitest|phpunit|rspec|mocha|tape|ava|tox|ctest|unittest`;
const LAUNCHERS = String.raw`(?:npx\s+|bunx\s+|(?:pnpm|yarn)\s+(?:exec|dlx)\s+|uv\s+run\s+|python3?\s+-m\s+|py\s+-m\s+)?`;
const TEST_CMD = new RegExp(
  String.raw`(?:^|[;&|\n]|\$\()\s*` +
  String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*` +      // CI=true ...
  String.raw`(?:sudo\s+|time\s+)?` +
  String.raw`(?:` +
    LAUNCHERS + String.raw`(?:\S*[\\/])?(?:${RUNNERS})\b(?![.\\/-])` + // runner exe, optionally path-invoked; excludes jest.config.js / jest-report.sh
    String.raw`|go\s+test\b|dotnet\s+test\b|cargo\s+(?:test|nextest)\b` +
    String.raw`|(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?test\b|npm\s+t\b` +
    String.raw`|make\s+test\b|(?:\S*[\\/])?gradlew(?:\.bat)?\s+[^;&|\n]*\btest\b|mvn\s+[^;&|\n]*\btest\b` +
  String.raw`)`
);

export function looksLikeTestCommand(command: string): boolean {
  return TEST_CMD.test(command);
}

// Char ceiling for the kept failure section (~5k tokens) — generous enough for
// real assertion diffs, small enough that a pathological run can't flood context.
const FAIL_CHAR_CAP = 20_000;

function saveOverflow(dir: string, label: string, full: string): string | null {
  const name = `${label}-${createHash("md5").update(full).digest("hex").slice(0, 8)}.txt`;
  const p = join(dir, name);
  // A pointer to a file that was never written is a lie the model will chase.
  try { writeFileSync(p, full); } catch { return null; }
  return p;
}

/** Frameworks signal failure sections differently; collect the lines worth keeping. */
function extractFailureLines(lines: string[]): string[] {
  const kept: string[] = [];
  let inSection = false;
  const sectionStart = /^(=+\s*(FAILURES|ERRORS)\s*=+|FAIL\b|●\s|✗|✖|Error:|\s*\d+\)\s|FAILED\b|panic:|--- FAIL)/;
  const summary = /(=+ .*(passed|failed|error).* =+|Tests?:.*|Test Suites:.*|^FAILED\b.*|^OK\b.*|\d+ pass(ed|ing).*|\d+ fail(ed|ing).*|--- FAIL.*|^ok\s|^FAIL\s|Results?:.*|Finished in .*|\d+ examples?, \d+ failures?)/i;
  for (const line of lines) {
    if (sectionStart.test(line)) inSection = true;
    else if (/^=+\s*(warnings summary|short test summary)/i.test(line)) inSection = false;
    if (inSection) kept.push(line);
    else if (summary.test(line)) kept.push(line);
  }
  return kept;
}

// `^ok` (not `\bok\b`): go/TAP pass lines START with "ok"; a bare \bok\b also
// matched TAP's "not ok" failure lines, classifying failing TAP runs as green.
const GREEN_SUMMARY = /(\d+ (passed|passing)|^ok\b|Tests?:\s.*pass|All tests passed|test result: ok)/im;
const FAIL_MARK = /(\bFAILED\b|\bFAIL\b|✗|✖|●|\bError\b|panic:|failures?:\s*[1-9]|\d+ (failed|failing))/;

// An explicit nonzero failure count ("1 failed", "failures: 3", rspec "2 failures").
const HARD_FAIL = /([1-9]\d*\s+fail(ed|ing|ures?)\b|failures?:\s*[1-9])/i;
// TAP failure lines: "not ok 3 - ..." and summary "# fail  2".
const TAP_FAIL_LINE = /^(not ok\b|#\s*fail\w*\s+[1-9])/i;
// A line that is a PASSING test's name (vitest/jest ✓, TAP "ok 3", PASS banner) —
// failure words inside such a line describe the test's subject, not the outcome.
const PASS_NAME_LINE = /^\s*(✓|✔|ok\s+\d|PASS\b)/;

/**
 * Single source of truth for "did this test run fail?". Precedence:
 * 1. a nonzero exit code fails, always;
 * 2. an explicit failure count or TAP failure line fails even on a zero exit —
 *    pipes (`vitest | tail`) launder the exit code — but only when the count is
 *    NOT inside a passing test's name line ("✓ retries 3 failed requests");
 * 3. otherwise a green summary wins over weak markers ("Error"/"FAILED" in a
 *    test NAME must not flip a passing run to failed).
 * Shared by compaction, run_tests, and the post-tool progress tracker.
 */
export function isTestFailure(output: string, exitCodeNonZero: boolean): boolean {
  if (exitCodeNonZero) return true;
  for (const line of output.split("\n")) {
    if (TAP_FAIL_LINE.test(line)) return true;
    if (HARD_FAIL.test(line) && !PASS_NAME_LINE.test(line)) return true;
  }
  const looksGreen = GREEN_SUMMARY.test(output);
  const looksFailed = FAIL_MARK.test(output) && !/0 failed/i.test(output);
  return looksFailed && !looksGreen;
}

export function compactTestOutput(
  output: string,
  exitCodeNonZero: boolean,
  overflowPath: string
): CompactResult {
  const lines = output.split("\n");
  const failed = isTestFailure(output, exitCodeNonZero);
  if (!failed && GREEN_SUMMARY.test(output)) {
    const summaryLines = lines.filter((l) => GREEN_SUMMARY.test(l)).slice(-3);
    const text = `[yeschef] tests green. ${summaryLines.join(" | ").trim() || "all passed"}`;
    return finish(text, output, overflowPath, "tests-green");
  }
  if (failed) {
    let kept = extractFailureLines(lines);
    if (kept.length === 0) kept = lines.slice(-60); // unknown framework: tail has the error
    if (kept.length > 220) kept = [...kept.slice(0, 180), `  … ${kept.length - 200} failure lines omitted …`, ...kept.slice(-20)];
    let body = kept.join("\n");
    // A line cap alone doesn't bound size: 200 kept lines of one-line jest
    // object diffs can still be hundreds of KB. Enforce a char ceiling too.
    if (body.length > FAIL_CHAR_CAP) {
      body = body.slice(0, FAIL_CHAR_CAP - 1500) + "\n  …[yeschef] failure detail char-capped…\n" + body.slice(-1200);
    }
    const text = `[yeschef] test failures (compacted):\n${body}`;
    return finish(text, output, overflowPath, "tests-failed");
  }
  return { text: output, savedChars: 0, kind: "unchanged" };
}

function finish(text: string, full: string, overflowDir: string, kind: CompactResult["kind"]): CompactResult {
  if (text.length >= full.length) return { text: full, savedChars: 0, kind: "unchanged" };
  const p = saveOverflow(overflowDir, "test", full);
  const out = p ? `${text}\n[yeschef] full output: ${p}` : text;
  return { text: out, savedChars: full.length - out.length, kind };
}

export function truncateGeneric(
  output: string,
  maxLines: number,
  maxChars: number,
  headLines: number,
  tailLines: number,
  overflowDir: string
): CompactResult {
  const lines = output.split("\n");
  if (lines.length <= maxLines && output.length <= maxChars) {
    return { text: output, savedChars: 0, kind: "unchanged" };
  }
  const p = saveOverflow(overflowDir, "bash", output);
  // Bound CHARS as well as lines: a few enormous lines (minified JS, one-line
  // JSON) must not sail through the head/tail untouched — and when the output
  // has fewer lines than head+tail, skip the tail so the same lines aren't
  // emitted twice.
  let head = lines.slice(0, headLines).join("\n");
  const headClipped = head.length > maxChars;
  if (headClipped) head = head.slice(0, maxChars) + "…[clipped at char cap]";
  let tail = tailLines > 0 && lines.length > headLines + tailLines ? lines.slice(-tailLines).join("\n") : "";
  const tailCap = Math.max(500, Math.floor(maxChars / 8));
  if (tail.length > tailCap) tail = "…" + tail.slice(-tailCap);
  // Honest omission report: count only lines actually dropped (the tail is
  // skipped entirely when head already covers those lines), and name the char
  // clip when that's what did the cutting.
  const omitted = Math.max(0, lines.length - headLines - (tail ? tailLines : 0));
  const what = [omitted > 0 ? `${omitted} lines` : "", headClipped ? "long lines char-clipped" : ""].filter(Boolean).join(", ") || "content";
  const text =
    `${head}\n[yeschef] truncated: ${what} (${output.length} chars total) omitted. ` +
    (p ? `Full output: ${p}\n` : "") +
    `Re-run with a filter (grep/head) or read specific ranges if you need more.` +
    (tail ? `\n--- tail ---\n${tail}` : "");
  return { text, savedChars: Math.max(0, output.length - text.length), kind: "truncated" };
}

/** Pull plain text out of whatever shape a tool_response takes; remember how to put it back. */
export function extractResponseText(resp: any): { text: string; rebuild: (t: string) => any } | null {
  if (typeof resp === "string") return { text: resp, rebuild: (t) => t };
  if (resp && typeof resp === "object") {
    if (typeof resp.stdout === "string") {
      // Include stderr: test runners (vitest/jest/npm) write results there, and a
      // rewrite that only touched stdout left the full stderr in context while
      // crediting the savings. The rebuilt shape carries the compacted text in
      // stdout and empties stderr so nothing survives uncompacted.
      const err = typeof resp.stderr === "string" ? resp.stderr : "";
      return {
        text: err ? (resp.stdout ? `${resp.stdout}\n${err}` : err) : resp.stdout,
        rebuild: (t) => ({ ...resp, stdout: t, ...(err ? { stderr: "" } : {}) }),
      };
    }
    if (typeof resp.output === "string") {
      return { text: resp.output, rebuild: (t) => ({ ...resp, output: t }) };
    }
    if (Array.isArray(resp.content)) {
      // Extract EVERY text block, not just the largest — a dump split across
      // several medium blocks previously kept all but one out of the size cap.
      // The compacted text lands in the first text block and the rest are
      // emptied, mirroring the stdout/stderr contract above.
      const idx: number[] = [];
      for (let i = 0; i < resp.content.length; i++) {
        const b = resp.content[i];
        if (b?.type === "text" && typeof b.text === "string") idx.push(i);
      }
      if (idx.length > 0) {
        return {
          text: idx.map((i) => resp.content[i].text).join("\n"),
          rebuild: (t) => ({
            ...resp,
            content: resp.content.map((b: any, i: number) =>
              i === idx[0] ? { ...b, text: t } : idx.includes(i) ? { ...b, text: "" } : b),
          }),
        };
      }
    }
  }
  return null;
}
