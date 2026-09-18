import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en.json";
import ja from "@/i18n/locales/ja.json";
import zhTW from "@/i18n/locales/zh-TW.json";
import zh from "@/i18n/locales/zh.json";

/**
 * 渠道静默监控（Idle Watch）文案覆盖。
 *
 * key 分散在三处：IdleWatchPanel（含表格列名）、lib/utils/idleDuration（时长与事件
 * 正文）、ProxyTabContent（折叠面板标题）。这些调用**都没有 defaultValue**，缺 key
 * 就直接露出裸 key 路径，所以逐条钉住。
 *
 * `idleWatch.keepalive` 与 `idleWatch.keepaliveResult.ok` 是两件事——前者是保活开关
 * 的标签，后者是保活结果的一句话。它们刻意不同名：i18next 的 key 是点号路径，同名
 * 会让「开关标签」与「结果文案」抢同一个节点。这里把两条都列出来，改名时测试会拦。
 */
const requiredKeys = [
  "idleWatch.title",
  "idleWatch.description",
  "idleWatch.proxiedOnlyHint",
  "idleWatch.enabled",
  "idleWatch.enabledHint",
  "idleWatch.keepalive",
  "idleWatch.keepaliveHint",
  "idleWatch.rules",
  "idleWatch.noRules",
  "idleWatch.add",
  "idleWatch.delete",
  "idleWatch.threshold",
  "idleWatch.thresholdRange",
  "idleWatch.modeHint",
  "idleWatch.pickProvider",
  "idleWatch.loadingProviders",
  "idleWatch.duplicate",
  "idleWatch.statusTitle",
  "idleWatch.noRows",
  "idleWatch.never",
  "idleWatch.allFailed",
  "idleWatch.appMustRunHint",
  "idleWatch.alertBody",
  "idleWatch.onceDone",
  "idleWatch.mode.always",
  "idleWatch.mode.once",
  "idleWatch.keepaliveResult.ok",
  "idleWatch.keepaliveResult.unsupported",
  "idleWatch.keepaliveResult.failed",
  "idleWatch.duration.minutes",
  "idleWatch.duration.hours",
  "idleWatch.duration.days",
  "idleWatch.col.channel",
  "idleWatch.col.success",
  "idleWatch.col.last",
  "idleWatch.col.idle",
  "idleWatch.col.rule",
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

describe("Idle Watch locale coverage", () => {
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

  /**
   * 时长插值变量必须是 `minutes` / `hours` / `days`，**不能**是 `count`。
   *
   * i18next 见到 `count` 会走复数规则去找 `_one` / `_other`，而这三条 key 各自已经
   * 限定了单位、只有单一形态——写成 `count` 的结果是运行时查不到 key、界面上直接
   * 显示 `idleWatch.duration.minutes` 这串路径。这个测试钉住 formatter 与文案的约定。
   */
  it.each([
    ["en", en],
    ["zh", zh],
    ["zh-TW", zhTW],
    ["ja", ja],
  ])("uses unit-named interpolation in %s", (_locale, translations) => {
    const expected: Record<string, string> = {
      "idleWatch.duration.minutes": "minutes",
      "idleWatch.duration.hours": "hours",
      "idleWatch.duration.days": "days",
    };
    for (const [key, variable] of Object.entries(expected)) {
      const value = readTranslation(translations as TranslationTree, key);
      expect(typeof value === "string" && variablesOf(value).join(",")).toBe(
        variable,
      );
    }
  });
});
