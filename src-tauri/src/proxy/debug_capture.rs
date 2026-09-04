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
//! 关联：没有贯穿请求/响应的 request_id（DB 里的 `request_id` 是响应回来后才由
//! `message_id` 派生的），故各条只带 `session_id`，前端按会话 + 时间线人工配对。

use std::collections::VecDeque;
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

/// 捕获类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureKind {
    /// 出站请求体（格式转换 / 模型映射 / 私有参数过滤后，真正发往上游的 JSON）
    Request,
    /// 上游 2xx 非流式响应体
    Response,
    /// 上游非 2xx 错误体（400/401/429/5xx 的响应体原文）
    Error,
}

/// 一条捕获记录。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureEvent {
    /// 单调序号（前端排序键）
    pub seq: u64,
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

/// 写入环形缓冲（满则挤旧）。消费者任务与「无运行时直写」兜底共用。
fn buffer_push(event: CaptureEvent) {
    let buf = buffer();
    let mut guard = match buf.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if guard.len() >= CAPTURE_CAP {
        guard.pop_front();
    }
    guard.push_back(event);
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

/// 清空缓冲（返回被清空条数）。
pub fn clear() -> usize {
    let mut guard = match buffer().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    let n = guard.len();
    guard.clear();
    n
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

/// 投递一条捕获。**未开启时首行返回**，不做任何序列化。
///
/// `body` 已是最终字符串（美化 JSON 或原文）；调用方负责生成，
/// 以免在未开启时无谓序列化。
fn push(
    kind: CaptureKind,
    session_id: &str,
    app_type: &str,
    provider_id: &str,
    model: &str,
    status: Option<u16>,
    raw_upstream: bool,
    body: String,
) {
    // 快速路径：关闭时零成本返回。
    if !is_enabled() {
        return;
    }
    let (body, truncated) = truncate(body);
    let event = CaptureEvent {
        seq: SEQ.fetch_add(1, Ordering::Relaxed),
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
        let Some(tx) = TX.get() else { return };
        if let Err(e) = tx.try_send(event) {
            log::debug!("[DebugCapture] 丢弃一条捕获（队列饱和）: {e}");
        }
    } else {
        buffer_push(event);
    }
}

/// 美化一个 JSON body；无法美化时退回原始字符串表示。
fn pretty_json(value: &serde_json::Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

/// 捕获出站请求体。`filtered_body` 为发往上游的最终 JSON。
pub fn record_request(
    session_id: &str,
    app_type: &str,
    provider_id: &str,
    model: &str,
    filtered_body: &serde_json::Value,
) {
    if !is_enabled() {
        return;
    }
    push(
        CaptureKind::Request,
        session_id,
        app_type,
        provider_id,
        model,
        None,
        false,
        pretty_json(filtered_body),
    );
}

/// 捕获上游 2xx 非流式响应体。`bytes` 为解压后的原始响应字节。
///
/// `raw_upstream=false` 表示字节来自格式转换后的响应（客户端所见），而非上游原文。
pub fn record_response(
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
    push(
        CaptureKind::Response,
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
    push(
        CaptureKind::Error,
        session_id,
        app_type,
        provider_id,
        model,
        Some(status),
        false,
        body,
    );
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
            record_request("s", "claude", "p", "m", &json!({"a": 1}));
            assert!(snapshot().is_empty(), "关闭态不应产生任何捕获");

            set_enabled(true);
            record_request(
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
    fn error_body_captured_with_status() {
        with_isolated_buffer(|| {
            set_enabled(true);
            record_error(
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
}
