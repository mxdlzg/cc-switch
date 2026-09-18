import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en.json";
import ja from "@/i18n/locales/ja.json";
import zhTW from "@/i18n/locales/zh-TW.json";
import zh from "@/i18n/locales/zh.json";

/**
 * 捕获查看器「哪是一轮」相关的文案覆盖。
 *
 * `attemptNote` 是带 {{n}} 插值的 tooltip，缺 key 会露出裸 key 路径；`turnLegend`
 * 讲的是轮次语义，讲不清就等于没修好用户的困惑，所以两条都逐条钉住。
 */
const requiredKeys = [
  "settings.advanced.debugCapture.turnLegend",
  "settings.advanced.debugCapture.attemptNote",
  // count 现在带两个插值（条数 + 轮数）；某语言漏掉 {{turns}} 会显示成裸占位符
  "settings.advanced.debugCapture.count",
  // 行首/标签页要显示这些 kind 标签，缺一个就显示 key 路径
  "settings.advanced.debugCapture.kind.client_request",
  "settings.advanced.debugCapture.kind.request",
  "settings.advanced.debugCapture.kind.response",
  "settings.advanced.debugCapture.kind.error",
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

describe("DebugCapture locale coverage", () => {
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
        return variablesOf(actual).join("\0") ===
          variablesOf(expected).join("\0")
          ? []
          : [key];
      });

      expect(mismatched).toEqual([]);
    },
  );
});
