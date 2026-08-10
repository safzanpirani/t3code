/**
 * Builds a unified diff for a `file_change` tool call so clients can render the
 * edit inline in the chat timeline instead of a JSON blob of the tool input.
 *
 * Preference order, best fidelity first:
 *
 *  1. `tool_use_result.structuredPatch` — Claude Code already computed exact
 *     hunks (real line numbers, 3 lines of context) for Edit/Write. An Edit
 *     with `replace_all` that matched N sites arrives as N hunks, so repeated
 *     replacements render correctly with no extra work here.
 *  2. `tool_use_result` for a newly created file (`type: "create"`), whose
 *     `structuredPatch` is empty by construction — synthesize an all-additions
 *     new-file patch from `content`.
 *  3. The tool *input* (`old_string`/`new_string`, or `content`) — the fallback
 *     for providers that report no structured result. Line numbers are unknown
 *     on this path, so the hunk is anchored at line 1 and flagged `approximate`.
 *
 * Patches are size-capped: an edit body is a wire payload replicated to every
 * connected client, and a Write of a large file would otherwise dwarf the rest
 * of the activity stream.
 */

/** Hard ceiling on an emitted patch. Larger diffs are truncated, not dropped. */
const MAX_PATCH_CHARS = 96_000;
/** Per-side ceiling when synthesizing a patch from raw strings. */
const MAX_SYNTHESIZED_SIDE_CHARS = 48_000;

export interface FileChangePatch {
  /** Absolute path as reported by the tool; clients relativize for display. */
  readonly path: string;
  /** Unified diff, `diff --git` header included. */
  readonly patch: string;
  /** Set when the patch body was clipped to fit the size cap. */
  readonly truncated?: boolean;
  /**
   * Set when hunk line numbers were inferred rather than reported, i.e. the
   * patch shows *what* changed but not *where* in the file.
   */
  readonly approximate?: boolean;
}

interface StructuredPatchHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: ReadonlyArray<string>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asFiniteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

/**
 * jsdiff omits `oldLines`/`newLines` when they equal 1, so absent counts are
 * defaulted rather than treated as a malformed hunk.
 */
function readStructuredPatchHunk(value: unknown): StructuredPatchHunk | null {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.lines)) {
    return null;
  }
  const lines = record.lines.filter((line): line is string => typeof line === "string");
  if (lines.length === 0) {
    return null;
  }
  const oldStart = asFiniteInteger(record.oldStart);
  const newStart = asFiniteInteger(record.newStart);
  if (oldStart === null || newStart === null) {
    return null;
  }
  return {
    oldStart,
    newStart,
    oldLines: asFiniteInteger(record.oldLines) ?? 1,
    newLines: asFiniteInteger(record.newLines) ?? 1,
    lines,
  };
}

function readStructuredPatch(value: unknown): ReadonlyArray<StructuredPatchHunk> {
  if (!Array.isArray(value)) {
    return [];
  }
  const hunks: StructuredPatchHunk[] = [];
  for (const entry of value) {
    const hunk = readStructuredPatchHunk(entry);
    if (hunk) {
      hunks.push(hunk);
    }
  }
  return hunks;
}

function gitHeader(path: string, mode: "modify" | "create"): string {
  const quoted = path.replace(/\n/g, " ");
  const lines = [`diff --git a/${quoted} b/${quoted}`];
  if (mode === "create") {
    lines.push("new file mode 100644", "--- /dev/null", `+++ b/${quoted}`);
  } else {
    lines.push(`--- a/${quoted}`, `+++ b/${quoted}`);
  }
  return lines.join("\n");
}

function formatHunkHeader(hunk: StructuredPatchHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

/**
 * A trailing "\ No newline at end of file" marker is passed through verbatim;
 * every other line is emitted as-is because jsdiff already prefixes each with
 * a space, `+`, or `-`.
 */
function renderStructuredPatch(
  path: string,
  hunks: ReadonlyArray<StructuredPatchHunk>,
  mode: "modify" | "create",
): string {
  const blocks = hunks.map((hunk) => [formatHunkHeader(hunk), ...hunk.lines].join("\n"));
  return `${gitHeader(path, mode)}\n${blocks.join("\n")}\n`;
}

function splitLines(value: string): string[] {
  const normalized = value.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  // A trailing newline yields a final empty element that is not a real line.
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Clips on a line boundary. Cutting mid-line would emit a partial line as a
 * complete one, which reads as real file content rather than as elision.
 */
function clipForSynthesis(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_SYNTHESIZED_SIDE_CHARS) {
    return { text: value, truncated: false };
  }
  const clipped = value.slice(0, MAX_SYNTHESIZED_SIDE_CHARS);
  const lastNewline = clipped.lastIndexOf("\n");
  return { text: lastNewline > 0 ? clipped.slice(0, lastNewline) : clipped, truncated: true };
}

/** All-additions patch for a file the tool call created. */
function buildCreatePatch(path: string, content: string): FileChangePatch {
  const clipped = clipForSynthesis(content);
  const lines = splitLines(clipped.text);
  const hunk: StructuredPatchHunk = {
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: lines.length,
    lines: lines.map((line) => `+${line}`),
  };
  return {
    path,
    patch: renderStructuredPatch(path, [hunk], "create"),
    ...(clipped.truncated ? { truncated: true } : {}),
  };
}

/**
 * Last-resort patch built from the tool input alone: the replaced region shown
 * as a delete block followed by an add block. Position in the file is unknown,
 * hence `approximate`.
 */
function buildReplacementHunk(
  oldString: string,
  newString: string,
): { hunk: StructuredPatchHunk; truncated: boolean } | null {
  if (oldString.length === 0 && newString.length === 0) {
    return null;
  }
  const clippedOld = clipForSynthesis(oldString);
  const clippedNew = clipForSynthesis(newString);
  const oldLines = oldString.length > 0 ? splitLines(clippedOld.text) : [];
  const newLines = newString.length > 0 ? splitLines(clippedNew.text) : [];
  return {
    hunk: {
      oldStart: oldLines.length > 0 ? 1 : 0,
      oldLines: oldLines.length,
      newStart: newLines.length > 0 ? 1 : 0,
      newLines: newLines.length,
      lines: [...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)],
    },
    truncated: clippedOld.truncated || clippedNew.truncated,
  };
}

function applyPatchSizeCap(patch: FileChangePatch): FileChangePatch {
  if (patch.patch.length <= MAX_PATCH_CHARS) {
    return patch;
  }
  // Clip on a line boundary so the tail is not a half-written diff line.
  const clipped = patch.patch.slice(0, MAX_PATCH_CHARS);
  const lastNewline = clipped.lastIndexOf("\n");
  return {
    ...patch,
    patch: `${lastNewline > 0 ? clipped.slice(0, lastNewline) : clipped}\n`,
    truncated: true,
  };
}

/**
 * Resolves the edited file's path. Claude reports `filePath` on the result and
 * `file_path` on the input; notebook tools use `notebook_path`; Codex-style
 * tools use `path`.
 */
function resolvePath(
  input: Record<string, unknown>,
  result: Record<string, unknown> | undefined,
): string | null {
  return (
    asNonEmptyString(result?.filePath) ??
    asNonEmptyString(input.file_path) ??
    asNonEmptyString(input.filePath) ??
    asNonEmptyString(input.notebook_path) ??
    asNonEmptyString(input.path) ??
    null
  );
}

/**
 * Builds the renderable patch for one `file_change` tool call, or `undefined`
 * when the call carries nothing diffable (e.g. a delete with no content, or an
 * unrecognized tool shape). Never throws: a failure here must not break the
 * activity stream.
 */
export function buildFileChangePatch(
  input: Record<string, unknown>,
  toolUseResult: Record<string, unknown> | undefined,
): FileChangePatch | undefined {
  const path = resolvePath(input, toolUseResult);
  if (!path) {
    return undefined;
  }

  // 1. Provider-computed hunks — exact line numbers, handles replace_all.
  const hunks = readStructuredPatch(toolUseResult?.structuredPatch);
  if (hunks.length > 0) {
    return applyPatchSizeCap({
      path,
      patch: renderStructuredPatch(path, hunks, "modify"),
    });
  }

  // 2. Newly created file: structuredPatch is empty, content is the whole file.
  const resultContent = asNonEmptyString(toolUseResult?.content);
  if (toolUseResult?.type === "create" && resultContent) {
    return applyPatchSizeCap(buildCreatePatch(path, resultContent));
  }

  // 3. Fall back to the tool input.
  const oldString = typeof input.old_string === "string" ? input.old_string : "";
  const newString = typeof input.new_string === "string" ? input.new_string : "";
  if (oldString.length > 0 || newString.length > 0) {
    const replacement = buildReplacementHunk(oldString, newString);
    return replacement
      ? applyPatchSizeCap({
          path,
          patch: renderStructuredPatch(path, [replacement.hunk], "modify"),
          approximate: true,
          ...(replacement.truncated ? { truncated: true } : {}),
        })
      : undefined;
  }

  // MultiEdit-style input: one delete/add block per edit in the batch.
  if (Array.isArray(input.edits)) {
    const editHunks: StructuredPatchHunk[] = [];
    let clipped = false;
    for (const entry of input.edits) {
      const edit = asRecord(entry);
      if (!edit) {
        continue;
      }
      const built = buildReplacementHunk(
        typeof edit.old_string === "string" ? edit.old_string : "",
        typeof edit.new_string === "string" ? edit.new_string : "",
      );
      if (!built) {
        continue;
      }
      clipped = clipped || built.truncated;
      editHunks.push(built.hunk);
    }
    if (editHunks.length > 0) {
      return applyPatchSizeCap({
        path,
        patch: renderStructuredPatch(path, editHunks, "modify"),
        approximate: true,
        ...(clipped ? { truncated: true } : {}),
      });
    }
  }

  const inputContent = asNonEmptyString(input.content) ?? asNonEmptyString(input.new_source);
  if (inputContent) {
    return applyPatchSizeCap({
      ...buildCreatePatch(path, inputContent),
      approximate: true,
    });
  }

  return undefined;
}
