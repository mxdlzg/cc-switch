import { invoke } from "@tauri-apps/api/core";

/**
 * 请求调试捕获（临时 debug 用）的类型与命令封装。
 *
 * 纯内存、不落盘：开关 + 快照读取 + 清空，数据在 `proxy::debug_capture` 的环形
 * 缓冲里，进程重启即清空。与「应用诊断日志」（写 logs/ 的 cc-switch.log）是两回事。
 */

/**
 * 捕获类型，对应后端 `CaptureKind`（serde snake_case）。
 *
 * `replay_response` 由重放器写入：那份响应客户端从未收到（没人在等它），存进来是
 * 给用户回来点开看的。
 *
 * `stream_response` 是流式（SSE）响应的**元信息**：上游回 200 + `text/event-stream`
 * 那一刻我们就已经知道「响应到了」，所以必须有这一条（否则那一轮看起来像没响应），
 * 但**正文刻意不抓**（SSE 体积大且非 debug 目标）。
 */
export type CaptureKind =
  | "client_request"
  | "request"
  | "response"
  | "error"
  | "replay_response"
  | "stream_response";

/** 流式响应的收尾方式，对应后端 `StreamOutcome`。 */
export type StreamOutcome =
  | "completed"
  | "first_byte_timeout"
  | "idle_timeout"
  | "upstream_error"
  | "aborted";

/** 流式响应的统计，对应后端 `StreamStats`（camelCase）。 */
export interface StreamStats {
  /** 透传给客户端的块数 */
  chunks: number;
  /** 累计字节数 */
  bytes: number;
  /** 从流开始到收尾的耗时（毫秒） */
  elapsedMs: number;
  outcome: StreamOutcome;
}

/** 一条捕获记录，字段对应后端 `CaptureEvent`（camelCase）。 */
export interface CaptureEvent {
  /** 单调序号，后端排序键（同一毫秒内多请求也能定序） */
  seq: number;
  /**
   * 轮次号：**一次入站 HTTP 请求**一个，该轮的入站/出站/响应/错误事件共享它。
   *
   * 前端据此配对「一轮问答」——故障转移/整流会重进 forward()，同一次回车因此产生
   * 多条事件但同一个 turnId，仍是一行。`sessionId` 是整段对话，不能当轮次边界。
   */
  turnId: number;
  /** 捕获时刻（Unix 毫秒） */
  atMs: number;
  kind: CaptureKind;
  /** 会话 ID：整段对话共享，用于跨轮关联/过滤（不用于分轮） */
  sessionId: string;
  appType: string;
  providerId: string;
  model: string;
  /** 响应类条目的 HTTP 状态（含流式：200 + text/event-stream）；请求条目为 null */
  status: number | null;
  /** 仅对响应类条目有意义：true = 透传路径的上游原文；false = 格式转换后的响应 */
  rawUpstream: boolean;
  /** body 原文（JSON 尽量美化；后端截断到 200k 字符）。流式条目恒为空串 */
  body: string;
  /** body 是否被后端截断 */
  truncated: boolean;
  /**
   * 仅流式条目（`kind === "stream_response"`）有意义：块数/字节数/耗时/结局。
   *
   * 后端 `skip_serializing_if` 省略 None，所以**字段可能整个缺席**。流开始时的条目
   * 先落库、流结束时按 seq 就地回填这里的统计；没回填说明流还在跑（或已被挤掉）。
   */
  stream?: StreamStats;
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
