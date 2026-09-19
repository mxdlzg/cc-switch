import { invoke } from "@tauri-apps/api/core";

/**
 * 请求重放（Replay）的类型与命令封装。
 *
 * 场景：某些供应商有并发席位上限（几百人抢几十席，抢不到的一律 500）。从「请求查看
 * 器」选一条抓到的出站请求，交给后端按频率自动重发，抢到席位后停止并弹系统通知。
 *
 * 冻结语义：重放用的是**抓取那一刻**的 method / URL / 头集合（含鉴权）/ body 字节，
 * 不回读当前供应商、不跟随接管开关。代价是期间轮换密钥会让重放持续 401 并立即停止。
 */

/**
 * 节奏模式，对应后端 `PaceMode`（serde snake_case）。
 *
 * - `fixed`：固定间隔
 * - `backoff`：一条从起始秒指数增长、到封顶后**永远按封顶等**的退避链
 * - `burst`：仿 Codex CLI 的两级节奏——一轮内连打 N 次（轮内用与 `backoff` 同一条
 *   指数曲线，但**每轮重置**回起始秒），轮与轮之间是 [min,max] 内的随机间隔。
 */
export type PaceMode = "fixed" | "backoff" | "burst";

/** 任务状态，对应后端 `ReplayState`。 */
export type ReplayState =
  | "running"
  | "succeeded"
  | "failed"
  | "capped"
  | "stopped";

/** 查看器条目的重放可用性（后端只回元信息，**不含鉴权头**）。 */
export interface ReplaySnapshotInfo {
  available: boolean;
  method: string;
  /** 目标 URL 的 origin（不含 path——path 可能内嵌密钥） */
  targetOrigin: string;
  appType: string;
  providerId: string;
  model: string;
  bodyLen: number;
  headerCount: number;
}

/** 重放配置。数值一律字符串：直接绑定输入框，区间校验在后端集中做。 */
export interface ReplayConfigInput {
  mode: PaceMode;
  intervalSecs: string;
  backoffStartSecs: string;
  /** 百分比整数（200 = ×2） */
  backoffMultPercent: string;
  backoffCapSecs: string;
  /** 一轮里连打几次（burst） */
  burstAttemptsPerRound: string;
  /** 轮间随机间隔下限秒（burst） */
  burstRoundGapMinSecs: string;
  /** 轮间随机间隔上限秒（burst，需 ≥ min） */
  burstRoundGapMaxSecs: string;
  requiredConsecutive: string;
  /** 逗号分隔状态码，如 `"500"` 或 `"500, 529"` */
  retryableStatuses: string;
  maxAttempts: string;
  maxDurationMinutes: string;
}

/** 重放进度（后端 emit `replay-progress`，也是 get_replay_status 的返回体）。 */
export interface ReplayStatus {
  state: ReplayState;
  targetOrigin: string;
  method: string;
  mode: PaceMode;
  attempts: number;
  consecutive: number;
  requiredConsecutive: number;
  lastStatus: number | null;
  lastError: string | null;
  startedAtMs: number;
  elapsedMs: number;
}

/** 默认配置：固定 3 秒、连续成功 1 次即停、仅 500 可重试、500 次 / 60 分钟封顶。
 *
 * burst 三件套即使在 fixed 模式下也带着默认值：后端**不分模式**一律校验区间，缺字段
 * 会让 `start_replay` 直接反序列化失败（前端这里的默认值就是契约的另一半）。
 */
export const DEFAULT_REPLAY_CONFIG: ReplayConfigInput = {
  mode: "fixed",
  intervalSecs: "3",
  backoffStartSecs: "2",
  backoffMultPercent: "200",
  backoffCapSecs: "30",
  burstAttemptsPerRound: "5",
  burstRoundGapMinSecs: "30",
  burstRoundGapMaxSecs: "180",
  requiredConsecutive: "1",
  retryableStatuses: "500",
  maxAttempts: "500",
  maxDurationMinutes: "60",
};

export const replayApi = {
  /** 按需读取某条目的快照信息（点「重放」时预检；不进每秒轮询）。 */
  async getSnapshotInfo(seq: number): Promise<ReplaySnapshotInfo> {
    return invoke("get_debug_capture_snapshot", { seq });
  },

  /** 启动重放。快照缺失或已有任务在跑时 reject。 */
  async start(
    snapshotSeq: number,
    config: ReplayConfigInput,
  ): Promise<ReplayStatus> {
    return invoke("start_replay", { snapshotSeq, config });
  },

  /** 请求停止（异步生效：间隔期内立刻退出）。 */
  async stop(): Promise<ReplayStatus | null> {
    return invoke("stop_replay");
  },

  /** 读取当前/上一次重放状态。 */
  async getStatus(): Promise<ReplayStatus | null> {
    return invoke("get_replay_status");
  },
};
