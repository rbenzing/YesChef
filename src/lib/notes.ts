// Mise-en-place notes: the shared scratchpad (goal / plan / discoveries / decisions)
// that BouzéCode calls the "methodology note". ONE namespace per project — the MCP
// server, the stop guard, the compaction re-seed, and the session-start resume all
// read the same notes-kitchen.md. The session id was deliberately removed from this
// API: three separate call sites independently passed a real session id and silently
// read a file nothing writes; now the mistake cannot type-check.
// Structural compaction at a size threshold: dedupe lines, archive checked plan items.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, stateDir } from "./core.js";

export const SECTIONS = ["goal", "plan", "discoveries", "decisions"] as const;
export type Section = (typeof SECTIONS)[number];

/** Filename token for the shared per-project notes ("kitchen") — exported for tests. */
export const KITCHEN_ID = "kitchen";

/** The one section-header anchor. splitSections, checkPlanItem, and
 * neutralizeHeaders MUST agree on it — three hand-copied variants drifted before. */
const SECTION_HEADER_RE = /^##\s+(\w+)/;

export function notesPath(cwd: string): string {
  return join(ensureDir(stateDir(cwd)), `notes-${KITCHEN_ID}.md`);
}

const TEMPLATE = `# Mise en place
## goal
(unset — write one sentence)
## plan
## discoveries
## decisions
`;

export function readNotes(cwd: string): string {
  const p = notesPath(cwd);
  if (!existsSync(p)) return TEMPLATE;
  try { return readFileSync(p, "utf8"); } catch { return TEMPLATE; }
}

function writeNotes(cwd: string, text: string): void {
  writeFileSync(notesPath(cwd), text);
}

// A stored line that looks like a section header (matches SECTION_HEADER_RE)
// would be re-parsed as one on the next read, silently relocating content
// between sections. Indent such lines so the anchor no longer matches; the
// text stays visible and stays in its own section.
function neutralizeHeaders(content: string): string {
  return content.split("\n").map((l) => (SECTION_HEADER_RE.test(l) ? ` ${l}` : l)).join("\n");
}

function splitSections(text: string): Record<string, string[]> {
  // Null-prototype map: a hand-edited header like "## constructor" must become
  // an ordinary bucket, not resolve to Object.prototype and crash .push().
  const out: Record<string, string[]> = Object.create(null);
  let current = "_preamble";
  out[current] = [];
  for (const line of text.split("\n")) {
    const m = line.match(SECTION_HEADER_RE);
    if (m) { current = m[1]!.toLowerCase(); out[current] = out[current] ?? []; continue; }
    out[current]!.push(line);
  }
  return out;
}

function joinSections(sections: Record<string, string[]>): string {
  const lines: string[] = ["# Mise en place"];
  // Preserve preamble content (anything above the first header, minus the title
  // itself) — rebuilding used to silently delete it.
  const preamble = (sections["_preamble"] ?? []).filter((l) => l.trim() && l.trim() !== "# Mise en place");
  lines.push(...preamble);
  for (const s of SECTIONS) {
    lines.push(`## ${s}`);
    const body = (sections[s] ?? []).filter((l, i, a) => !(l.trim() === "" && (a[i - 1] ?? "").trim() === ""));
    lines.push(...body);
  }
  // Preserve non-canonical sections (hand edits, older formats) instead of
  // destroying them on the next write.
  for (const name of Object.keys(sections)) {
    if (name === "_preamble" || (SECTIONS as readonly string[]).includes(name)) continue;
    const body = (sections[name] ?? []).filter((l) => l.trim());
    if (body.length === 0) continue;
    lines.push(`## ${name}`);
    lines.push(...body);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

export function setSection(cwd: string, section: Section, content: string): string {
  const sections = splitSections(readNotes(cwd));
  sections[section] = neutralizeHeaders(content).split("\n");
  const text = joinSections(sections);
  writeNotes(cwd, text);
  return text;
}

export function appendToSection(cwd: string, section: Section, content: string): string {
  const sections = splitSections(readNotes(cwd));
  sections[section] = [...(sections[section] ?? []), ...neutralizeHeaders(content).split("\n")];
  const text = joinSections(sections);
  writeNotes(cwd, text);
  return text;
}

/** Toggle "- [ ] item" -> "- [x] item" by fuzzy substring match in the plan. Returns updated text or null. */
export function checkPlanItem(cwd: string, itemSubstring: string): string | null {
  const needle = itemSubstring.trim().toLowerCase();
  if (!needle) return null; // an empty needle matches every line — refuse rather than check off an arbitrary item
  const text = readNotes(cwd);
  let found = false;
  let section = "_preamble";
  const updated = text.split("\n").map((l) => {
    const m = l.match(SECTION_HEADER_RE);
    if (m) { section = m[1]!.toLowerCase(); return l; }
    // Only the plan section holds plan items — a checkbox pasted into
    // discoveries/decisions is prose. Keeps check-off in sync with openPlanItems.
    if (!found && section === "plan" && /^\s*-\s*\[ \]/.test(l) && l.toLowerCase().includes(needle)) {
      found = true;
      return l.replace("[ ]", "[x]");
    }
    return l;
  }).join("\n");
  if (!found) return null;
  writeNotes(cwd, updated);
  return updated;
}

export function openPlanItems(text: string): string[] {
  const sections = splitSections(text);
  return (sections["plan"] ?? []).filter((l) => /^\s*-\s*\[ \]/.test(l)).map((l) => l.replace(/^\s*-\s*\[ \]\s*/, "").trim());
}

/** Structural compaction (no LLM): dedupe identical lines, move checked plan items to a count, cap discoveries. */
export function compactNotes(text: string): { text: string; saved: number } {
  const before = text.length;
  const sections = splitSections(text);
  for (const s of SECTIONS) {
    const seen = new Set<string>();
    sections[s] = (sections[s] ?? []).filter((l) => {
      const key = l.trim();
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  const plan = sections["plan"] ?? [];
  const done = plan.filter((l) => /^\s*-\s*\[x\]/i.test(l)).length;
  if (done > 0) {
    sections["plan"] = [`(${done} completed item${done > 1 ? "s" : ""} archived)`, ...plan.filter((l) => !/^\s*-\s*\[x\]/i.test(l))];
  }
  const disc = sections["discoveries"] ?? [];
  if (disc.length > 120) sections["discoveries"] = [`(${disc.length - 100} older discovery lines archived)`, ...disc.slice(-100)];
  const out = joinSections(sections);
  return { text: out, saved: Math.max(0, before - out.length) };
}

export function maybeCompact(cwd: string, threshold: number): number {
  const text = readNotes(cwd);
  if (text.length <= threshold) return 0;
  const { text: out, saved } = compactNotes(text);
  writeNotes(cwd, out);
  return saved;
}

/** Short summary for re-injection: goal + open plan items + last few discoveries. */
export function notesSummary(cwd: string, maxChars = 1200): string {
  const text = readNotes(cwd);
  const sections = splitSections(text);
  const goal = (sections["goal"] ?? []).map((l) => l.trim()).filter((l) => l && !l.startsWith("(unset")).join(" ");
  const open = openPlanItems(text);
  const disc = (sections["discoveries"] ?? []).map((l) => l.trim()).filter(Boolean).slice(-5);
  const parts = [
    goal ? `Goal: ${goal}` : "",
    open.length ? `Open plan items:\n${open.slice(0, 8).map((i) => `- [ ] ${i}`).join("\n")}` : "",
    disc.length ? `Recent discoveries:\n${disc.map((d) => `- ${d}`).join("\n")}` : "",
  ].filter(Boolean);
  return parts.join("\n").slice(0, maxChars);
}
