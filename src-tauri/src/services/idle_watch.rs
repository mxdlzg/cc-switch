//! 渠道静默监控（Idle Watch）后台引擎
//!
//! 每 [`TICK_SECS`] 醒一次，对每条规则算两件事之一（按规则的 `notify_on` 选）：
//! - **静默**（`Silence`）：该渠道距今多久没有**成功**请求，到点就发系统通知。
//! - **恢复**（`Recovery`）：静默先满阈值、随后到来的第一条成功请求 → 报「回来了」。
//!
//! 可选顺手打一次真实认证的 `GET /models` 把渠道触碰一下（只属于静默那一头）。
//!
//! 四条设计约束，都是会踩的坑：
//!
//! 1. **计时基线取 `max(最近成功, 规则建立时刻)`**。新建规则时不能拿历史最后成功
//!    当基线——给一个已经静默一个月的渠道加常开规则，下一个 tick 就会弹「你很久
//!    没用了」，而用户其实刚设完规则。规则因此带 `created_at_sec`。恢复那一头的
//!    静默起点用同一条公式，两条方向的「静默了多久」才对得上。
//! 2. **提醒节奏用整除计数**（`due = idle_sec / threshold_sec`），不记「上次提醒
//!    时刻」。前者天然对齐阈值刻度：静默 2.5 个阈值只补一条（不追补欠账）；一旦
//!    来了成功请求，`due` 变小 → 计数被拉回真实刻度，不需要额外的状态迁移。
//! 3. **已提醒次数与上一轮最近成功时刻只存内存**，不落盘。前者重启后若渠道仍静默
//!    会立刻再提醒一次——比丢状态更难解释的是「重启后突然不提醒了」；后者重启后
//!    第一轮只播种，最坏是漏一次恢复通知，而不是重启就弹一条假的。
//! 4. **恢复靠「最近成功时刻前移」判定，不记事件游标**。`MAX(created_at)` 只会因
//!    真正的新成功而变大（日志滚存删除只会让它变小或变 None），所以前移即新成功，
//!    不需要额外的去重状态。首轮必须只播种，否则启动即误报。
//!
//! 与其它子系统保持同样的独立性：不写 `proxy_request_logs`、不计费、不搅仪表盘、
//! 不碰任何 CLI live 配置。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::database::Database;
use crate::database::{IdleWatchConfig, IdleWatchMode, IdleWatchNotifyOn, IdleWatchRule};

/// 轮询间隔（秒）。阈值最小 1 分钟，60 秒的 tick 足够贴合，又不会让 SQL 常驻。
const TICK_SECS: u64 = 60;

/// 保活请求的整体超时（秒）。`fetch_models` 自带 15s 单请求超时，这里兜住
/// 「候选 URL 逐个试」的总时长，免得一个挂住的上游把整轮 tick 拖长。
const KEEPALIVE_TIMEOUT_SECS: u64 = 50;

/// 事件名：前端面板若在则据此 toast + 刷新（系统通知由本模块发，不依赖前端挂载）。
pub const EVENT_IDLE_WATCH_ALERT: &str = "idle-watch-alert";

/// 一条规则的评估结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// 还没到点（或基线刚被新成功请求推后）
    Waiting,
    /// 该提醒一次。`fired_count` 是提醒后应写入内存计数表的新值。
    Fire { fired_count: u32 },
}

/// 提醒是哪一头触发的。决定通知正文怎么说。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IdleWatchAlertKind {
    /// 「已经多久没有成功请求」
    Silence,
    /// 「静默多久之后终于又来了一条成功请求」
    Recovery,
}

/// 纯函数：这条规则现在该不该提醒。
///
/// 拆出来只为可测——阈值边界、Once/Always 分岔集中在这里，不碰 DB 也不碰时钟。
/// `idle_sec` 已由调用方按 `max(最近成功, created_at_sec)` 算好。
pub fn decide(rule: &IdleWatchRule, idle_sec: i64, fired_count: u32) -> Decision {
    // 负 idle_sec 只可能来自时钟回拨或配置里的未来时间；当成 0（等待），不 panic。
    if idle_sec < 0 {
        return Decision::Waiting;
    }
    let due = (idle_sec / rule.threshold_sec()) as u64;

    match rule.mode {
        // 常开：每跨过一个阈值刻度补一条，一次最多一条（不追补欠账）。
        // 有新成功请求 → due 变小甚至归 0 → 条件不成立；计数由调用方拉回 due。
        IdleWatchMode::Always => {
            if due > fired_count as u64 {
                Decision::Fire {
                    fired_count: due as u32,
                }
            } else {
                Decision::Waiting
            }
        }
        // 一次性：跨过第一个刻度就触发，随后规则由调用方删除。
        IdleWatchMode::Once => {
            if due >= 1 {
                Decision::Fire {
                    fired_count: fired_count + 1,
                }
            } else {
                Decision::Waiting
            }
        }
    }
}

/// 纯函数：静默之后的那次成功，值不值得报一句「回来了」。
///
/// 恢复的本质是「最近成功时刻相比上一轮**前移了**，且前移之前那段静默已满阈值」。
/// 与 `decide()` 一样拆成纯函数只为可测，不碰 DB 也不碰时钟。
///
/// `prev_last` 有两层，别把它们压成一层：
/// - 外层 `None`：本进程还没为这条规则跑过一轮（启动后的首轮）→ **只播种不报**。
///   否则启动那一刻会把日志里的历史 200 当成「刚恢复」，给一个从没挂过的渠道弹通知。
/// - 内层 `None`：跑过若干轮，但期间该渠道没有任何成功记录 → 静默起点只能退到规则
///   建立时刻（见下面的基线夹取）。少了这层，「设完规则后一直没流量、终于来了个
///   200」恰恰会漏报，而那正是用户最想收到的一条。
///
/// `observed_last` = 本轮聚合出的最近成功时刻；`None` = 没有成功可报。
///
/// 返回 `Some(gap_sec)` = 该报恢复，`gap_sec` 即那次成功之前的静默时长（正文里说成
/// 「静默 3 小时 30 分后恢复」）。
///
/// ⚠️ 日志滚存（`dao::usage_rollup` 删超出保留期的行）**不会**造成假恢复：删除只会让
/// `MAX(created_at)` 变小或变 `None`，不可能变大——若存在更晚的成功行，它本来就已经是
/// MAX 了。所以 `observed > 起点` 只能由真正的新成功引起。
pub fn decide_recovery(
    rule: &IdleWatchRule,
    prev_last: Option<Option<i64>>,
    observed_last: Option<i64>,
) -> Option<i64> {
    // 首轮只播种。注意这一行必须排在取 observed 之前：两者都缺时也不该报。
    let Some(seed) = prev_last else {
        return None;
    };
    let observed = observed_last?;
    // 基线要夹到 `created_at_sec`，理由与静默计时完全一样（模块头约束 1），但这里多
    // 一个只在恢复方向才出现的坑：内存表按**渠道**存，删掉一条规则再加一条同渠道的
    // 新规则，读到的是**上一条规则**留下的播种值。不夹住的话，一个天天正常用的渠道
    // 会在你点完「添加」的下一个 tick 收到一条「静默 3 天后恢复成功请求」——那段静默
    // 是旧播种值与新成功之间的距离，用户刚设完规则，什么都没发生。
    let baseline = seed.unwrap_or(i64::MIN).max(rule.created_at_sec);
    // 没前移就不报：原地不动是没有新成功，退步是日志被滚存删过 / 时钟回拨。
    let gap = observed.checked_sub(baseline)?;
    if gap >= rule.threshold_sec() {
        Some(gap)
    } else {
        None
    }
}

/// 保活结果。随事件发给前端（措辞由前端决定），通知正文里则由本模块直接拼双语。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KeepaliveOutcome {
    /// 保活开关没开 → 未尝试
    Skipped,
    /// 静态 key 可用，`GET /models` 返回 2xx
    Ok,
    /// 该鉴权方式需要动态 token（ClaudeAuth / Bearer / 各家 OAuth），无法静态保活
    Unsupported,
    /// 尝试了但失败（网络 / 4xx / 5xx / 超时）
    Failed,
}

/// 面板用的单渠道状态行：活动 + 该渠道上的规则，一张表里说清。
///
/// 放在 services 层而不是 commands 层：它同时是命令层的返回值形状与后台循环的
/// 判定中间态，而 commands 反过来依赖 services（本仓库有测试守着「services 不得
/// 依赖 commands」这条方向）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelIdleStatus {
    pub app_type: String,
    pub provider_id: String,
    pub provider_name: String,
    /// 最近一次 2xx 时刻（Unix 秒）；None = 日志里没有成功记录
    pub last_success_at: Option<i64>,
    pub success_count: i64,
    pub request_count: i64,
    /// 已静默秒数，按引擎同款基线（`max(最近成功, 规则建立时刻)`）算。
    /// 无任何日志也无规则时为 None（没有可度量的起点）。
    pub idle_sec: Option<i64>,
    /// 该渠道上的规则（None = 未监控）
    pub mode: Option<IdleWatchMode>,
    pub threshold_minutes: Option<u64>,
    /// 该规则的提醒方向（None = 未监控）
    pub notify_on: Option<IdleWatchNotifyOn>,
}

/// 一条提醒的负载（前端面板据此 toast + 重取状态表）。不含密钥，纯展示信息。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleWatchAlert {
    pub app_type: String,
    pub provider_id: String,
    pub provider_name: String,
    pub mode: IdleWatchMode,
    /// 哪一头触发的：`Silence` 的 `idle_sec` 是「至今静默」，`Recovery` 的是
    /// 「那次成功之前的静默」。正文措辞据此分岔。
    pub kind: IdleWatchAlertKind,
    pub threshold_minutes: u64,
    /// 提醒时刻该渠道已静默多少秒
    pub idle_sec: i64,
    pub keepalive: KeepaliveOutcome,
    /// 保活失败/不支持的原因摘要（`Ok` / `Skipped` 时为 None）
    pub keepalive_error: Option<String>,
}

/// 内存里的「已提醒次数」表，键 = `rule.key()`。不落盘的理由见模块头。
static FIRED: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);

fn get_fired(key: &str) -> u32 {
    let guard = FIRED.lock().unwrap_or_else(|p| p.into_inner());
    match guard.as_ref() {
        Some(map) => map.get(key).copied().unwrap_or(0),
        None => 0,
    }
}

fn set_fired(key: &str, count: u32) {
    let mut guard = FIRED.lock().unwrap_or_else(|p| p.into_inner());
    guard
        .get_or_insert_with(HashMap::new)
        .insert(key.to_string(), count);
}

/// 规则删除时一并清掉计数，免得表随历史规则无界增长。
fn drop_fired(keys: &[String]) {
    if keys.is_empty() {
        return;
    }
    let mut guard = FIRED.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(map) = guard.as_mut() {
        for key in keys {
            map.remove(key);
        }
    }
}

/// 内存里的「上一轮最近成功时刻」表，键 = `rule.key()`。恢复提醒靠它判断前移。
///
/// 值刻意是 `Option<i64>`：「跑过但当时没有成功记录」（`Some(None)`）与「从没跑过」
/// （`None`，键不在表里）是两种不同处境，前者要把静默起点退到 `created_at_sec`，
/// 后者只能播种。压成一个 `Option<i64>` 会把前者误当成后者，于是漏掉最该报的那条。
///
/// 与 `FIRED` 同样只存内存、不落盘：重启后第一轮只播种，最坏是漏一次恢复通知，
/// 而不是重启就弹一条假的。
static PREV_SUCCESS: Mutex<Option<HashMap<String, Option<i64>>>> = Mutex::new(None);

/// 取上一轮的最近成功时刻。返回 `None` = 键不在表里（本进程还没跑过这条规则）。
fn get_prev_success(key: &str) -> Option<Option<i64>> {
    let guard = PREV_SUCCESS.lock().unwrap_or_else(|p| p.into_inner());
    guard.as_ref()?.get(key).copied()
}

fn set_prev_success(key: &str, last: Option<i64>) {
    let mut guard = PREV_SUCCESS.lock().unwrap_or_else(|p| p.into_inner());
    guard
        .get_or_insert_with(HashMap::new)
        .insert(key.to_string(), last);
}

fn drop_prev_success(keys: &[String]) {
    if keys.is_empty() {
        return;
    }
    let mut guard = PREV_SUCCESS.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(map) = guard.as_mut() {
        for key in keys {
            map.remove(key);
        }
    }
}

/// 拉起后台循环。`lib.rs` 在 s3 / webdav 之后调一次。
pub fn start_worker(db: Arc<Database>, app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        log::info!("[IdleWatch] 渠道静默监控已启动（tick={TICK_SECS}s）");
        let mut ticker = tokio::time::interval(Duration::from_secs(TICK_SECS));
        // 首个 tick 立即返回 → 启动即评估一次。已到期规则（昨天设的一次性规则、
        // 或重启前就静默的常开渠道）应当在打开应用时就提醒，而不是再等一分钟。
        loop {
            ticker.tick().await;
            if let Err(e) = run_tick(&db, &app).await {
                // 单轮失败不终止循环：配置坏了 / DB 忙都不该让监控静默消失。
                log::warn!("[IdleWatch] 本轮检查失败: {e}");
            }
        }
    });
}

/// 一轮检查。抽出来是为了让错误路径统一（`?` + 调用处单行日志）。
async fn run_tick(db: &Arc<Database>, app: &AppHandle) -> Result<(), String> {
    // rusqlite 是同步的：读写一律走 spawn_blocking，别卡 async 运行时。
    let config = {
        let db = db.clone();
        tauri::async_runtime::spawn_blocking(move || db.get_idle_watch_config())
            .await
            .map_err(|e| format!("读取配置失败: {e}"))?
            .map_err(|e| e.to_string())?
    };

    if !config.enabled || config.rules.is_empty() {
        return Ok(());
    }

    // 一次 GROUP BY 拿到全部渠道的成功活动，规则按 key 命中；比每规则一条 SQL 划算。
    let activity = {
        let db = db.clone();
        tauri::async_runtime::spawn_blocking(move || db.list_channel_idle_activity())
            .await
            .map_err(|e| format!("读取渠道活动失败: {e}"))?
            .map_err(|e| e.to_string())?
    };
    let mut last_success: HashMap<String, Option<i64>> = HashMap::new();
    for row in &activity {
        // 保留 None（= 日志里没成功记录）而不是压成 i64::MIN：静默基线那里 MIN 与
        // None 等价（都会被 max 落到 created_at_sec 上），但恢复判定必须分清
        // 「本轮没有成功」与「本轮成功在 t」。
        last_success.insert(
            format!("{}|{}", row.app_type, row.provider_id),
            row.last_success_at,
        );
    }

    // 供应商名（通知要显示）同时充当「渠道还在不在」的判据。
    let names = {
        let db = db.clone();
        let rules = config.rules.clone();
        tauri::async_runtime::spawn_blocking(move || resolve_provider_names(&db, &rules))
            .await
            .map_err(|e| format!("读取供应商名称失败: {e}"))?
    };

    let now_sec = chrono::Utc::now().timestamp();
    let mut alerts: Vec<IdleWatchAlert> = Vec::new();
    let mut survivors: Vec<IdleWatchRule> = Vec::new();
    let mut removed_keys: Vec<String> = Vec::new();

    for rule in config.rules.clone() {
        let key = rule.key();
        let Some(provider_name) = names.get(&key).cloned() else {
            // 供应商已删 → 规则失去对象。静默丢弃、不通知（没有可提醒的渠道了）。
            log::info!("[IdleWatch] 渠道已不存在，丢弃规则: {key}");
            removed_keys.push(key);
            continue;
        };

        // 基线 = max(最近成功, 规则建立时刻)。见模块头约束 1。「日志里有但无成功记录」
        // 与「日志里根本没有」在这里等价：都退到 created_at_sec。
        let observed_last = last_success.get(&key).copied().flatten();
        let baseline = observed_last.unwrap_or(i64::MIN).max(rule.created_at_sec);
        let idle_sec = now_sec.saturating_sub(baseline);
        let fired_count = get_fired(&key);
        // 本轮的最近成功时刻要无条件播种给下一轮，包括「渠道已删 / 规则被删」以外的
        // 每一条路径——否则下一轮看到的还是 None，会把同一次成功再报一遍。
        let prev_last = get_prev_success(&key);
        set_prev_success(&key, observed_last);

        // --- 静默那一头（现有行为，notify_on=Recovery 时跳过）---
        let mut fired = false;
        if rule.notify_on.watches_silence() {
            match decide(&rule, idle_sec, fired_count) {
                Decision::Waiting => {
                    // 基线被新成功请求推后 → due 变小，把计数拉回真实刻度。否则
                    // 「静默 1 小时提醒过 → 用了一次 → 再静默 1 小时」不会再提醒。
                    let due = idle_sec.max(0) / rule.threshold_sec();
                    if due < fired_count as i64 {
                        set_fired(&key, due as u32);
                    }
                }
                Decision::Fire {
                    fired_count: new_count,
                } => {
                    // 保活只在「渠道确实静默着」时打：它的意义是顺手触碰一下快失效的
                    // 渠道，恢复场景里渠道刚刚成功过，poking 没有意义。
                    let (keepalive_outcome, keepalive_error) = if config.keepalive_enabled {
                        keepalive(db, &rule).await
                    } else {
                        (KeepaliveOutcome::Skipped, None)
                    };
                    alerts.push(IdleWatchAlert {
                        app_type: rule.app_type.clone(),
                        provider_id: rule.provider_id.clone(),
                        provider_name: provider_name.clone(),
                        mode: rule.mode,
                        kind: IdleWatchAlertKind::Silence,
                        threshold_minutes: rule.threshold_minutes,
                        idle_sec,
                        keepalive: keepalive_outcome,
                        keepalive_error,
                    });
                    set_fired(&key, new_count);
                    fired = true;
                }
            }
        }

        // --- 恢复那一头 ---
        if rule.notify_on.watches_recovery() {
            if let Some(gap_sec) = decide_recovery(&rule, prev_last, observed_last) {
                alerts.push(IdleWatchAlert {
                    app_type: rule.app_type.clone(),
                    provider_id: rule.provider_id.clone(),
                    provider_name: provider_name.clone(),
                    mode: rule.mode,
                    kind: IdleWatchAlertKind::Recovery,
                    threshold_minutes: rule.threshold_minutes,
                    idle_sec: gap_sec,
                    keepalive: KeepaliveOutcome::Skipped,
                    keepalive_error: None,
                });
                fired = true;
            }
        }

        // 一次性规则：任一方向触发过就删除（与静默模式下的既有语义一致）。
        if rule.mode == IdleWatchMode::Once && fired {
            removed_keys.push(key);
        } else {
            survivors.push(rule);
        }
    }

    drop_fired(&removed_keys);
    drop_prev_success(&removed_keys);

    // 规则集有增删才落盘（多数轮次只读不写）。
    if !removed_keys.is_empty() {
        let next = IdleWatchConfig {
            enabled: config.enabled,
            keepalive_enabled: config.keepalive_enabled,
            rules: survivors,
        };
        let saved = {
            let db = db.clone();
            tauri::async_runtime::spawn_blocking(move || db.save_idle_watch_config(&next))
                .await
                .map_err(|e| format!("保存规则集失败: {e}"))?
        };
        if let Err(e) = saved {
            // 落盘失败只意味着下次启动会重放这一轮（Once 规则再提醒一次）。
            // 提醒照发，不回滚内存状态。
            log::warn!("[IdleWatch] 规则集落盘失败: {e}");
        }
    }

    for alert in &alerts {
        notify(app, alert);
    }
    if !alerts.is_empty() {
        // 前端面板若在就 toast + 重取状态表；没挂上则无人监听，忽略即可。
        if let Err(e) = app.emit(EVENT_IDLE_WATCH_ALERT, &alerts) {
            log::debug!("[IdleWatch] emit {EVENT_IDLE_WATCH_ALERT} 失败: {e}");
        }
    }
    Ok(())
}

/// 解析规则涉及的供应商展示名。返回的 map **只含仍然存在的渠道**——缺键即「渠道
/// 已删」，调用方据此丢弃规则。
///
/// 按规则里写的 app_type 原样查：providers 表是按原始 app_type 分命名空间的，
/// 用户在面板上选的也就是命名空间。（`claude-desktop` 的流量折叠进 `claude` 只发生在
/// **读日志**那一侧，不影响供应商归属。）
fn resolve_provider_names(db: &Database, rules: &[IdleWatchRule]) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    for rule in rules {
        let key = rule.key();
        if out.contains_key(&key) {
            continue;
        }
        if let Ok(Some(provider)) = db.get_provider_by_id(&rule.provider_id, &rule.app_type) {
            out.insert(key, provider.name);
        }
    }
    out
}

/// 保活：真实认证地打一次 `GET /models`。
///
/// 走 `prepare_upstream_models` → `fetch_models`（与网关目录拉模型同一条链路）：
/// **密钥不出后端**、鉴权真实、零 token 消耗。局限：`ClaudeAuth` / `Bearer` / 各家
/// OAuth 需要动态取 token，拿不到静态 key → 报 `Unsupported`，只提醒不保活。
///
/// 刻意**不写** `proxy_request_logs`（它不是代理流量），因此**不会重置计时基线**——
/// 面板文案要讲清「保活不会让提醒停下来」，否则用户会以为开了保活就永远不被提醒。
async fn keepalive(db: &Arc<Database>, rule: &IdleWatchRule) -> (KeepaliveOutcome, Option<String>) {
    use crate::services::{gateway, model_fetch};

    let prepared = {
        let db = db.clone();
        let app_type = rule.app_type.clone();
        let provider_id = rule.provider_id.clone();
        match tauri::async_runtime::spawn_blocking(move || {
            let parsed = app_type
                .parse::<crate::app_config::AppType>()
                .map_err(|e| e.to_string())?;
            gateway::prepare_upstream_models(&db, &parsed, &provider_id)
        })
        .await
        {
            Ok(Ok(req)) => req,
            // Err 里既有「供应商不存在」也有「该鉴权需动态取 token」。前者已被
            // 上游的名字解析挡掉，所以这里按可预期限制报 Unsupported，并把原文
            // 带给前端——免得把「无法保活」误标成「网络故障」。
            Ok(Err(msg)) => {
                log::debug!("[IdleWatch] 保活跳过（{}）: {msg}", rule.key());
                return (KeepaliveOutcome::Unsupported, Some(msg));
            }
            Err(e) => return (KeepaliveOutcome::Failed, Some(format!("任务失败: {e}"))),
        }
    };

    // 拿到静态 key 但这套鉴权不支持静态拉模型（ClaudeAuth / Bearer）→ api_format 为 None
    let Some(api_format) = prepared.api_format else {
        return (
            KeepaliveOutcome::Unsupported,
            Some("该鉴权方式无法静态拉取模型列表".to_string()),
        );
    };

    match tokio::time::timeout(
        Duration::from_secs(KEEPALIVE_TIMEOUT_SECS),
        model_fetch::fetch_models(
            &prepared.base_url,
            &prepared.api_key,
            false,
            None,
            None,
            Some(api_format),
            None,
        ),
    )
    .await
    {
        Ok(Ok(models)) => {
            log::info!(
                "[IdleWatch] 保活成功（{}）: 拿到 {} 个模型",
                rule.key(),
                models.len()
            );
            (KeepaliveOutcome::Ok, None)
        }
        Ok(Err(e)) => (KeepaliveOutcome::Failed, Some(e)),
        Err(_) => (
            KeepaliveOutcome::Failed,
            Some(format!("超时（>{KEEPALIVE_TIMEOUT_SECS}s）")),
        ),
    }
}

/// 发系统通知。提醒是主体、保活是附加，所以保活结果只进正文，不决定要不要发。
///
/// 中英拼一行：系统通知拿不到前端的 i18n 上下文，双语是成本最低的折中（重放器
/// 通知同此处理）。
///
/// 发送方法是 `show()`——builder **没有** `finish()`（照抄别的 builder 的命名习惯
/// 会编译不过）。
fn notify(app: &AppHandle, alert: &IdleWatchAlert) {
    use tauri_plugin_notification::NotificationExt;

    let idle_human = humanize_idle(alert.idle_sec);
    // 两种方向的正文是两句话，不能共用模板：静默要说「已经多久没成功」，恢复要说
    // 「静默了多久之后终于又来了成功的」——把后者写成前者正好反了。
    let (body_zh, body_en) = match alert.kind {
        IdleWatchAlertKind::Silence => (
            format!(
                "{}（{}）已 {idle_human} 没有成功请求",
                alert.provider_name, alert.app_type
            ),
            format!(
                "{} ({}) has had no successful request for {idle_human}",
                alert.provider_name, alert.app_type
            ),
        ),
        IdleWatchAlertKind::Recovery => (
            format!(
                "{}（{}）静默 {idle_human} 后恢复成功请求",
                alert.provider_name, alert.app_type
            ),
            format!(
                "{} ({}) is serving successful requests again after {idle_human} of silence",
                alert.provider_name, alert.app_type
            ),
        ),
    };
    let keepalive_note = match alert.keepalive {
        KeepaliveOutcome::Skipped => String::new(),
        KeepaliveOutcome::Ok => "｜已自动保活成功 / keep-alive OK".to_string(),
        KeepaliveOutcome::Unsupported => {
            "｜该渠道无法自动保活（需动态 token）/ keep-alive unavailable".to_string()
        }
        KeepaliveOutcome::Failed => format!(
            "｜自动保活失败 / keep-alive failed: {}",
            alert.keepalive_error.clone().unwrap_or_default()
        ),
    };
    let mode_note = match alert.mode {
        IdleWatchMode::Once => "｜一次性提醒已结束 / one-shot alert done",
        IdleWatchMode::Always => "",
    };

    let body = format!("{body_zh}{keepalive_note}{mode_note}\n{body_en}{keepalive_note}");
    log::info!("[IdleWatch] 提醒: {body}");

    // 标题也分方向：通知列表里扫一眼就该看出是「挂了」还是「回来了」。
    let title = match alert.kind {
        IdleWatchAlertKind::Silence => "渠道静默提醒 / Idle channel",
        IdleWatchAlertKind::Recovery => "渠道恢复提醒 / Channel recovered",
    };
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        log::warn!("[IdleWatch] 系统通知发送失败: {e}");
    }
}

/// 把秒数说成双语人话。
fn humanize_idle(idle_sec: i64) -> String {
    let mins = idle_sec / 60;
    if mins < 60 {
        format!("{mins} 分钟 / {mins} min")
    } else {
        let hours = mins / 60;
        if hours < 24 {
            format!("{hours} 小时 {} 分 / {hours}h {}m", mins % 60, mins % 60)
        } else {
            let days = hours / 24;
            format!("{days} 天 / {days} d")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(mode: IdleWatchMode, threshold_minutes: u64, created_at_sec: i64) -> IdleWatchRule {
        IdleWatchRule {
            app_type: "claude".into(),
            provider_id: "p".into(),
            mode,
            threshold_minutes,
            created_at_sec,
            // 静默方向的既有测试照旧跑；恢复方向的用例用 `..rule(..)` 覆盖这一字段。
            notify_on: IdleWatchNotifyOn::Silence,
        }
    }

    #[test]
    fn once_waits_until_first_threshold() {
        let r = rule(IdleWatchMode::Once, 60, 0); // 阈值 3600s
        assert_eq!(decide(&r, 3599, 0), Decision::Waiting, "差 1 秒不该提醒");
        assert!(matches!(
            decide(&r, 3600, 0),
            Decision::Fire { fired_count: 1 }
        ));
        assert!(matches!(decide(&r, 7200, 0), Decision::Fire { .. }));
    }

    #[test]
    fn always_fires_once_per_threshold_crossing() {
        let r = rule(IdleWatchMode::Always, 60, 0);
        assert_eq!(decide(&r, 3599, 0), Decision::Waiting);
        assert!(matches!(
            decide(&r, 3600, 0),
            Decision::Fire { fired_count: 1 }
        ));
        // 同一刻度内不重复
        assert_eq!(decide(&r, 5400, 1), Decision::Waiting);
        // 跨过第二个刻度
        assert!(matches!(
            decide(&r, 7200, 1),
            Decision::Fire { fired_count: 2 }
        ));
    }

    #[test]
    fn always_catches_up_at_most_one_per_tick() {
        let r = rule(IdleWatchMode::Always, 60, 0);
        // 静默 2.5 个阈值（9000s）却一次没提醒过（如重启后）：只提醒一条，计数直接
        // 跳到当前刻度 2，不追补两条。（5400s 只是 1.5 个刻度、due=1，撑不起这个断言。）
        assert!(matches!(
            decide(&r, 9000, 0),
            Decision::Fire { fired_count: 2 }
        ));
        assert_eq!(decide(&r, 9000, 2), Decision::Waiting);
    }

    #[test]
    fn new_success_reschedules_the_next_crossing() {
        let r = rule(IdleWatchMode::Always, 60, 0);
        // 已提醒过一次（计数 1），随后来了成功请求 → idle 变小，此时不该提醒；
        // run_tick 会把计数拉回 due=0，于是再静默满一个阈值能再次提醒。
        assert_eq!(decide(&r, 60, 1), Decision::Waiting);
        assert!(matches!(
            decide(&r, 3600, 0),
            Decision::Fire { fired_count: 1 }
        ));
    }

    #[test]
    fn negative_idle_is_ignored() {
        // 时钟回拨 / created_at 在未来：不 panic、不提醒
        let r = rule(IdleWatchMode::Once, 60, 10_000);
        assert_eq!(decide(&r, -1, 0), Decision::Waiting);
    }

    #[test]
    fn one_minute_threshold_is_exactly_60_seconds() {
        let r = rule(IdleWatchMode::Once, 1, 0);
        assert_eq!(r.threshold_sec(), 60);
        assert_eq!(decide(&r, 59, 0), Decision::Waiting);
        assert!(matches!(decide(&r, 60, 0), Decision::Fire { .. }));
    }

    #[test]
    fn fired_table_roundtrip_and_prune() {
        // 共用全局 FIRED，用独立 key 避免与其它用例串扰
        let key = "claude|test-roundtrip";
        assert_eq!(get_fired(key), 0, "未记录过的规则从 0 开始");
        set_fired(key, 3);
        assert_eq!(get_fired(key), 3);
        set_fired(key, 1);
        assert_eq!(get_fired(key), 1, "可向下覆盖（成功后基线推后）");
        drop_fired(&[key.to_string()]);
        assert_eq!(get_fired(key), 0, "删除规则时一并清掉计数");
    }

    #[test]
    fn humanize_idle_covers_min_hour_day() {
        assert!(humanize_idle(5 * 60).starts_with("5 分钟"));
        assert!(humanize_idle(90 * 60).starts_with("1 小时 30 分"));
        assert!(humanize_idle(50 * 3600).starts_with("2 天"));
    }

    /// 阈值 3600s、规则建于 0 的恢复方向规则。
    fn recovery_rule(mode: IdleWatchMode) -> IdleWatchRule {
        IdleWatchRule {
            notify_on: IdleWatchNotifyOn::Recovery,
            ..rule(mode, 60, 0)
        }
    }

    #[test]
    fn recovery_seeds_on_first_round_instead_of_firing() {
        // 启动后的首轮（prev_last = None，键不在表里）：日志里那条历史 200 不是「刚
        // 恢复」。少了这条，每次启动都会给一个从没挂过的渠道弹一条恢复通知。
        let r = recovery_rule(IdleWatchMode::Always);
        assert_eq!(decide_recovery(&r, None, Some(1_000_000)), None);
        // 首轮连成功都没有，同样只播种
        assert_eq!(decide_recovery(&r, None, None), None);
    }

    #[test]
    fn recovery_fires_only_after_the_gap_reaches_threshold() {
        let r = recovery_rule(IdleWatchMode::Always); // 阈值 3600s
                                                      // 静默 1 小时（3600s）后的那次成功：刚好够，报的就是这段 gap
        assert_eq!(
            decide_recovery(&r, Some(Some(100_000)), Some(103_600)),
            Some(3600),
            "gap 就是那次成功之前的静默时长，正文要用它"
        );
        // 差 1 秒不够
        assert_eq!(
            decide_recovery(&r, Some(Some(100_000)), Some(103_599)),
            None,
            "与静默方向同一套边界：差 1 秒不算满阈值"
        );
    }

    #[test]
    fn steady_traffic_never_reports_recovery() {
        // 正常使用的渠道每几分钟一条 200，gap 远小于阈值 → 永远不该报。这是「不刷屏」
        // 的关键：恢复的语义是「等了很久终于等到」，不是「每条成功都报」。
        let r = recovery_rule(IdleWatchMode::Always);
        let mut last = 1_000_000;
        for _ in 0..200 {
            let next = last + 180; // 每 3 分钟一条
            assert_eq!(decide_recovery(&r, Some(Some(last)), Some(next)), None);
            last = next;
        }
    }

    #[test]
    fn recovery_counts_silence_from_rule_creation_when_no_prior_success() {
        // 设完规则后一直没流量（上一轮 observed = None），终于来了个 200 —— 静默起点
        // 退到 created_at_sec，与静默计时同一条基线公式。少了这条，最该报的那条会漏。
        let r = IdleWatchRule {
            notify_on: IdleWatchNotifyOn::Recovery,
            ..rule(IdleWatchMode::Always, 60, 100_000)
        };
        assert_eq!(decide_recovery(&r, Some(None), Some(103_600)), Some(3600));
        assert_eq!(decide_recovery(&r, Some(None), Some(101_000)), None);
    }

    #[test]
    fn recovery_ignores_a_regression_of_last_success() {
        // 日志滚存删行 / 时钟回拨都可能让 MAX(created_at) 变小。变小不是恢复。
        let r = recovery_rule(IdleWatchMode::Always);
        assert_eq!(
            decide_recovery(&r, Some(Some(200_000)), Some(100_000)),
            None
        );
        // 原地不动 = 没有新成功
        assert_eq!(
            decide_recovery(&r, Some(Some(200_000)), Some(200_000)),
            None
        );
        // 本轮没有成功记录（observed = None）→ 没有可报的成功。这一条在恢复与「日志
        // 被滚存清空」两种处境下都必须成立，否则会把 None 当成 0 报出一个天文数字。
        assert_eq!(decide_recovery(&r, Some(Some(200_000)), None), None);
    }

    #[test]
    fn recovery_ignores_a_seed_left_by_a_deleted_rule() {
        // 播种表按**渠道**存，不是按规则。删掉一条规则再加一条同渠道的新规则，读到的
        // 是上一条规则留下的播种值——不夹到 created_at_sec 的话，用户给一个天天正常用
        // 的渠道加恢复规则，下一个 tick 就会收到「静默 3 天后恢复成功请求」，而他刚设
        // 完规则、什么都没发生。这是模块头约束 1 在恢复方向的同一个坑。
        let now = 1_000_000;
        let fresh = IdleWatchRule {
            notify_on: IdleWatchNotifyOn::Recovery,
            // 规则刚刚建立
            ..rule(IdleWatchMode::Always, 60, now)
        };
        // 上一轮（属于一条已被删除的规则）看到的成功在 3 天前
        let stale_seed = Some(Some(now - 3 * 86_400));
        // 渠道一直都在正常用：这轮的成功只比上轮晚 3 分钟
        assert_eq!(
            decide_recovery(&fresh, stale_seed, Some(now + 180)),
            None,
            "新规则的计时起点只能是它自己的建立时刻"
        );
        // 同一条新规则：只有「建立之后确实静默满了阈值」的成功才算恢复
        assert_eq!(
            decide_recovery(&fresh, stale_seed, Some(now + 3_600)),
            Some(3_600),
            "夹到 created_at_sec 之后，静默满阈值的恢复照常要报"
        );
    }

    #[test]
    fn recovery_rule_fires_once_in_once_mode() {
        // 一次性 + 恢复：报完就该由 run_tick 删除规则。判定侧只保证 decide_recovery
        // 给出 Some；删除走 fired 分支（见 run_tick 末尾）。
        let r = recovery_rule(IdleWatchMode::Once);
        assert_eq!(
            decide_recovery(&r, Some(Some(0)), Some(3_600)),
            Some(3_600),
            "一次性规则的判定与常开一致，差别只在报完之后删不删"
        );
    }

    #[test]
    fn both_directions_watch_both() {
        let both = IdleWatchRule {
            notify_on: IdleWatchNotifyOn::Both,
            ..rule(IdleWatchMode::Always, 60, 0)
        };
        assert!(both.notify_on.watches_silence());
        assert!(both.notify_on.watches_recovery());

        let silence = rule(IdleWatchMode::Always, 60, 0);
        assert!(silence.notify_on.watches_silence());
        assert!(
            !silence.notify_on.watches_recovery(),
            "默认方向不该因为加了恢复功能就多弹通知"
        );

        let recovery = recovery_rule(IdleWatchMode::Always);
        assert!(!recovery.notify_on.watches_silence());
        assert!(recovery.notify_on.watches_recovery());
    }

    #[test]
    fn prev_success_table_roundtrip_and_prune() {
        // 共用全局表，用独立 key 避免与其它用例串扰。三层语义都要能区分开。
        let key = "claude|test-prev";
        assert_eq!(
            get_prev_success(key),
            None,
            "键不在表里 = 本进程还没跑过这条规则（首轮只播种）"
        );
        set_prev_success(key, None);
        assert_eq!(
            get_prev_success(key),
            Some(None),
            "「跑过但当时没有成功记录」必须与「从没跑过」区分开"
        );
        set_prev_success(key, Some(123));
        assert_eq!(get_prev_success(key), Some(Some(123)));
        drop_prev_success(&[key.to_string()]);
        assert_eq!(get_prev_success(key), None, "删除规则时一并清掉播种");
    }
}
