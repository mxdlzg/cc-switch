import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import {
  THRESHOLD,
  UNIT_FACTORS,
  describeIdleAlert,
  formatIdleDuration,
  formatThresholdMinutes,
  minutesForValue,
  unitForMinutes,
  valueForMinutes,
} from "@/lib/utils/idleDuration";

/**
 * 阈值单位换算与显示。
 *
 * 这批函数是「存储单位（整数分钟）」与「输入/显示单位（分钟/小时/天）」之间唯一的
 * 一座桥，读写两侧都走它：算错一次，用户的规则就悄悄差 60 倍或 1440 倍，而且一路
 * 不会报错。所以区间端点、整除性、格式合法性逐条钉住。
 */

/** 假 t：只关心选中了哪个 key、插值数字是多少。 */
const t = ((key: string, opts?: Record<string, unknown>) =>
  `${key}:${JSON.stringify(opts ?? {})}`) as TFunction;

describe("unitForMinutes", () => {
  it("picks the largest exactly-dividing unit", () => {
    expect(unitForMinutes(120)).toBe("hour"); // 存量数据的读取路径：120 → 2 小时
    expect(unitForMinutes(2880)).toBe("day");
    expect(unitForMinutes(43200)).toBe("day");
    // 90 分钟不该显示成「1.5 小时」，也不该显示成「1 小时」——见 formatThresholdMinutes
    expect(unitForMinutes(90)).toBe("minute");
    expect(unitForMinutes(1)).toBe("minute");
    expect(unitForMinutes(1439)).toBe("minute");
  });

  it("falls back to minutes for non-positive or non-finite input", () => {
    // 0 % 1440 === 0，若不兜住会显示成「0 天」这种自相矛盾的话
    expect(unitForMinutes(0)).toBe("minute");
    expect(unitForMinutes(-120)).toBe("minute");
    expect(unitForMinutes(Number.NaN)).toBe("minute");
  });
});

describe("minutesForValue", () => {
  it("converts each unit back to minutes", () => {
    expect(minutesForValue("2", "hour")).toBe(120);
    expect(minutesForValue("2", "day")).toBe(2880);
    expect(minutesForValue("90", "minute")).toBe(90);
    expect(minutesForValue("1.5", "hour")).toBe(90);
    expect(minutesForValue("0.25", "day")).toBe(360);
    // 首尾空白是失焦前后常见的，不该算非法
    expect(minutesForValue("  12  ", "minute")).toBe(12);
  });

  it("accepts both range endpoints and rejects outside", () => {
    expect(minutesForValue(String(THRESHOLD.min), "minute")).toBe(THRESHOLD.min);
    expect(minutesForValue(String(THRESHOLD.max), "minute")).toBe(THRESHOLD.max);
    expect(minutesForValue("43201", "minute")).toBeNull();
    expect(minutesForValue("30.1", "day")).toBeNull();
    expect(minutesForValue("0", "hour")).toBeNull();
    expect(minutesForValue("44", "day")).toBeNull(); // 63360 分，超上限
  });

  it("rejects only what cannot land on a whole minute", () => {
    // 小时下的 1 位小数总能整除（v/10 × 60 = 6v），所以 1.7 小时＝102 分是**合法**的；
    // 真正该拒的是落不到整数分钟上的值。用字符串整数运算判定，浮点误差不参与。
    expect(minutesForValue("1.7", "hour")).toBe(102);
    expect(minutesForValue("1.01", "hour")).toBeNull(); // 60.6 分
    expect(minutesForValue("0.0166", "hour")).toBeNull(); // 0.996 分
    expect(minutesForValue("1.001", "minute")).toBeNull();
    expect(minutesForValue("0.5", "day")).toBe(720);
  });

  it("rejects malformed numbers", () => {
    for (const raw of ["", " ", "abc", "1e3", ".5", "+5", "-5", "1,5", "12.", "--1"]) {
      expect(minutesForValue(raw, "minute")).toBeNull();
    }
  });
});

describe("valueForMinutes", () => {
  it("is the inverse of minutesForValue", () => {
    for (const unit of ["minute", "hour", "day"] as const) {
      const minutes = UNIT_FACTORS[unit]; // 该单位的 1 个刻度
      expect(minutesForValue(String(valueForMinutes(minutes, unit)), unit)).toBe(
        minutes,
      );
    }
    expect(valueForMinutes(120, "hour")).toBe(2);
    expect(valueForMinutes(120, "minute")).toBe(120);
  });
});

describe("formatThresholdMinutes", () => {
  it("never drops a remainder — unlike formatIdleDuration", () => {
    // 这正是不能复用 formatIdleDuration 的原因：90 分钟显示成「1 小时」是撒谎。
    expect(formatIdleDuration(90 * 60, t)).toBe(
      "idleWatch.duration.hours:{\"hours\":1}",
    );
    expect(formatThresholdMinutes(90, t)).toBe(
      "idleWatch.duration.minutes:{\"minutes\":90}",
    );
  });

  it("humanizes whole hours and whole days", () => {
    expect(formatThresholdMinutes(120, t)).toBe(
      "idleWatch.duration.hours:{\"hours\":2}",
    );
    expect(formatThresholdMinutes(2880, t)).toBe(
      "idleWatch.duration.days:{\"days\":2}",
    );
    expect(formatThresholdMinutes(1, t)).toBe(
      "idleWatch.duration.minutes:{\"minutes\":1}",
    );
  });
});

describe("unit switching keeps the duration", () => {
  it("does not silently rescale the value", () => {
    // 「2 小时」切到分钟应当变成 120，而不是把 2 当成 2 分钟（差 60 倍）
    const asMinutes = minutesForValue("2", "hour");
    expect(asMinutes).not.toBeNull();
    expect(valueForMinutes(asMinutes!, "minute")).toBe(120);
  });
});

/**
 * 提醒正文（`describeIdleAlert`）。
 *
 * 关键在于两种 `kind` 必须走不同模板：`idleSec` 这个数字在 `silence` 下是「至今静默
 * 多久」，在 `recovery` 下却是「那次成功之前静默了多久」——共用一条文案会把「回来了」
 * 说成「还没回来」，正好相反。
 */
describe("describeIdleAlert", () => {
  it("uses the silence wording for the idle direction", () => {
    const text = describeIdleAlert(
      {
        idleSec: 7200,
        mode: "always",
        kind: "silence",
        keepalive: "skipped",
        keepaliveError: null,
      },
      t,
    );
    expect(text).toContain("idleWatch.alertBody");
    expect(text).not.toContain("recoveryAlertBody");
  });

  it("uses the recovery wording when a channel comes back", () => {
    const text = describeIdleAlert(
      {
        idleSec: 12600,
        mode: "always",
        kind: "recovery",
        keepalive: "skipped",
        keepaliveError: null,
      },
      t,
    );
    expect(text).toContain("idleWatch.recoveryAlertBody");
    expect(text).not.toContain("idleWatch.alertBody:");
    // 恢复方向后端恒为 skipped，因此不该拼保活后缀
    expect(text).not.toContain("keepaliveResult");
  });

  it("keeps appending the one-shot note for either direction", () => {
    const once = (kind: string) =>
      describeIdleAlert(
        { idleSec: 3600, mode: "once", kind, keepalive: "skipped", keepaliveError: null },
        t,
      );
    expect(once("silence")).toContain("idleWatch.onceDone");
    expect(once("recovery")).toContain("idleWatch.onceDone");
  });
});
