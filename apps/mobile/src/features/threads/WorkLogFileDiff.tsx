import { memo, useMemo } from "react";
import { ScrollView, StyleSheet, Text as NativeText, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { resolveNativeReviewDiffView } from "../diffs/nativeReviewDiffSurface";
import {
  buildNativeReviewDiffData,
  createNativeReviewDiffTheme,
  NATIVE_REVIEW_DIFF_CONTENT_WIDTH,
} from "../review/nativeReviewDiffAdapter";
import { buildReviewParsedDiff } from "../review/reviewModel";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useAppearanceCodeSurface } from "../settings/appearance/useAppearanceCodeSurface";
import type { WorkLogFileChange } from "../../lib/threadActivity";
import { useThemeColor } from "../../lib/useThemeColor";

const MAX_DIFF_HEIGHT = 420;
const MIN_DIFF_HEIGHT = 96;

function compactFileName(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  const lastSlashIndex = normalized.lastIndexOf("/");
  return lastSlashIndex >= 0 ? normalized.slice(lastSlashIndex + 1) : normalized;
}

function headerLabel(fileChange: WorkLogFileChange): string {
  const paths = fileChange.paths ?? [];
  if (paths.length > 1) {
    return `${paths.length.toLocaleString()} files changed`;
  }
  return compactFileName(fileChange.path);
}

function diffStat(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

/**
 * Inline unified diff for a Claude/Codex write or edit tool call, rendered with
 * the same native surface the review sheet uses. Mirrors the desktop
 * `ToolCallFileDiff` row in `apps/web`.
 */
export const WorkLogFileDiff = memo(function WorkLogFileDiff(props: {
  readonly fileChange: WorkLogFileChange;
  readonly rowId: string;
}) {
  const { fileChange } = props;
  const { codeSurface, nativeReviewDiffStyle } = useAppearanceCodeSurface();
  const { themeAppearance: appearanceScheme, themeId } = useAppearancePreferences();
  const NativeReviewDiffView = resolveNativeReviewDiffView();
  const borderColor = useThemeColor("--color-border");
  const mutedText = useThemeColor("--color-foreground-muted");

  const parsedDiff = useMemo(
    () => buildReviewParsedDiff(fileChange.patch, `work-log-file-change:${props.rowId}`),
    [fileChange.patch, props.rowId],
  );
  const nativeReviewDiffData = useMemo(() => buildNativeReviewDiffData(parsedDiff), [parsedDiff]);
  const compactNativeRows = useMemo(
    () => nativeReviewDiffData.rows.filter((row) => row.kind !== "file"),
    [nativeReviewDiffData.rows],
  );
  const nativeReviewDiffTheme = useMemo(
    () => createNativeReviewDiffTheme(appearanceScheme, themeId),
    [appearanceScheme, themeId],
  );
  const nativeRowsJson = useMemo(() => JSON.stringify(compactNativeRows), [compactNativeRows]);
  const nativeThemeJson = useMemo(
    () => JSON.stringify(nativeReviewDiffTheme),
    [nativeReviewDiffTheme],
  );
  const nativeStyleJson = useMemo(
    () => JSON.stringify(nativeReviewDiffStyle),
    [nativeReviewDiffStyle],
  );
  const stat = useMemo(() => diffStat(fileChange.patch), [fileChange.patch]);
  const nativeDiffHeight = useMemo(
    () =>
      Math.min(
        MAX_DIFF_HEIGHT,
        Math.max(
          MIN_DIFF_HEIGHT,
          compactNativeRows.length * nativeReviewDiffStyle.rowHeight +
            nativeReviewDiffStyle.fileHeaderVerticalMargin,
        ),
      ),
    [compactNativeRows.length, nativeReviewDiffStyle],
  );
  const shouldRenderNativeDiff = NativeReviewDiffView != null && compactNativeRows.length > 0;
  const notice =
    fileChange.truncated && fileChange.approximate
      ? "Diff truncated. Line numbers are approximate."
      : fileChange.truncated
        ? "Diff truncated."
        : fileChange.approximate
          ? "Line numbers are approximate."
          : null;

  return (
    <View
      className="w-full overflow-hidden rounded-[12px] border border-continuous"
      style={{ borderColor }}
    >
      <View className="flex-row items-center gap-2 border-b px-2.5 py-1.5" style={{ borderColor }}>
        <SymbolView name="doc.text" size={12} tintColor={mutedText} type="monochrome" />
        <Text className="min-w-0 flex-1 font-mono text-2xs text-foreground" numberOfLines={1}>
          {headerLabel(fileChange)}
        </Text>
        {stat.additions > 0 ? (
          <Text className="font-t3-medium text-3xs text-emerald-600 tabular-nums dark:text-emerald-400">
            +{stat.additions}
          </Text>
        ) : null}
        {stat.deletions > 0 ? (
          <Text className="font-t3-medium text-3xs text-rose-600 tabular-nums dark:text-rose-400">
            -{stat.deletions}
          </Text>
        ) : null}
      </View>

      {shouldRenderNativeDiff ? (
        <View
          collapsable={false}
          style={{ backgroundColor: nativeReviewDiffTheme.background, height: nativeDiffHeight }}
        >
          <NativeReviewDiffView
            collapsable={false}
            style={StyleSheet.absoluteFill}
            appearanceScheme={appearanceScheme}
            contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
            rowHeight={nativeReviewDiffStyle.rowHeight}
            rowsJson={nativeRowsJson}
            styleJson={nativeStyleJson}
            themeJson={nativeThemeJson}
          />
        </View>
      ) : (
        <ScrollView
          horizontal
          nestedScrollEnabled
          directionalLockEnabled
          showsHorizontalScrollIndicator={false}
          bounces={false}
          style={{ maxHeight: MAX_DIFF_HEIGHT }}
          contentContainerStyle={{ padding: 10 }}
        >
          <NativeText
            selectable
            className="font-mono text-foreground-muted"
            style={{ fontSize: codeSurface.fontSize, lineHeight: codeSurface.rowHeight }}
          >
            {fileChange.patch.trim()}
          </NativeText>
        </ScrollView>
      )}

      {notice ? (
        <View className="border-t px-2.5 py-1" style={{ borderColor }}>
          <Text className="text-3xs text-foreground-muted">{notice}</Text>
        </View>
      ) : null}
    </View>
  );
});
