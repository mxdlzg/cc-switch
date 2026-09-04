import { invoke } from "@tauri-apps/api/core";

/**
 * 请求调试捕获（临时 debug 用）的类型与命令封装。
 *
 * 纯内存、不落盘：开关 + 快照读取 + 清空，数据在 `proxy::debug_capture` 的环形
 * 缓冲里，进程重启即清空。与「应用诊断日志」（写 logs/ 的 cc-switch.log）是两回事。
 */

/** 捕获类型，对应后端 `CaptureKind`（serde 小写）。 */
export type CaptureKind = "request" | "response" | "error";

/** 一条捕获记录，字段对应后端 `CaptureEvent`（camelCase）。 */
export interface CaptureEvent {
  /** 单调序号，后端排序键（同一毫秒内多请求也能定序） */
  seq: number;
  /** 捕获时刻（Unix 毫秒） */
  atMs: number;
  kind: CaptureKind;
  /** 会话 ID：并发同会话时靠时间线人工配对（后端没有贯穿请求/响应的 id） */
  sessionId: string;
  appType: string;
  providerId: string;
  model: string;
  /** 非流式响应 / 错误体的 HTTP 状态；请求条目为 null */
  status: number | null;
  /** 仅对 response 有意义：true = 透传路径的上游原文；false = 格式转换后的响应 */
  rawUpstream: boolean;
  /** body 原文（JSON 尽量美化；后端截断到 200k 字符） */
  body: string;
  /** body 是否被后端截断 */
  truncated: boolean;
}

export const debugCaptureApi = {
  /** 读取当前捕获开关状态。 */
  async getEnabled(): Promise<boolean> {
    return invoke("get_debug_capture_enabled");
  },

  /** 开/关捕获，返回后端生效后的状态。 */
  async setEnabled(enabled: boolean): Promise<boolean> {
    return invoke("set_debug_capture_enabled", { enabled });
  },

  /** 读取捕获快照（按 seq 升序）。前端轮询此命令刷新面板。 */
  async getEvents(): Promise<CaptureEvent[]> {
    return invoke("get_debug_capture_events");
  },

  /** 清空捕获缓冲，返回被清空条数。 */
  async clear(): Promise<number> {
    return invoke("clear_debug_capture");
  },
};
