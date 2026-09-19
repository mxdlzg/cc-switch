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
  // 流式那一条的存在感全靠这两个 key：kind 标签 + 「正文不捕获」的说明。
  // 少了 hint，用户看到的就是一块空白 + 「无响应」的旧误会。
  "settings.advanced.debugCapture.kind.stream_response",
  "settings.advanced.debugCapture.stream.title",
  "settings.advanced.debugCapture.stream.hint",
  "settings.advanced.debugCapture.stream.chunks",
  "settings.advanced.debugCapture.stream.elapsed",
  "settings.advanced.debugCapture.stream.chunksLabel",
  "settings.advanced.debugCapture.stream.bytesLabel",
  "settings.advanced.debugCapture.stream.outcomeLabel",
  "settings.advanced.debugCapture.stream.running",
  // 收尾方式是拼进字符串的 key 路径（stream.outcome.<枚举>），缺一个就露出裸路径
  "settings.advanced.debugCapture.stream.outcome.completed",
  "settings.advanced.debugCapture.stream.outcome.first_byte_timeout",
  "settings.advanced.debugCapture.stream.outcome.idle_timeout",
  "settings.advanced.debugCapture.stream.outcome.upstream_error",
  "settings.advanced.debugCapture.stream.outcome.aborted",
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
