import { invoke } from "@tauri-apps/api/core";

/**
 * 渠道静默监控（Idle Watch）的类型与命令封装。
 *
 * 场景：某些渠道长时间不被使用会出问题（席位/配额被回收、缓存会话失效、账号被判
 * 定不活跃）。这里给「某渠道已经多久没有**成功**请求」设一个阈值，到点弹系统通知。
 *
 * 两个刻意的设计，UI 文案必须与之一致：
 * - **只有 2xx 算活动**。一直报错的渠道恰恰是「没被真正用上」，不该重置计时。
 * - **保活不重置计时**。保活打的是 `GET /models`，不是代理流量，不写请求日志；
 *   所以开了自动保活，提醒仍会按阈值继续来。
 */

/** 提醒模式，对应后端 `IdleWatchMode`（serde snake_case）。 */
export type IdleWatchMode = "once" | "always";

/** 单条规则（后端落盘形态；阈值为字符串，与输入框直接绑定）。 */
export interface IdleWatchRuleInput {
  appType: string;
  providerId: string;
  mode: IdleWatchMode;
  thresholdMinutes: string;
}

/** 整块配置（settings 表里的一条 JSON，整读整写）。 */
export interface IdleWatchConfigInput {
  enabled: boolean;
  keepaliveEnabled: boolean;
  rules: IdleWatchRuleInput[];
}

/**
 * 后端落盘后的规则。刻意**不**继承 `IdleWatchRuleInput`：阈值在这里已是数字，
 * 且多一个 `createdAtSec`（计时基线下限，由后端打时间戳，前端只读）。
 */
export interface IdleWatchRule {
  appType: string;
  providerId: string;
  mode: IdleWatchMode;
  thresholdMinutes: number;
  createdAtSec: number;
}

export interface IdleWatchConfig {
  enabled: boolean;
  keepaliveEnabled: boolean;
  rules: IdleWatchRule[];
}

/** 面板用的单渠道状态行（活动 + 该渠道上的规则）。 */
export interface ChannelIdleStatus {
  appType: string;
  providerId: string;
  providerName: string;
  /** 最近一次 2xx（Unix 秒）；null = 日志里没有成功记录 */
  lastSuccessAt: number | null;
  successCount: number;
  requestCount: number;
  /**
   * 已静默秒数，与后台引擎同一条基线（`max(最近成功, 规则建立时刻)`）。
   * null = 既无日志也无规则，没有可度量的起点。
   */
  idleSec: number | null;
  /** 该渠道上的规则；null = 未监控 */
  mode: IdleWatchMode | null;
  thresholdMinutes: number | null;
}

/** 后台提醒事件负载（emit `idle-watch-alert`）。 */
export type KeepaliveOutcome = "skipped" | "ok" | "unsupported" | "failed";

export interface IdleWatchAlert {
  appType: string;
  providerId: string;
  providerName: string;
  mode: IdleWatchMode;
  thresholdMinutes: number;
  idleSec: number;
  keepalive: KeepaliveOutcome;
  keepaliveError: string | null;
}

export const idleWatchApi = {
  async getConfig(): Promise<IdleWatchConfig> {
    return invoke("get_idle_watch_config");
  },

  /** 整块保存。返回值是后端校验 + 打时间戳后的配置，前端直接拿它写缓存。 */
  async saveConfig(config: IdleWatchConfigInput): Promise<IdleWatchConfig> {
    return invoke("save_idle_watch_config", { config });
  },

  async getStatus(): Promise<ChannelIdleStatus[]> {
    return invoke("get_channel_idle_status");
  },
};
