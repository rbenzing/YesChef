import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSection, appendToSection, checkPlanItem, openPlanItems, readNotes, compactNotes } from "../src/lib/notes.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "yeschef-notes-"));
  process.env.YESCHEF_HOME = mkdtempSync(join(tmpdir(), "yeschef-home-"));
});

describe("mise-en-place notes", () => {
  it("sets and reads sections", () => {
    setSection(cwd, "goal", "Ship the widget");
    appendToSection(cwd, "plan", "- [ ] write widget\n- [ ] test widget");
    const text = readNotes(cwd);
    expect(text).toContain("Ship the widget");
    expect(openPlanItems(text)).toEqual(["write widget", "test widget"]);
  });
  it("does not let a '## heading' line in content bleed into another section", () => {
    // Adversarial/accidental content: a discovery note that contains a line
    // looking like a section header must NOT reparse into the plan section and
    // become a fake open plan item (which would block the stop guard).
    appendToSection(cwd, "discoveries", "found the root cause\n## plan\n- [ ] not a real task");
    const text = readNotes(cwd);
    expect(openPlanItems(text)).toEqual([]);
    expect(text).toContain("not a real task"); // content preserved, just not as a plan item
  });
  it("only checks off items that live in the plan section", () => {
    // A checkbox-looking line in discoveries is prose, not a plan item; checking
    // it off (a) mutates prose and (b) desyncs with openPlanItems, which only
    // scans the plan — the check-off must target the plan section exclusively.
    setSection(cwd, "plan", "- [ ] real task");
    appendToSection(cwd, "discoveries", "- [ ] checkbox pasted into prose");
    expect(checkPlanItem(cwd, "checkbox pasted")).toBeNull();
    expect(checkPlanItem(cwd, "real task")).toContain("- [x] real task");
  });
  it("refuses an empty check-off needle instead of matching the first item", () => {
    setSection(cwd, "plan", "- [ ] first\n- [ ] second");
    expect(checkPlanItem(cwd, "")).toBeNull();
    expect(checkPlanItem(cwd, "   ")).toBeNull();
    expect(openPlanItems(readNotes(cwd))).toEqual(["first", "second"]); // nothing silently checked
  });
  it("checks off plan items by substring", () => {
    setSection(cwd, "plan", "- [ ] write widget\n- [ ] test widget");
    expect(checkPlanItem(cwd, "test widget")).toContain("- [x] test widget");
    expect(openPlanItems(readNotes(cwd))).toEqual(["write widget"]);
    expect(checkPlanItem(cwd, "nonexistent")).toBeNull();
  });
  it("structurally compacts: dedupes and archives checked items", () => {
    const noisy = [
      "# Mise en place",
      "## goal", "Ship it",
      "## plan", "- [x] done thing", "- [ ] open thing",
      "## discoveries", "fact A", "fact A", "fact B",
      "## decisions", "",
    ].join("\n");
    const { text } = compactNotes(noisy);
    expect(text).toContain("(1 completed item archived)");
    expect(text).not.toContain("- [x] done thing");
    expect(text).toContain("- [ ] open thing");
    expect(text.match(/fact A/g)!.length).toBe(1);
  });
  it("preserves unknown sections and preamble content across rewrites", () => {
    // Hand-edited or older-format notes must not be destroyed by the next write:
    // joinSections used to silently drop everything outside the four canonical
    // sections.
    const handEdited = [
      "# Mise en place",
      "important preamble line",
      "## goal", "Ship it",
      "## plan", "- [ ] task",
      "## discoveries",
      "## decisions",
      "## scratch", "custom section content",
    ].join("\n");
    const { text } = compactNotes(handEdited);
    expect(text).toContain("important preamble line");
    expect(text).toContain("## scratch");
    expect(text).toContain("custom section content");
  });
  it("survives prototype-property section headers in hand-edited notes", () => {
    // '## constructor' must become an ordinary bucket, not resolve to
    // Object.prototype.constructor and crash .push() on every read thereafter.
    const hostile = "# Mise en place\n## constructor\nboom\n## goal\nStay alive\n## plan\n## discoveries\n## decisions\n";
    const { text } = compactNotes(hostile);
    expect(text).toContain("Stay alive");
    expect(text).toContain("boom"); // preserved as an unknown section
  });
});
