import type { TFunction } from "i18next";

/**
 * 渠道静默监控的时长与提醒文案（状态表面板与事件桥共用）。
 *
 * 三个刻意点：
 * - `formatIdleDuration` 的入参一律是**秒**。后端 `proxy_request_logs.created_at`
 *   是 Unix 秒，算出来的静默时长也是秒；这条链路一旦混进毫秒，时长会差 1000 倍
 *   而且不会报错。
 * - 阈值那组函数入参是**分钟**（配置的存储单位），且**只挑能整除的单位**、不取整
 *   ——见 `formatThresholdMinutes` 的注释：显示阈值时说谎比显示难看的数字严重得多。
 * - 插值变量用 `minutes` / `hours` / `days` 而不是 `count`：`count` 会触发 i18next 的
 *   复数规则（需要 `_one` / `_other` 两套 key），而这三个 key 各自已限定单位，
 *   单一形态即可。
 */

/** `null` = 没有可度量的起点（既无成功日志也无规则），显示成破折号。 */
export function formatIdleDuration(
  seconds: number | null,
  t: TFunction,
): string {
  if (seconds === null) return "—";
  const mins = Math.floor(Math.max(0, seconds) / 60);
  if (mins < 60) return t("idleWatch.duration.minutes", { minutes: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("idleWatch.duration.hours", { hours });
  return t("idleWatch.duration.days", { days: Math.floor(hours / 24) });
}

/* ------------------------------------------------------------------ *
 * 阈值（threshold）的单位换算与显示
 *
 * 存储形状始终是**整数分钟**（`IdleWatchRule.thresholdMinutes`，后端 DAO 与判定逻辑
 * 都按分钟），单位只是输入/显示层的看法。所以这里的函数只有两类：
 * 分钟 ⇄ 「数值 + 单位」，以及把分钟数说成人话。
 * ------------------------------------------------------------------ */

/** 阈值可选单位。存进配置的永远是 `value * UNIT_FACTORS[unit]` 分钟。 */
export type ThresholdUnit = "minute" | "hour" | "day";

export const UNIT_FACTORS: Record<ThresholdUnit, number> = {
  minute: 1,
  hour: 60,
  day: 1440,
};

/** 单位下拉的展示顺序（与 Select 里一致）。 */
export const THRESHOLD_UNITS: readonly ThresholdUnit[] = [
  "minute",
  "hour",
  "day",
];

/**
 * 阈值区间（分钟），与后端 `commands/idle_watch.rs` 的 `THRESHOLD_MIN/MAX` 同规则：
 * 1 分钟 ~ 43200 分钟（30 天）。上限按分钟写，因为那是存储单位；界面上另配单位下拉
 * 与天数说明，免得用户自己心算 43200 是几天。
 */
export const THRESHOLD = { min: 1, max: 43200 };

/**
 * 挑「能整除的最大单位」，于是存量数据看起来就是人话：120 → 小时（2 小时）、
 * 2880 → 天（2 天）、90 → 分钟（90 分钟，因为 1.5 小时这种小数不适合当默认显示）。
 *
 * 非正值（防御：理论上后端已挡）退回分钟，免得 `0 % 1440 === 0` 让它显示成
 * 「0 天」这种自相矛盾的话。
 */
export function unitForMinutes(minutes: number): ThresholdUnit {
  if (!Number.isFinite(minutes) || minutes <= 0) return "minute";
  if (minutes % UNIT_FACTORS.day === 0) return "day";
  if (minutes % UNIT_FACTORS.hour === 0) return "hour";
  return "minute";
}

/** 分钟数 → 指定单位下的数值。与 `unitForMinutes` 搭配用时必为整数。 */
export function valueForMinutes(minutes: number, unit: ThresholdUnit): number {
  return minutes / UNIT_FACTORS[unit];
}

/**
 * 「数值 + 单位」→ 分钟。用**字符串上的整数运算**而不是 `value * factor`：
 * 浮点下 `1.7 * 60 === 102.00000000000001`，于是「1.7 小时」（本就是 102 整分钟）
 * 会被误判成非法值。这里把 "1.7" 拆成 17/10 再乘 60，整除性判定完全精确。
 *
 * 返回 `null` = 非法（格式不对、不落在整数分钟上、或超出区间）。
 */
export function minutesForValue(
  raw: string,
  unit: ThresholdUnit,
): number | null {
  const trimmed = raw.trim();
  // 只认十进制：`1e3` / `.5` / `+5` 一律拒（后端也只认整数分钟，别在这里放宽）
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [intPart, fracPart = ""] = trimmed.split(".");
  const denom = 10 ** fracPart.length;
  const numer = BigInt(intPart + fracPart);
  const minutes = numer * BigInt(UNIT_FACTORS[unit]);
  if (minutes % BigInt(denom) !== 0n) return null;
  const exact = Number(minutes / BigInt(denom));
  if (!Number.isSafeInteger(exact)) return null;
  if (exact < THRESHOLD.min || exact > THRESHOLD.max) return null;
  return exact;
}

/**
 * 阈值分钟数 → 人话（「2 小时」「90 分钟」「2 天」）。
 *
 * **不能**复用上面的 `formatIdleDuration`：那个会向下取整（90 分钟 → 「1 小时」），
 * 用来显示「已经静默多久」是对的，显示阈值却会撒——用户存的是 90 分钟，界面上却
 * 写着 1 小时。这里只挑能整除的单位，永远不丢余数。
 */
export function formatThresholdMinutes(minutes: number, t: TFunction): string {
  const unit = unitForMinutes(minutes);
  const value = Math.max(0, valueForMinutes(minutes, unit));
  switch (unit) {
    case "day":
      return t("idleWatch.duration.days", { days: value });
    case "hour":
      return t("idleWatch.duration.hours", { hours: value });
    default:
      return t("idleWatch.duration.minutes", { minutes: value });
  }
}

/**
 * 提醒事件 → toast 正文。
 *
 * 顺序固定「静默多久 → 保活结果 → 一次性规则已结束」，与 Rust 侧系统通知的正文顺序
 * 一致：用户在系统通知里和应用里看到的应当是同一句话。
 *
 * `kind` 决定第一句怎么说，**不能共用模板**：`silence` 的 `idleSec` 是「至今静默」，
 * `recovery` 的却是「那次成功之前的静默」——把恢复写成静默正好说反了。恢复提醒不带
 * 保活后缀（后端在该方向恒为 `skipped`，渠道刚成功过，poking 没有意义）。
 *
 * 参数形状刻意写得很松（`mode` / `keepalive` / `kind` 是 string 而不是联合类型）：它
 * 同时被事件负载与测试用字面量喂值，收紧类型只会逼调用方到处 as。
 */
export function describeIdleAlert(
  alert: {
    idleSec: number;
    mode: string;
    kind?: string;
    keepalive: string;
    keepaliveError: string | null;
  },
  t: TFunction,
): string {
  // 不足 1 分钟也按 1 分钟报：能触发提醒说明阈值已过，报「0 分钟」自相矛盾。
  const idle = formatIdleDuration(Math.max(60, alert.idleSec), t);
  const parts = [
    t(
      alert.kind === "recovery"
        ? "idleWatch.recoveryAlertBody"
        : "idleWatch.alertBody",
      { idle },
    ),
  ];
  if (alert.keepalive !== "skipped") {
    parts.push(
      t(`idleWatch.keepaliveResult.${alert.keepalive}`, {
        error: alert.keepaliveError ?? "",
      }),
    );
  }
  if (alert.mode === "once") parts.push(t("idleWatch.onceDone"));
  return parts.join(" · ");
}
