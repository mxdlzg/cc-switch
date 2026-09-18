import type { TFunction } from "i18next";

/**
 * 渠道静默监控的时长与提醒文案（状态表面板与事件桥共用）。
 *
 * 两个刻意点：
 * - 入参一律是**秒**。后端 `proxy_request_logs.created_at` 是 Unix 秒，算出来的静默
 *   时长也是秒；这条链路一旦混进毫秒，时长会差 1000 倍而且不会报错。
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

/**
 * 提醒事件 → toast 正文。
 *
 * 顺序固定「静默多久 → 保活结果 → 一次性规则已结束」，与 Rust 侧系统通知的正文顺序
 * 一致：用户在系统通知里和应用里看到的应当是同一句话。
 *
 * 参数形状刻意写得很松（`mode` / `keepalive` 是 string 而不是联合类型）：它同时被
 * 事件负载与测试用字面量喂值，收紧类型只会逼调用方到处 as。
 */
export function describeIdleAlert(
  alert: {
    idleSec: number;
    mode: string;
    keepalive: string;
    keepaliveError: string | null;
  },
  t: TFunction,
): string {
  // 不足 1 分钟也按 1 分钟报：能触发提醒说明阈值已过，报「0 分钟」自相矛盾。
  const idle = formatIdleDuration(Math.max(60, alert.idleSec), t);
  const parts = [t("idleWatch.alertBody", { idle })];
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
