import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en.json";
import ja from "@/i18n/locales/ja.json";
import zhTW from "@/i18n/locales/zh-TW.json";
import zh from "@/i18n/locales/zh.json";

/**
 * 重放（Replay）文案覆盖。
 *
 * 这些 key 分散在两个组件里（ReplayPanel / ReplayConfigDialog）加上查看器的
 * `kind.replay_response` 标签；全部走 `t()` 且**没有 defaultValue** 的那些，缺 key
 * 会直接露出裸 key 路径，所以逐条钉住。
 */
const requiredKeys = [
  "replay.title",
  "replay.description",
  "replay.tip",
  "replay.idleHint",
  "replay.dialogTitle",
  "replay.start",
  "replay.stop",
  "replay.freezeWarning",
  "replay.noBilling",
  "replay.noSnapshot",
  "replay.fromReplay",
  "replay.attempts",
  "replay.snapshotMeta",
  "replay.validationFailed",
  "replay.invalidStatusCode",
  "replay.state.running",
  "replay.state.succeeded",
  "replay.state.failed",
  "replay.state.capped",
  "replay.state.stopped",
  "replay.mode.fixed",
  "replay.mode.backoff",
  "replay.fields.mode",
  "replay.fields.intervalSecs",
  "replay.fields.backoffStartSecs",
  "replay.fields.backoffMultPercent",
  "replay.fields.backoffCapSecs",
  "replay.fields.requiredConsecutive",
  "replay.fields.retryableStatuses",
  "replay.fields.maxAttempts",
  "replay.fields.maxDurationMinutes",
  "replay.hints.intervalSecs",
  "replay.hints.backoffStartSecs",
  "replay.hints.backoffMultPercent",
  "replay.hints.backoffCapSecs",
  "replay.hints.requiredConsecutive",
  "replay.hints.retryableStatuses",
  "replay.hints.maxAttempts",
  "replay.hints.maxDurationMinutes",
  // 查看器的 kind 标签表（Record<CaptureKind, …> 全覆盖，缺一个就显示 key 路径）
  "settings.advanced.debugCapture.kind.replay_response",
] as const;

type TranslationTree = Record<string, unknown>;

function readTranslation(tree: TranslationTree, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => {
    if (typeof value !== "object" || value === null) return undefined;
    return (value as TranslationTree)[segment];
  }, tree);
}

function variablesOf(value: string): string[] {
  return Array.from(
    value.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g),
    ([, name]) => name,
  ).sort();
}

describe("Replay locale coverage", () => {
  it.each([
    ["zh", zh],
    ["zh-TW", zhTW],
    ["en", en],
    ["ja", ja],
  ])("defines every required key in %s", (_locale, translations) => {
    const missing = requiredKeys.filter((key) => {
      const value = readTranslation(translations as TranslationTree, key);
      return typeof value !== "string" || value.trim().length === 0;
    });

    expect(missing).toEqual([]);
  });

  it.each([
    ["zh", zh],
    ["zh-TW", zhTW],
    ["ja", ja],
  ])(
    "keeps the same interpolation variables as en in %s",
    (_locale, translations) => {
      const mismatched = requiredKeys.flatMap((key) => {
        const expected = readTranslation(en as TranslationTree, key) as string;
        const actual = readTranslation(translations as TranslationTree, key);
        if (typeof actual !== "string") return [key];
        return variablesOf(actual).join("\0") === variablesOf(expected).join("\0")
          ? []
          : [key];
      });

      expect(mismatched).toEqual([]);
    },
  );
});
