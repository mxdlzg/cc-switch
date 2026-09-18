//! 请求重放器：把抓取到的某一条出站请求按节奏自动重发，成功即系统通知
//!
//! 场景：部分供应商有并发席位上限（几百人抢几十席，抢不到的一律 500）。席位释放的
//! 瞬间，恰好在发请求的人才能拿到。人工在 Codex 里反复重发、人不能离开；本模块替用户
//! 做这件事：从请求查看器选一条请求 → 按固定间隔或指数退避重发 → 连续成功 N 次后停止
//! 并弹系统通知，人可以去干别的。
//!
//! 三条设计铁律：
//! - **冻结快照**：只读 [`debug_capture`] 里那份「method + 最终 URL + 最终头集合
//!   （含鉴权）+ body 字节」四元组，原样重发。**不回读 provider 表、不跟随接管开关、
//!   不受首页切换影响**——用户可以一边重打被限流的上游，一边切到别的 provider 正常用。
//!   代价：快照之后轮换密钥会让重放持续 401（属不可重试，立即停），重新抓一条即可。
//! - **不进转发管线**：直接打快照里的 URL，因此不写 `proxy_request_logs`、不发
//!   `usage-log-recorded`、不碰 Live 配置文件——不计费、不搅仪表盘（UI 已注明）。
//! - **不阻塞**：状态更新全在锁外算好再写；间隔等待用 `tokio::select!` 同时监听取消，
//!   停止按钮在间隔期内也能立刻生效。
//!
//! 与抓取同源的安全边界：纯内存、不落盘、重启即清空；快照只在用户显式点「重放」时经
//! 命令离开后端，密钥不进前端（进度里只暴露目标 URL 的 origin）。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::task::JoinHandle;

use super::debug_capture::{self, RequestSnapshot};

/// 前端监听的重放进度事件名。
pub const EVENT_REPLAY_PROGRESS: &str = "replay-progress";

/// 单次重放请求的超时（**到拿到响应头为止**）。上游排队时可能挂很久，120s 足够。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// 终态那次成功读取响应正文的总时长兜底。SSE 生成可能跑几分钟，兜底到 5 分钟；
/// 超时则把已收到的部分存下来，通知照发。
const READ_DEADLINE: Duration = Duration::from_secs(300);

/// 重放响应的读取上限（字节）。成功响应要存进查看器供回看，但不能无界。
const MAX_REPLAY_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// 取消标志的轮询步长。tokio-util 的 CancellationToken 不是本项目依赖，这里手写
/// 轮询 future；100ms 相对「间隔至少 1 秒」的退避节奏占空比极低，响应又足够快。
const CANCEL_POLL: Duration = Duration::from_millis(100);

/// 节奏模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PaceMode {
    /// 固定间隔
    Fixed,
    /// 指数退避（起 × 倍，封顶）
    Backoff,
}

/// 任务状态。运行中为 `Running`，其余为终态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplayState {
    Running,
    /// 达到所需连续成功次数
    Succeeded,
    /// 命中不可重试错误（401/403/400 等）
    Failed,
    /// 撞上最大次数或最长时长
    Capped,
    /// 用户手动停止
    Stopped,
}

/// 已校验的重放配置（数值区间在命令层校验，见 `commands::replay`）。
#[derive(Debug, Clone)]
pub struct ReplayConfig {
    pub mode: PaceMode,
    /// 固定间隔秒数（`Fixed` 用）
    pub interval_secs: u64,
    /// 退避起始秒数（`Backoff` 用）
    pub backoff_start_secs: u64,
    /// 退避倍数，百分比整数（200 = ×2）。用整数避免前端传浮点。
    pub backoff_mult_percent: u32,
    /// 退避封顶秒数
    pub backoff_cap_secs: u64,
    /// 需要连续成功几次才算成
    pub required_consecutive: u32,
    /// 可重试状态码集合，默认 `{500}`
    pub retryable_statuses: Vec<u16>,
    /// 最大尝试次数
    pub max_attempts: u32,
    /// 最长时长（分钟）
    pub max_duration_minutes: u64,
}

impl ReplayConfig {
    /// 第 `attempt` 次尝试（从 1 开始）之后要等多久。纯函数，便于单测。
    pub fn delay_after(&self, attempt: u32) -> Duration {
        match self.mode {
            PaceMode::Fixed => Duration::from_secs(self.interval_secs),
            PaceMode::Backoff => {
                // 倍数下限 100%：小于 1 会让等待越来越短，与「退避」相反。
                let mult = self.backoff_mult_percent.max(100) as f64 / 100.0;
                let cap = self.backoff_cap_secs.max(1) as f64;
                let mut secs = self.backoff_start_secs.max(1) as f64;
                // 逐次累乘并提前跳出，而不是 powf：大 attempt 下 powf 会溢出成 inf。
                for _ in 1..attempt {
                    secs *= mult;
                    if secs >= cap {
                        secs = cap;
                        break;
                    }
                }
                Duration::from_secs(secs.min(cap) as u64)
            }
        }
    }
}

/// 一条重放进度（emit 给前端，同时是 `get_replay_status` 的返回体）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayStatus {
    pub state: ReplayState,
    /// 目标 URL 的 **origin**（不含 path——path 可能内嵌密钥）
    pub target_origin: String,
    pub method: String,
    pub mode: PaceMode,
    /// 已尝试次数
    pub attempts: u32,
    /// 当前连续成功次数
    pub consecutive: u32,
    pub required_consecutive: u32,
    /// 最近一次 HTTP 状态（网络错误时为 None）
    pub last_status: Option<u16>,
    /// 最近一次错误摘要（不含鉴权信息）
    pub last_error: Option<String>,
    /// 开始时刻（Unix 毫秒）
    pub started_at_ms: i64,
    /// 已耗时（毫秒）
    pub elapsed_ms: u64,
}

/// 终止原因 → 状态 + 通知文案。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Succeeded,
    Failed,
    Capped,
    Stopped,
}

impl Outcome {
    fn state(self) -> ReplayState {
        match self {
            Outcome::Succeeded => ReplayState::Succeeded,
            Outcome::Failed => ReplayState::Failed,
            Outcome::Capped => ReplayState::Capped,
            Outcome::Stopped => ReplayState::Stopped,
        }
    }

    /// 通知文案：中英拼一行。刻意不把 i18n JSON 拖进 Rust（tray 有 TrayTexts 那套，
    /// 但系统通知就一行字，双语并列足够认）。
    fn texts(self, attempts: u32) -> (&'static str, String) {
        match self {
            Outcome::Succeeded => (
                "重放成功 / Replay succeeded",
                format!(
                    "第 {attempts} 次拿到席位；响应见请求查看器。Got a seat on attempt {attempts} — see the capture viewer."
                ),
            ),
            Outcome::Failed => (
                "重放已停止 / Replay stopped",
                format!(
                    "第 {attempts} 次命中不可重试错误。Non-retryable error on attempt {attempts}."
                ),
            ),
            Outcome::Capped => (
                "重放到上限 / Replay hit the limit",
                format!(
                    "共 {attempts} 次，达到最大次数或时长上限。Stopped at the attempt/duration cap after {attempts}."
                ),
            ),
            Outcome::Stopped => (
                "重放已停止 / Replay stopped",
                format!("手动停止，共 {attempts} 次。Stopped manually after {attempts}."),
            ),
        }
    }
}

/// 重放时要剔除的头：逐跳头 + 必须由客户端重算的头 + Host。
///
/// 快照存的是「发给上游那一刻」的头集合，其中 Content-Length 是当时由转发层算出的；
/// 原样带上会与 body 字节或 reqwest 自己算的值打架。Host 交给 reqwest 按 URL 生成，
/// 避免快照里的 host 与目标 URL 不一致。鉴权头**不在**此列表——冻结语义要求原样保留。
fn is_dropped_on_replay(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "content-length"
            | "transfer-encoding"
            | "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "upgrade"
            | "host"
    )
}

/// 状态码是否可重试。只有明确列出的才重试——未列出的 5xx（502/503）往往是上游真
/// 挂了，继续打只是白等；用户明确要求「默认只有 500 可重试」。
fn status_retryable(status: u16, retryable: &[u16]) -> bool {
    retryable.contains(&status)
}

/// 运行中的任务句柄 + 最近一次进度。
struct RunningReplay {
    /// 任务标识：写状态/emit/通知前对账，避免被用户停止后立刻新起任务时旧任务串写。
    id: u64,
    handle: JoinHandle<()>,
    cancel: Arc<AtomicBool>,
    status: ReplayStatus,
}

/// 全局单任务槽（抢席位场景一个就够；单任务也让「停止」语义保持简单）。
static REPLAY: OnceLock<Mutex<Option<RunningReplay>>> = OnceLock::new();

/// 任务 id 发号器。
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn slot() -> &'static Mutex<Option<RunningReplay>> {
    REPLAY.get_or_init(|| Mutex::new(None))
}

/// 槽位里这条是否还占着「运行中」：已终态的残留只是给面板显示上一次结果，
/// 不阻塞新任务启动。
fn is_busy(entry: &RunningReplay) -> bool {
    entry.status.state == ReplayState::Running && !entry.cancel.load(Ordering::Acquire)
}

/// 启动重放。已有运行中的任务时返回 Err（免得误起两个抢同一席位）。
pub fn start(app: &AppHandle, seq: u64, config: ReplayConfig) -> Result<ReplayStatus, String> {
    let snap = debug_capture::get_snapshot(seq).ok_or_else(|| {
        "该请求没有可重放的快照：可能是抓取功能开启前的旧数据，或请求体过大被跳过".to_string()
    })?;

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let cancel = Arc::new(AtomicBool::new(false));
    let started = Instant::now();
    let required = config.required_consecutive.max(1);
    let status = ReplayStatus {
        state: ReplayState::Running,
        // 只暴露 origin：快照 URL 的 path 可能内嵌 key（形如 https://gw/<KEY>/v1）
        target_origin: crate::redact_url_origin_for_log(&snap.url),
        method: snap.method.clone(),
        mode: config.mode,
        attempts: 0,
        consecutive: 0,
        required_consecutive: required,
        last_status: None,
        last_error: None,
        started_at_ms: now_ms(),
        elapsed_ms: 0,
    };

    let initial = status.clone();
    let target_for_log = initial.target_origin.clone();

    {
        let mut guard = lock_slot();
        if let Some(entry) = guard.as_ref() {
            if is_busy(entry) {
                return Err("已有重放任务在运行，请先停止它".to_string());
            }
        }
        // 顶替上一轮：终态残留的任务已自行结束；「按了停止但还没落终态」的任务则
        // 直接 abort——用户紧接着起新任务，说明旧任务没必要再跑完这一轮。
        if let Some(stale) = guard.take() {
            stale.handle.abort();
        }
        let task_cancel = cancel.clone();
        let app_clone = app.clone();
        let run_status = status.clone();
        *guard = Some(RunningReplay {
            id,
            // 用 tauri::async_runtime::spawn 而非 tokio::spawn：同步 #[tauri::command]
            // 跑在 Tauri 自己的线程池上，那里没有 tokio 运行时句柄，tokio::spawn 会 panic。
            handle: tauri::async_runtime::spawn(run(
                app_clone,
                id,
                snap,
                config,
                task_cancel,
                started,
                run_status,
            )),
            cancel,
            status,
        });
    }

    log::info!("[Replay] 已启动重放: seq={seq} target={target_for_log}");
    Ok(initial)
}

/// 当前状态（从未启动过重放时 None）。
pub fn status() -> Option<ReplayStatus> {
    lock_slot().as_ref().map(|e| e.status.clone())
}

/// 请求停止。**不在此处 join**：命令线程 await tokio 任务有死锁风险且没必要——
/// 任务自己在下一轮 select 里退出并写终态（含「已停止」通知）。
pub fn stop() -> Option<ReplayStatus> {
    let guard = lock_slot();
    let entry = guard.as_ref()?;
    entry.cancel.store(true, Ordering::Release);
    Some(entry.status.clone())
}

/// 应用退出时无需清理：状态纯内存，退出路径走 `std::process::exit(0)`，
/// tokio 运行时随进程一起没。刻意不提供 abort()——它没有能跑完的时机。
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn lock_slot() -> std::sync::MutexGuard<'static, Option<RunningReplay>> {
    match slot().lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// 重放主循环。跑在 `tauri::async_runtime::spawn` 出来的任务里，自行结束。
async fn run(
    app: AppHandle,
    id: u64,
    snap: RequestSnapshot,
    config: ReplayConfig,
    cancel: Arc<AtomicBool>,
    started: Instant,
    mut status: ReplayStatus,
) {
    let max_attempts = config.max_attempts.max(1);
    let max_duration = Duration::from_secs(config.max_duration_minutes.max(1) * 60);
    let required = config.required_consecutive.max(1);
    let client = super::http_client::get();

    let outcome = loop {
        if cancel.load(Ordering::Acquire) {
            break Outcome::Stopped;
        }
        if status.attempts >= max_attempts || started.elapsed() >= max_duration {
            break Outcome::Capped;
        }

        status.attempts += 1;
        let attempt = status.attempts;

        match send_replay(&client, &snap).await {
            Ok((code, resp)) if (200..300).contains(&code) => {
                status.last_status = Some(code);
                status.last_error = None;
                status.consecutive += 1;
                log::info!("[Replay] 第 {attempt} 次成功: HTTP {code}");
                if status.consecutive >= required {
                    // 只存「终结这一轮的那次响应」：非终态的成功走下面的臂，用 `_`
                    // 丢掉 Response（即断流）——没人在消费 body，留着只会把几 MB 的
                    // 生成结果在内存里堆好几份，还要等整条流跑完才能进下一轮。
                    store_replay_response(resp, &snap, code).await;
                    break Outcome::Succeeded;
                }
            }
            Ok((code, _)) if status_retryable(code, &config.retryable_statuses) => {
                status.last_status = Some(code);
                status.last_error = None;
                status.consecutive = 0;
                log::debug!("[Replay] 第 {attempt} 次 HTTP {code}（可重试），继续等席位");
            }
            Ok((code, _)) => {
                status.last_status = Some(code);
                status.consecutive = 0;
                log::warn!("[Replay] 第 {attempt} 次 HTTP {code} 不可重试，停止");
                break Outcome::Failed;
            }
            // 网络错误 / 超时按可重试：抢席位期间上游连接本就可能抖。
            Err(msg) => {
                status.last_status = None;
                status.last_error = Some(truncate_error(&msg));
                status.consecutive = 0;
                log::debug!("[Replay] 第 {attempt} 次网络错误（可重试）: {msg}");
            }
        }
        status.elapsed_ms = started.elapsed().as_millis() as u64;

        if !publish(&app, id, &status) {
            // 槽位已被新任务顶替 → 本任务作废，不再写状态/发通知。
            return;
        }

        let delay = config.delay_after(attempt);
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = wait_cancel(&cancel) => break Outcome::Stopped,
        }
    };

    status.state = outcome.state();
    status.elapsed_ms = started.elapsed().as_millis() as u64;
    if !publish(&app, id, &status) {
        return;
    }
    let (title, body) = outcome.texts(status.attempts);
    notify(&app, title, &body);
    log::info!(
        "[Replay] 已结束: {:?}（共 {} 次）",
        outcome.state(),
        status.attempts
    );
}

/// 发出一次重放，返回 (HTTP 状态, 响应)。响应**未读**，由调用方决定读还是丢。
///
/// 刻意不在这里读 body：只有「终结本轮的那次成功」值得读完整条流（可能是几分钟的
/// SSE），其余情形直接 drop 更省内存也更快进入下一轮。
async fn send_replay(
    client: &reqwest::Client,
    snap: &RequestSnapshot,
) -> Result<(u16, reqwest::Response), String> {
    let method = reqwest::Method::from_bytes(snap.method.as_bytes())
        .map_err(|e| format!("快照里的 method 无法解析: {e}"))?;

    let mut request = client.request(method.clone(), &snap.url);
    // 与转发层同语义：GET/HEAD 不带 body（部分上游会拒）。
    if !matches!(method, reqwest::Method::GET | reqwest::Method::HEAD) {
        request = request.body(snap.body.clone());
    }
    for (name, value) in &snap.headers {
        if is_dropped_on_replay(name) {
            continue;
        }
        request = request.header(name.as_str(), value.as_str());
    }

    // 这个超时只覆盖「拿到响应头」——正是席位是否让出来的信号，不该被后续生成时长拖住。
    let resp = tokio::time::timeout(REQUEST_TIMEOUT, request.send())
        .await
        .map_err(|_| format!("请求超时（{}s）", REQUEST_TIMEOUT.as_secs()))?
        .map_err(reqwest_error)?;

    let status = resp.status().as_u16();
    Ok((status, resp))
}

/// 把终结本轮的成功响应读出来存进查看器。
///
/// 错误响应不读：它对抢席位没有参考价值（常常是一整页 HTML），而且查看器里已经有
/// 原请求的错误条目可比对。读取有总时长兜底——上游挂住一条永不结束的 SSE 时，
/// 通知不该被无限期推迟。
async fn store_replay_response(mut resp: reqwest::Response, snap: &RequestSnapshot, status: u16) {
    let bytes = tokio::time::timeout(READ_DEADLINE, async {
        let mut out: Vec<u8> = Vec::new();
        loop {
            match resp.chunk().await {
                Ok(Some(chunk)) => {
                    if out.len() + chunk.len() > MAX_REPLAY_RESPONSE_BYTES {
                        let room = MAX_REPLAY_RESPONSE_BYTES.saturating_sub(out.len());
                        out.extend_from_slice(&chunk[..room]);
                        break;
                    }
                    out.extend_from_slice(&chunk);
                }
                // 读错误或提前结束：已有部分照存，通知不该因为正文读崩了就发不出去。
                _ => break,
            }
        }
        out
    })
    .await
    .unwrap_or_else(|_| Vec::new());

    debug_capture::record_replay_response(
        &snap.session_id,
        &snap.app_type,
        &snap.provider_id,
        &snap.model,
        status,
        &bytes,
    );
}

fn reqwest_error(e: reqwest::Error) -> String {
    if let Some(code) = e.status() {
        return format!("HTTP {}: {e}", code.as_u16());
    }
    if e.is_timeout() {
        return "连接超时".to_string();
    }
    format!("网络错误: {e}")
}

/// 错误摘要封顶，避免一整页 HTML 错误灌进事件里。
fn truncate_error(msg: &str) -> String {
    const CAP: usize = 300;
    let count = msg.chars().count();
    if count <= CAP {
        return msg.to_string();
    }
    let kept: String = msg.chars().take(CAP).collect();
    format!("{kept}…")
}

/// 写全局状态并 emit。返回 false 表示槽位里已不是本任务（被新任务顶替），调用方该退出。
fn publish(app: &AppHandle, id: u64, status: &ReplayStatus) -> bool {
    {
        let mut guard = lock_slot();
        match guard.as_mut() {
            Some(entry) if entry.id == id => entry.status = status.clone(),
            // 槽位空了（应用退出）或换成了新任务 → 本任务作废。
            _ => return false,
        }
    }
    // emit 放在锁外：事件会走前端命令，前端可能在回调里查状态，持锁 emit 有重入风险。
    if let Err(e) = app.emit(EVENT_REPLAY_PROGRESS, status) {
        log::debug!("[Replay] emit {EVENT_REPLAY_PROGRESS} 失败: {e}");
    }
    true
}

/// 轮询取消标志的 future（`wait_cancel` 直到置位）。
async fn wait_cancel(flag: &Arc<AtomicBool>) {
    while !flag.load(Ordering::Acquire) {
        tokio::time::sleep(CANCEL_POLL).await;
    }
}

/// 系统通知。Windows 上走原生 toast；前端不调 notification API，因此无需
/// capability 授权（Rust 侧经插件直接发）。
fn notify(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    if let Err(e) = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .finish()
    {
        log::warn!("[Replay] 系统通知发送失败: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(mode: PaceMode) -> ReplayConfig {
        ReplayConfig {
            mode,
            interval_secs: 3,
            backoff_start_secs: 2,
            backoff_mult_percent: 200,
            backoff_cap_secs: 30,
            required_consecutive: 1,
            retryable_statuses: vec![500],
            max_attempts: 500,
            max_duration_minutes: 60,
        }
    }

    #[test]
    fn fixed_pace_ignores_attempt() {
        let c = cfg(PaceMode::Fixed);
        assert_eq!(c.delay_after(1), Duration::from_secs(3));
        assert_eq!(c.delay_after(99), Duration::from_secs(3));
    }

    #[test]
    fn backoff_grows_then_caps() {
        let c = cfg(PaceMode::Backoff);
        assert_eq!(c.delay_after(1), Duration::from_secs(2));
        assert_eq!(c.delay_after(2), Duration::from_secs(4));
        assert_eq!(c.delay_after(3), Duration::from_secs(8));
        assert_eq!(c.delay_after(4), Duration::from_secs(16));
        assert_eq!(c.delay_after(5), Duration::from_secs(30), "封顶后不再增长");
        assert_eq!(
            c.delay_after(10_000),
            Duration::from_secs(30),
            "超大 attempt 不能溢出成 inf"
        );
    }

    #[test]
    fn backoff_clamps_degenerate_multiplier() {
        let mut c = cfg(PaceMode::Backoff);
        c.backoff_mult_percent = 50; // <100% 会让等待越来越短，与退避相反
        assert_eq!(c.delay_after(1), Duration::from_secs(2));
        assert_eq!(c.delay_after(2), Duration::from_secs(2), "倍数被夹到 100%");
    }

    #[test]
    fn only_listed_statuses_are_retryable() {
        let retryable = [500u16];
        assert!(status_retryable(500, &retryable));
        assert!(
            !status_retryable(502, &retryable),
            "未列出的 5xx 默认不重试"
        );
        assert!(!status_retryable(401, &retryable));
        assert!(status_retryable(503, &[500, 503]));
        assert!(!status_retryable(500, &[]), "空集合 = 一切都不重试");
    }

    #[test]
    fn replay_drops_hop_by_hop_but_keeps_auth() {
        assert!(is_dropped_on_replay("Content-Length"));
        assert!(is_dropped_on_replay("connection"));
        assert!(is_dropped_on_replay("HOST"));
        assert!(is_dropped_on_replay("Transfer-Encoding"));
        assert!(
            !is_dropped_on_replay("authorization"),
            "鉴权头必须保留（冻结语义的核心）"
        );
        assert!(!is_dropped_on_replay("content-type"));
        assert!(!is_dropped_on_replay("anthropic-version"));
    }

    #[test]
    fn error_summary_is_capped() {
        let out = truncate_error(&"x".repeat(1000));
        assert!(out.chars().count() <= 301);
        assert!(out.ends_with('…'));
        assert_eq!(truncate_error("short"), "short");
    }

    #[test]
    fn outcome_maps_to_state_and_has_text() {
        assert_eq!(Outcome::Succeeded.state(), ReplayState::Succeeded);
        assert_eq!(Outcome::Failed.state(), ReplayState::Failed);
        assert_eq!(Outcome::Capped.state(), ReplayState::Capped);
        assert_eq!(Outcome::Stopped.state(), ReplayState::Stopped);
        for outcome in [
            Outcome::Succeeded,
            Outcome::Failed,
            Outcome::Capped,
            Outcome::Stopped,
        ] {
            let (title, body) = outcome.texts(7);
            assert!(title.contains('/'), "通知标题应中英双语");
            assert!(body.contains('7'), "通知正文应带上尝试次数");
        }
    }
}
