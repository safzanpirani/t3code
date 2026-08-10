import { describe, expect, it } from "vite-plus/test";
import { buildFileChangePatch } from "./fileChangePatch.ts";

const FILE = "/repo/src/app.ts";

describe("buildFileChangePatch from a provider structured patch", () => {
  it("renders reported hunks with their real line numbers", () => {
    const patch = buildFileChangePatch(
      { file_path: FILE, old_string: "const a = 1;", new_string: "const a = 2;" },
      {
        filePath: FILE,
        structuredPatch: [
          {
            oldStart: 11,
            oldLines: 3,
            newStart: 11,
            newLines: 3,
            lines: [" before", "-const a = 1;", "+const a = 2;", " after"],
          },
        ],
      },
    );

    expect(patch?.path).toBe(FILE);
    expect(patch?.patch).toBe(
      [
        `diff --git a/${FILE} b/${FILE}`,
        `--- a/${FILE}`,
        `+++ b/${FILE}`,
        "@@ -11,3 +11,3 @@",
        " before",
        "-const a = 1;",
        "+const a = 2;",
        " after",
        "",
      ].join("\n"),
    );
    // Line numbers came from the provider, so the patch is exact.
    expect(patch?.approximate).toBeUndefined();
  });

  it("emits one hunk per site for a replace_all edit that matched twice", () => {
    const patch = buildFileChangePatch(
      { file_path: FILE, old_string: "x", new_string: "y", replace_all: true },
      {
        filePath: FILE,
        replaceAll: true,
        structuredPatch: [
          { oldStart: 4, oldLines: 1, newStart: 4, newLines: 1, lines: ["-x", "+y"] },
          { oldStart: 40, oldLines: 1, newStart: 40, newLines: 1, lines: ["-x", "+y"] },
        ],
      },
    );

    const hunkHeaders = (patch?.patch ?? "").split("\n").filter((line) => line.startsWith("@@"));
    expect(hunkHeaders).toEqual(["@@ -4,1 +4,1 @@", "@@ -40,1 +40,1 @@"]);
  });

  it("defaults an omitted single-line count, which jsdiff leaves off", () => {
    const patch = buildFileChangePatch(
      { file_path: FILE },
      {
        filePath: FILE,
        structuredPatch: [{ oldStart: 7, newStart: 7, lines: ["-old", "+new"] }],
      },
    );

    expect(patch?.patch).toContain("@@ -7,1 +7,1 @@");
  });
});

describe("buildFileChangePatch for a newly created file", () => {
  it("renders the whole file as additions when the structured patch is empty", () => {
    const patch = buildFileChangePatch(
      { file_path: FILE, content: "line one\nline two\n" },
      { filePath: FILE, type: "create", content: "line one\nline two\n", structuredPatch: [] },
    );

    expect(patch?.patch).toBe(
      [
        `diff --git a/${FILE} b/${FILE}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${FILE}`,
        "@@ -0,0 +1,2 @@",
        "+line one",
        "+line two",
        "",
      ].join("\n"),
    );
  });

  it("does not count the trailing newline as an extra line", () => {
    const patch = buildFileChangePatch(
      { file_path: FILE },
      { filePath: FILE, type: "create", content: "only\n", structuredPatch: [] },
    );

    expect(patch?.patch).toContain("@@ -0,0 +1,1 @@");
    expect((patch?.patch ?? "").split("\n").filter((l) => l.startsWith("+only"))).toHaveLength(1);
  });
});

describe("buildFileChangePatch falling back to the tool input", () => {
  it("synthesizes a delete/add block and flags it approximate", () => {
    const patch = buildFileChangePatch(
      { file_path: FILE, old_string: "alpha\nbeta", new_string: "gamma" },
      undefined,
    );

    expect(patch?.approximate).toBe(true);
    expect(patch?.patch).toBe(
      [
        `diff --git a/${FILE} b/${FILE}`,
        `--- a/${FILE}`,
        `+++ b/${FILE}`,
        "@@ -1,2 +1,1 @@",
        "-alpha",
        "-beta",
        "+gamma",
        "",
      ].join("\n"),
    );
  });

  it("renders a pure insertion (empty old_string) with no delete lines", () => {
    const patch = buildFileChangePatch(
      { file_path: FILE, old_string: "", new_string: "added" },
      undefined,
    );

    expect(patch?.patch).toContain("@@ -0,0 +1,1 @@");
    const bodyLines = (patch?.patch ?? "").split("\n").slice(4);
    expect(bodyLines.filter((line) => line.startsWith("-"))).toHaveLength(0);
  });

  it("emits one hunk per edit for a MultiEdit-style batch", () => {
    const patch = buildFileChangePatch(
      {
        file_path: FILE,
        edits: [
          { old_string: "one", new_string: "1" },
          { old_string: "two", new_string: "2" },
        ],
      },
      undefined,
    );

    expect((patch?.patch ?? "").split("\n").filter((line) => line.startsWith("@@"))).toHaveLength(
      2,
    );
    expect(patch?.patch).toContain("-one");
    expect(patch?.patch).toContain("+2");
    expect(patch?.approximate).toBe(true);
  });

  it("reads a notebook edit's path and source", () => {
    const patch = buildFileChangePatch(
      { notebook_path: "/repo/nb.ipynb", new_source: "print(1)" },
      undefined,
    );

    expect(patch?.path).toBe("/repo/nb.ipynb");
    expect(patch?.patch).toContain("+print(1)");
  });
});

describe("buildFileChangePatch guards", () => {
  it("returns undefined when no path can be resolved", () => {
    expect(buildFileChangePatch({ old_string: "a", new_string: "b" }, undefined)).toBeUndefined();
  });

  it("returns undefined when there is nothing diffable", () => {
    expect(buildFileChangePatch({ file_path: FILE }, { filePath: FILE })).toBeUndefined();
  });

  it("truncates an oversized file body on a line boundary and flags it", () => {
    const huge = `${"x".repeat(200)}\n`.repeat(1200);
    const patch = buildFileChangePatch(
      { file_path: FILE },
      { filePath: FILE, type: "create", content: huge, structuredPatch: [] },
    );

    expect(patch?.truncated).toBe(true);
    expect(patch?.patch.length).toBeLessThanOrEqual(96_000);
    expect(patch?.patch.endsWith("\n")).toBe(true);
    // A clipped tail must still be a whole diff line, never a half-written one.
    const lines = (patch?.patch ?? "").trimEnd().split("\n");
    expect(lines[lines.length - 1]).toBe(`+${"x".repeat(200)}`);
  });
});
