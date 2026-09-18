//! 请求调试捕获（临时 debug 用，纯内存、不落盘）
//!
//! 打开开关后，代理在若干关键点把「出站请求体 / 上游响应体 / 上游错误体」投进
//! 一个有界队列，后台任务落入固定容量的环形缓冲；前端轮询查看。关闭后
//! `record_*` 首行即返回，行为与不带此功能时**完全一致**（零额外序列化）。
//!
//! 关键约束：
//! - **不阻塞主流程**：投递用 `try_send`，队列满则丢弃本次捕获，绝不 `await`、
//!   绝不回压转发路径。
//! - **不落盘、不审计**：只进内存，进程重启即清空；与 `proxy_request_logs` 表、
//!   日志文件都无关。
//! - **单具身捕获有字节上限**：单个 body 截断到 [`MAX_BODY_CHARS`]，缓冲总量由
//!   条数上限 [`CAPTURE_CAP`] 兜底。
//! - **流式响应不在这里捕获**：SSE 走透传、体积极大且非本次 debug 目标，
//!   仅捕获「请求 + 非流式响应 + 错误体」。
//!
//! 关联键：`turn_id` 标记**一次入站 HTTP 请求**，同一轮内的入站/出站/响应/错误
//! 事件共享它，前端据此配对成「一轮问答」。`session_id` 是**整段对话**（客户端带的
//! metadata.session_id），一轮对话里有几十次往返，只能当过滤维度、不能当轮次边界。
//! 故障转移/整流的同请求重试会再次进 forward()，它们**共用同一个 turn_id**——用户
//! 眼里的「一轮」是他按的那一次回车，不是我们内部试了几个供应商。
//!
//! 重放快照：查看器里的条目只有 body 文本，缺 method / URL / 头，无法独立重发。
//! 发送前那一刻四元组才齐备，故另存一张 [`RequestSnapshot`] 旁路表（按请求条目的
//! `seq` 关联），供重放器原样重发。头里含鉴权，**只有元信息会经命令离开后端**。

use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tokio::sync::mpsc;

/// 环形缓冲最大条数。超出后挤掉最旧的一条。
const CAPTURE_CAP: usize = 50;

/// 投递通道容量。短暂积压上限，满即丢（不阻塞转发）。
const QUEUE_CAPACITY: usize = 256;

/// 单个 body 的字符上限。超出截断并附标记，防止一次超大响应撑爆内存。
const MAX_BODY_CHARS: usize = 200_000;

/// 单个重放快照 body 的字节硬顶。超出则**不存快照**（该条目不可重放），
/// 避免一次几十 MB 的多模态请求把内存吃穿——查看器里的截断文本无法重放，
/// 快照又必须是完整字节，二者不可兼得，只能放弃这一条。
const MAX_SNAPSHOT_BODY_BYTES: usize = 8 * 1024 * 1024;

/// 开关。`false` 时 `record_*` 首行即返回，消费者任务也不会被拉起。
static ENABLED: AtomicBool = AtomicBool::new(false);

/// 消费者任务只启动一次（首次在有 tokio 运行时的捕获点启动）。
static CONSUMER_STARTED: OnceLock<()> = OnceLock::new();

/// 投递侧发送端；消费者任务取出后独占接收端。
static TX: OnceLock<mpsc::Sender<CaptureEvent>> = OnceLock::new();

/// 环形缓冲（读端快照 + 写端 push/pop 共用一把锁；捕获是低频操作，无争用压力）。
static BUFFER: OnceLock<Mutex<VecDeque<CaptureEvent>>> = OnceLock::new();

/// 单调递增序号，供前端排序 / 去重（同一毫秒内多请求也能定序）。
static SEQ: AtomicU64 = AtomicU64::new(0);

/// 轮次号发号器：**每个入站 HTTP 请求一个**，由 `RequestContext::new` 取号。
///
/// 与 `SEQ` 分开是刻意的：`SEQ` 是条目排序键（每条事件一个），`TURN` 是轮次身份
/// （一轮内多条事件共用）。并发请求的事件在缓冲里必然交错，只有独立身份键才能
/// 把它们分回各自的轮次——按「相邻同 session」分组会把整段对话挤成一轮。
static TURN: AtomicU64 = AtomicU64::new(0);

/// 取一个新轮次号。在请求入口调一次，之后该请求的所有捕获点共用返回值。
pub fn next_turn_id() -> u64 {
    TURN.fetch_add(1, Ordering::Relaxed)
}

/// 重放快照旁路表：`seq`（`request` 条目的序号）→ 完整四元组。
///
/// **刻意不进 [`CaptureEvent`]**：前端每秒整表轮询 `snapshot()`，把头集合与 body
/// 字节塞进去等于每秒搬运一份密钥 + 大 body。这张表只在用户显式点「重放」时
/// 按 seq 单条取用。容量与环形缓冲同步（见 [`buffer_push`] 的联动剪枝 + 硬顶）。
static SNAPSHOTS: OnceLock<Mutex<BTreeMap<u64, RequestSnapshot>>> = OnceLock::new();

/// 捕获类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureKind {
    /// 客户端原始请求体（未经模型映射 / 格式转换 / 私有参数过滤），排查"到底传进来什么"
    ClientRequest,
    /// 出站请求体（格式转换 / 模型映射 / 私有参数过滤后，真正发往上游的 JSON）
    Request,
    /// 上游 2xx 非流式响应体
    Response,
    /// 上游非 2xx 错误体（400/401/429/5xx 的响应体原文）
    Error,
    /// 重放器成功（或终态）时拿到的响应体——客户端从未收到它，故存进查看器供回看
    ReplayResponse,
}

/// 一次出站请求的**完整四元组**快照，重放器据此原样重发。
///
/// 语义是「冻结」：存的是发送那一刻的 method / 最终 URL / 最终头集合（**含鉴权**）/
/// body 字节。重放不回读 provider 表、不跟随接管开关，因此用户可以一边重打被限流的
/// 供应商、一边切到别的供应商正常使用。代价：期间轮换密钥会让重放持续 401。
#[derive(Debug, Clone)]
pub struct RequestSnapshot {
    /// HTTP 方法（大写，如 `POST`）
    pub method: String,
    /// 最终上游 URL（含 query，已含 base_url 拼接结果）
    pub url: String,
    /// 最终发往上游的头集合，含鉴权头。保留原始顺序。
    pub headers: Vec<(String, String)>,
    /// 原始 body 字节（不 pretty、不截断；超过硬顶则整条快照不入库）
    pub body: Vec<u8>,
    /// 以下四项只为给重放响应打标签（写回查看器时与请求条目同属一路），
    /// 不参与重放本身。
    pub session_id: String,
    pub app_type: String,
    pub provider_id: String,
    pub model: String,
}

/// 一条捕获记录。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureEvent {
    /// 单调序号（前端排序键）
    pub seq: u64,
    /// **一次入站请求**的标识：同一轮内的入站/出站/响应/错误共享它。
    /// 由 `RequestContext::new` 打号（每次 HTTP 请求一个），所以「一轮」等于用户那一次
    /// 回车，而不是我们内部试了几个供应商。`session_id` 是整段对话，不能当轮次边界。
    pub turn_id: u64,
    /// 捕获时刻（Unix 毫秒）
    pub at_ms: i64,
    pub kind: CaptureKind,
    /// 会话 ID（关联同一对话的请求与响应；并发同会话时以时间戳区分）
    pub session_id: String,
    pub app_type: String,
    pub provider_id: String,
    pub model: String,
    /// 非流式响应 / 错误体的 HTTP 状态；请求条目为 None
    pub status: Option<u16>,
    /// 仅对 Response 有意义：true=透传路径的上游原文；false=格式转换后的响应。
    /// 请求 / 错误条目恒为 false。
    pub raw_upstream: bool,
    /// body 原文（JSON 尽量美化；截断到 [`MAX_BODY_CHARS`]）
    pub body: String,
    /// body 是否被截断
    pub truncated: bool,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn buffer() -> &'static Mutex<VecDeque<CaptureEvent>> {
    BUFFER.get_or_init(|| Mutex::new(VecDeque::with_capacity(CAPTURE_CAP)))
}

fn snapshots() -> &'static Mutex<BTreeMap<u64, RequestSnapshot>> {
    SNAPSHOTS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// 写入环形缓冲（满则挤旧），并**联动**丢弃被挤掉那条的重放快照。
///
/// 剪枝只针对被挤出的 seq：不能按「缓冲里还剩哪些 seq」全表对账，因为快照是在
/// 发送前写的、而对应事件可能还在队列里没落进缓冲（对账会误杀在途快照）。
fn buffer_push(event: CaptureEvent) {
    let evicted: Vec<u64> = {
        let buf = buffer();
        let mut guard = match buf.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut gone = Vec::new();
        if guard.len() >= CAPTURE_CAP {
            if let Some(old) = guard.pop_front() {
                gone.push(old.seq);
            }
        }
        guard.push_back(event);
        gone
    };
    if evicted.is_empty() {
        return;
    }
    let mut snaps = match snapshots().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    for seq in evicted {
        snaps.remove(&seq);
    }
}

/// 首次捕获时惰性拉起消费者任务。
///
/// 仅在**已有 tokio 运行时**时启动（生产路径：forwarder/response_processor 都跑在
/// tokio 任务里）。无运行时（单元测试）返回 false，调用方走直写缓冲兜底——
/// `tokio::spawn` 在没有运行时时会 panic，必须先检查。
fn ensure_consumer() -> bool {
    if tokio::runtime::Handle::try_current().is_err() {
        return false;
    }
    CONSUMER_STARTED.get_or_init(|| {
        let (tx, mut rx) = mpsc::channel::<CaptureEvent>(QUEUE_CAPACITY);
        // 发送端存入全局，供 record_* 使用。
        let _ = TX.set(tx);
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                buffer_push(event);
            }
        });
    });
    true
}

/// 设置捕获开关。
///
/// 关闭只停止**新**捕获；已有缓冲保留到显式 `clear` 或进程重启，
/// 方便关掉开关后仍能翻看刚抓到的内容。
pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Release);
    log::info!(
        "[DebugCapture] 请求调试捕获已{}",
        if enabled { "开启" } else { "关闭" }
    );
}

/// 当前开关状态。
pub fn is_enabled() -> bool {
    ENABLED.load(Ordering::Acquire)
}

/// 返回缓冲快照（按 seq 升序）。锁内只做 clone，随即释放。
pub fn snapshot() -> Vec<CaptureEvent> {
    let guard = match buffer().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard.iter().cloned().collect()
}

/// 清空缓冲（返回被清空条数）。快照旁路表一并清空（含密钥，不留）。
pub fn clear() -> usize {
    let n = {
        let mut guard = match buffer().lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let n = guard.len();
        guard.clear();
        n
    };
    if let Ok(mut snaps) = snapshots().lock() {
        snaps.clear();
    }
    n
}

/// 记录一次出站请求的重放快照，键为对应 `request` 条目的 `seq`。
///
/// `request_seq=None`（抓取关闭 → `record_request` 没入库）时直接返回，避免留下
/// 查看器里看不到的孤儿快照。body 超过 [`MAX_SNAPSHOT_BODY_BYTES`] 时不存：
/// 前端会因取不到快照而禁用重放按钮并说明原因。
pub fn record_snapshot(request_seq: Option<u64>, snapshot: RequestSnapshot) {
    let Some(seq) = request_seq else { return };
    if !is_enabled() {
        return;
    }
    if snapshot.body.len() > MAX_SNAPSHOT_BODY_BYTES {
        log::debug!(
            "[DebugCapture] 跳过重放快照: body={}B 超过上限 {}B",
            snapshot.body.len(),
            MAX_SNAPSHOT_BODY_BYTES
        );
        return;
    }
    let mut guard = match snapshots().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    // 队列饱和时事件可能被丢弃、快照却留下了 → 用硬顶兜住内存，按 seq 挤最旧。
    while guard.len() >= CAPTURE_CAP {
        let Some((&oldest, _)) = guard.iter().next() else {
            break;
        };
        guard.remove(&oldest);
    }
    guard.insert(seq, snapshot);
}

/// 按 seq 取回快照（深拷贝，锁内不做事后处理）。取不到即「该条目不可重放」。
pub fn get_snapshot(request_seq: u64) -> Option<RequestSnapshot> {
    let guard = match snapshots().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard.get(&request_seq).cloned()
}

/// 截断到 [`MAX_BODY_CHARS`]，返回 (文本, 是否截断)。
fn truncate(text: String) -> (String, bool) {
    if text.chars().count() <= MAX_BODY_CHARS {
        return (text, false);
    }
    let kept: String = text.chars().take(MAX_BODY_CHARS).collect();
    (
        format!("{kept}\n… [truncated at {MAX_BODY_CHARS} chars]"),
        true,
    )
}

/// 投递一条捕获。**未开启时首行返回 None**，不做任何序列化。
///
/// `body` 已是最终字符串（美化 JSON 或原文）；调用方负责生成，
/// 以免在未开启时无谓序列化。
///
/// 返回值：入库成功的条目序号，供调用方关联旁路数据（重放快照）；关闭或队列饱和
/// 丢弃时返回 None——此时查看器里看不到这条，旁路数据也就不必存在。
#[allow(clippy::too_many_arguments)]
fn push(
    kind: CaptureKind,
    turn_id: u64,
    session_id: &str,
    app_type: &str,
    provider_id: &str,
    model: &str,
    status: Option<u16>,
    raw_upstream: bool,
    body: String,
) -> Option<u64> {
    // 快速路径：关闭时零成本返回。
    if !is_enabled() {
        return None;
    }
    let (body, truncated) = truncate(body);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let event = CaptureEvent {
        seq,
        turn_id,
        at_ms: now_ms(),
        kind,
        session_id: session_id.to_string(),
        app_type: app_type.to_string(),
        provider_id: provider_id.to_string(),
        model: model.to_string(),
        status,
        raw_upstream,
        body,
        truncated,
    };

    // 消费者就绪 → try_send：队列满时直接丢本次捕获，绝不阻塞转发主流程。
    // 无 tokio 运行时（如单元测试）→ 直写缓冲，保持语义一致。
    if ensure_consumer() {
        let tx = TX.get()?;
        if let Err(e) = tx.try_send(event) {
            log::debug!("[DebugCapture] 丢弃一条捕获（队列饱和）: {e}");
            return None;
        }
    } else {
        buffer_push(event);
    }
    Some(seq)
}

/// 美化一个 JSON body；无法美化时退回原始字符串表示。
fn pretty_json(value: &serde_json::Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

/// 捕获客户端原始请求体(未经任何映射/转换/过滤)。用于排查"客户端到底传进来
/// 什么"——例如确认 Claude Code 是否真的带了 `thinking` / `output_config.effort`。
pub fn record_client_request(
    turn_id: u64,
    session_id: &str,
    app_type: &str,
    provider_id: &str,
    model: &str,
    original_body: &serde_json::Value,
) {
    if !is_enabled() {
        return;
    }
    let _ = push(
        CaptureKind::ClientRequest,
        turn_id,
        session_id,
        app_type,
        provider_id,
        model,
        None,
        false,
        pretty_json(original_body),
    );
}

/// 捕获出站请求体。`filtered_body` 为发往上游的最终 JSON。
///
/// 返回入库的 `seq`——调用方（forwarder）拿它当关联键写重放快照。关闭态返回 None。
pub fn record_request(
    turn_id: u64,
    session_id: &str,
    app_type: &str,
    provider_id: &str,
    model: &str,
    filtered_body: &serde_json::Value,
) -> Option<u64> {
    if !is_enabled() {
        return None;
    }
    push(
        CaptureKind::Request,
        turn_id,
        session_id,
        app_type,
        provider_id,
        model,
        None,
        false,
        pretty_json(filtered_body),
    )
}

/// 捕获上游 2xx 非流式响应体。`bytes` 为解压后的原始响应字节。
///
/// `raw_upstream=false` 表示字节来自格式转换后的响应（客户端所见），而非上游原文。
#[allow(clippy::too_many_arguments)]
pub fn record_response(
    turn_id: u64,
    session_id: &str,
    app_type: &str,
    provider_id: &str,
    model: &str,
    status: u16,
    bytes: &[u8],
    raw_upstream: bool,
) {
    if !is_enabled() {
        return;
    }
    // 尝试当 JSON 美化；非 UTF-8 / 非 JSON 则按文本呈现（失败退化为 lossy）。
    let body = match serde_json::from_slice::<serde_json::Value>(bytes) {
        Ok(value) => pretty_json(&value),
        Err(_) => String::from_utf8_lossy(bytes).into_owned(),
    };
    let _ = push(
        CaptureKind::Response,
        turn_id,
        session_id,
        app_type,
        provider_id,
        model,
        Some(status),
        raw_upstream,
        body,
    );
}

/// 捕获上游非 2xx 错误体。`body_text` 已是解压 + UTF-8 解码后的文本（可能为 None）。
pub fn record_error(
    turn_id: u64,
    session_id: &str,
    app_type: &str,
    provider_id: &str,
    model: &str,
    status: u16,
    body_text: Option<&str>,
) {
    if !is_enabled() {
        return;
    }
    let raw = body_text.unwrap_or("<no body / non-utf8>");
    let body = match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(value) => pretty_json(&value),
        Err(_) => raw.to_string(),
    };
    let _ = push(
        CaptureKind::Error,
        turn_id,
        session_id,
        app_type,
        provider_id,
        model,
        Some(status),
        false,
        body,
    );
}

/// 捕获重放器拿到的响应体。重放的响应**客户端从未收到**（没有人在等它），
/// 所以存进查看器供回看——用户人不在电脑前，成功后要能点开看内容。
///
/// **不受 `ENABLED` 管辖**（本模块唯一例外）：这不是转发管线的捕获点，而是重放功能
/// 自己的产物，用户点名要它落到这个查看器里。抓取开关关掉只保留既有缓冲（既有设计），
/// 此时重放产物照进——否则成功通知会说「见查看器」而查看器里什么都没有。
/// 容量仍由同一个 [`CAPTURE_CAP`] 环形缓冲兜住。
///
/// 与接管/网关无关：重放器直接打快照里的 URL，不经过 forwarder，因此这一条
/// 不进 `proxy_request_logs`、不计费、不搅仪表盘。
pub fn record_replay_response(
    session_id: &str,
    app_type: &str,
    provider_id: &str,
    model: &str,
    status: u16,
    bytes: &[u8],
) {
    let body = match serde_json::from_slice::<serde_json::Value>(bytes) {
        Ok(value) => pretty_json(&value),
        Err(_) => String::from_utf8_lossy(bytes).into_owned(),
    };
    // 直接走 buffer_push：`push` 的首行就是 is_enabled 短路，这里要绕开它。
    let (body, truncated) = truncate(body);
    buffer_push(CaptureEvent {
        seq: SEQ.fetch_add(1, Ordering::Relaxed),
        // 自成一轮：重放不挂在任何 CLI 请求上（那份响应客户端从未收到），而且原请求
        // 那一轮已有自己的响应——再塞第二个响应进去只会让「这轮的响应是哪个」更糊涂。
        turn_id: next_turn_id(),
        at_ms: now_ms(),
        kind: CaptureKind::ReplayResponse,
        session_id: session_id.to_string(),
        app_type: app_type.to_string(),
        provider_id: provider_id.to_string(),
        model: model.to_string(),
        status: Some(status),
        raw_upstream: true,
        body,
        truncated,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 本模块测试共用全局 ENABLED/BUFFER，必须串行（cargo test 默认并行跑测试）。
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn with_isolated_buffer<T>(f: impl FnOnce() -> T) -> T {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        clear();
        let out = f();
        set_enabled(false);
        clear();
        out
    }

    #[test]
    fn disabled_drops_and_enabled_captures() {
        with_isolated_buffer(|| {
            // 无 tokio 运行时的测试环境走直写兜底 → 同步、无轮询。
            set_enabled(false);
            record_request(1, "s", "claude", "p", "m", &json!({"a": 1}));
            assert!(snapshot().is_empty(), "关闭态不应产生任何捕获");

            set_enabled(true);
            record_request(
                1,
                "s1",
                "claude",
                "prov",
                "model-x",
                &json!({ "hi": "there" }),
            );
            let snap = snapshot();
            let ev = snap
                .iter()
                .find(|e| e.session_id == "s1")
                .expect("开启态应能捕获到请求条目");
            assert_eq!(ev.kind, CaptureKind::Request);
            assert_eq!(ev.provider_id, "prov");
            assert!(ev.body.contains("\"hi\""));
            assert!(!ev.truncated);
            assert_eq!(ev.status, None);
        });
    }

    #[test]
    fn turn_id_separates_interleaved_requests() {
        with_isolated_buffer(|| {
            set_enabled(true);
            // 两个并发请求的事件在缓冲里必然交错；只有 turn_id 能把它们分回各自轮次
            // （session 是整段对话，同一段对话里这两次回车共享它）。
            let turn_a = next_turn_id();
            let turn_b = next_turn_id();
            assert!(turn_b > turn_a, "发号必须单调递增");
            record_request(turn_a, "s", "claude", "p", "m", &json!({"n": "a"}));
            record_request(turn_b, "s", "claude", "p", "m", &json!({"n": "b"}));
            record_response(turn_a, "s", "claude", "p", "m", 200, br#"{"ok":1}"#, true);
            record_response(turn_b, "s", "claude", "p", "m", 500, br#"{"ok":2}"#, true);

            let snap = snapshot();
            for turn in [turn_a, turn_b] {
                let of_turn: Vec<&CaptureEvent> =
                    snap.iter().filter(|e| e.turn_id == turn).collect();
                assert_eq!(of_turn.len(), 2, "每个轮次应有请求+响应各一条");
            }
            let resp_a = snap
                .iter()
                .find(|e| e.turn_id == turn_a && e.kind == CaptureKind::Response)
                .unwrap();
            let resp_b = snap
                .iter()
                .find(|e| e.turn_id == turn_b && e.kind == CaptureKind::Response)
                .unwrap();
            assert_eq!(resp_a.status, Some(200));
            assert_eq!(resp_b.status, Some(500), "同 session 也不该串到别的轮次");
        });
    }

    #[test]
    fn error_body_captured_with_status() {
        with_isolated_buffer(|| {
            set_enabled(true);
            record_error(
                1,
                "s2",
                "claude",
                "prov",
                "model-x",
                400,
                Some(r#"{"error":{"message":"System message must be at the beginning."}}"#),
            );
            let snap = snapshot();
            let ev = snap.iter().find(|e| e.kind == CaptureKind::Error).unwrap();
            assert_eq!(ev.status, Some(400));
            assert!(ev.body.contains("must be at the beginning"));
        });
    }

    #[test]
    fn truncate_flags_long_body() {
        let long = "x".repeat(MAX_BODY_CHARS + 10);
        let (out, truncated) = truncate(long);
        assert!(truncated);
        assert!(out.contains("truncated at"));
    }

    #[test]
    fn cap_evicts_oldest() {
        with_isolated_buffer(|| {
            for i in 0..(CAPTURE_CAP + 5) {
                buffer_push(CaptureEvent {
                    seq: i as u64,
                    turn_id: 1,
                    at_ms: 0,
                    kind: CaptureKind::Request,
                    session_id: "s".into(),
                    app_type: "a".into(),
                    provider_id: "p".into(),
                    model: "m".into(),
                    status: None,
                    raw_upstream: false,
                    body: String::new(),
                    truncated: false,
                });
            }
            let snap = snapshot();
            assert_eq!(snap.len(), CAPTURE_CAP);
            assert_eq!(snap.first().unwrap().seq, 5, "最旧的 5 条应被挤掉");
        });
    }

    fn snap(body: &[u8]) -> RequestSnapshot {
        RequestSnapshot {
            method: "POST".into(),
            url: "https://upstream.test/v1/messages?x=1".into(),
            headers: vec![
                ("authorization".into(), "Bearer sk-frozen".into()),
                ("content-type".into(), "application/json".into()),
            ],
            body: body.to_vec(),
            session_id: "s".into(),
            app_type: "claude".into(),
            provider_id: "prov".into(),
            model: "m".into(),
        }
    }

    #[test]
    fn snapshot_roundtrip_and_none_when_disabled() {
        with_isolated_buffer(|| {
            set_enabled(false);
            assert_eq!(
                record_request(1, "s", "claude", "p", "m", &json!({"a": 1})),
                None,
                "关闭态 record_request 不应返回 seq"
            );
            record_snapshot(Some(999), snap(b"{\"a\":1}"));
            assert!(get_snapshot(999).is_none(), "关闭态不应存快照");

            set_enabled(true);
            let seq = record_request(1, "s1", "claude", "prov", "m", &json!({ "a": 1 }))
                .expect("开启态应返回 seq");
            record_snapshot(Some(seq), snap(br#"{"a":1}"#));
            let got = get_snapshot(seq).expect("应能按 seq 取回快照");
            assert_eq!(got.method, "POST");
            assert!(got.url.contains("v1/messages"));
            assert_eq!(got.headers[0].1, "Bearer sk-frozen", "鉴权头必须原样保留");
            assert_eq!(got.body, br#"{"a":1}"#.to_vec());

            // None 键（事件被丢弃）→ 不留孤儿快照
            record_snapshot(None, snap(b"{}"));

            clear();
            assert!(get_snapshot(seq).is_none(), "clear 应一并清掉含密钥的快照");
        });
    }

    #[test]
    fn snapshot_evicted_with_buffer_and_capped() {
        with_isolated_buffer(|| {
            set_enabled(true);
            let first = record_request(1, "s", "claude", "p", "m", &json!({"n": 0}))
                .expect("开启态应返回 seq");
            record_snapshot(Some(first), snap(b"{}"));
            assert!(get_snapshot(first).is_some());

            // 挤爆环形缓冲 → 被挤掉那条的快照必须一起走，否则表会无界增长
            for i in 0..(CAPTURE_CAP + 1) {
                record_request(1, "s", "claude", "p", "m", &json!({"n": i}));
            }
            assert_eq!(snapshot().len(), CAPTURE_CAP);
            assert!(
                get_snapshot(first).is_none(),
                "被挤出缓冲的条目其快照应联动删除"
            );
        });
    }

    #[test]
    fn oversized_body_skips_snapshot() {
        with_isolated_buffer(|| {
            set_enabled(true);
            let seq = record_request(1, "s", "claude", "p", "m", &json!({"a": 1})).unwrap();
            let huge = vec![0u8; MAX_SNAPSHOT_BODY_BYTES + 1];
            record_snapshot(Some(seq), snap(&huge));
            assert!(
                get_snapshot(seq).is_none(),
                "超过硬顶的 body 不存快照（前端会禁用重放而非重发半截内容）"
            );
        });
    }

    #[test]
    fn replay_response_survives_disabled_capture() {
        with_isolated_buffer(|| {
            // 用户可以先关抓取（缓冲保留可回看）再重放；成功通知写着「见查看器」，
            // 所以重放响应必须真能进去 —— 这是本模块唯一不受 ENABLED 管辖的写入。
            set_enabled(false);
            record_request(1, "s", "claude", "p", "m", &json!({"a": 1}));
            assert!(snapshot().is_empty(), "普通捕获仍受开关管辖");

            record_replay_response("s9", "codex", "prov", "gpt-x", 200, br#"{"ok":true}"#);
            let snap = snapshot();
            let ev = snap
                .iter()
                .find(|e| e.kind == CaptureKind::ReplayResponse)
                .expect("关闭态也应收下重放响应");
            assert_eq!(ev.status, Some(200));
            assert!(ev.body.contains("\"ok\""), "JSON 应被美化");
        });
    }
}
