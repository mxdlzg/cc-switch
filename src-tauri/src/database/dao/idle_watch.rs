//! 渠道静默监控（Idle Watch）的持久化与只读查询
//!
//! 两类访问：
//! 1. **配置**——整块 JSON 存进 settings 表（键 `idle_watch_config`），形状照
//!    `stream_check_config`。**不建表、不做迁移**：规则条数是个位数，整读整写比
//!    建表再迁移省事，也让它天然被 S3/WebDAV 同步带上（settings 表在同步白名单里）。
//! 2. **活动查询**——`proxy_request_logs` 的只读聚合，判定「某渠道最近一次成功
//!    请求是什么时候」。
//!
//! ⚠️ `proxy_request_logs.created_at` 是 **Unix 秒**（`proxy/usage/logger.rs` 用
//! `Utc::now().timestamp()`），本文件所有比较都按秒。当成毫秒会差 1000 倍。

use crate::database::{lock_conn, Database};
use crate::error::AppError;
use serde::{Deserialize, Serialize};

/// 规则模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IdleWatchMode {
    /// 一次性：触发一次提醒后该规则自动删除，直到用户重新设。
    Once,
    /// 常开：持续静默则每「再静默一个阈值时长」提醒一次。
    Always,
}

/// 一条渠道静默规则。渠道 = (`app_type`, `provider_id`)，与查看器/用量统计同口径。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleWatchRule {
    pub app_type: String,
    pub provider_id: String,
    pub mode: IdleWatchMode,
    /// 静默多久算「太久没用」，单位**分钟**（前端填分钟，后端换算秒）。
    pub threshold_minutes: u64,
    /// 规则建立时刻（Unix 秒）。用作计时基线下限，见 `services::idle_watch` 的
    /// 「基线取 max(最近成功, 本字段)」——否则给一个已经静默一个月的渠道加规则，
    /// 下一个 tick 就会弹一条「你很久没用了」，而用户其实刚设完规则。
    pub created_at_sec: i64,
}

impl IdleWatchRule {
    /// 规则主键（内存计数表用；app_type / provider_id 都不含 `|`）。
    pub fn key(&self) -> String {
        format!("{}|{}", self.app_type, self.provider_id)
    }

    /// 阈值的秒数。命令层已保证 ≥ 1 分钟，这里再兜一层：手改配置塞进 0 会导致
    /// `idle_sec / threshold_sec` 除零 panic。
    pub fn threshold_sec(&self) -> i64 {
        self.threshold_minutes.max(1) as i64 * 60
    }
}

/// 静默监控总配置（settings 表里的一条 JSON）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleWatchConfig {
    /// 总开关。关掉**不丢规则**，只是不检查、不提醒。
    #[serde(default)]
    pub enabled: bool,
    /// 可选自动保活：触发提醒时顺手打一次真实认证的 `GET /models`。
    #[serde(default)]
    pub keepalive_enabled: bool,
    /// 规则集，每渠道至多一条（命令层去重）。
    #[serde(default)]
    pub rules: Vec<IdleWatchRule>,
}

/// 一个渠道的成功请求活动汇总，供面板整表显示。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelIdle {
    /// **展示口径**的 app_type（`claude-desktop` 已折叠进 `claude`，与规则匹配同口径）
    pub app_type: String,
    pub provider_id: String,
    /// providers 表的名称；供应商已删（历史残留日志行）则回落 id
    pub provider_name: String,
    /// 最近一次 2xx 请求时刻（Unix 秒）；该渠道无成功记录为 None
    pub last_success_at: Option<i64>,
    /// 成功请求条数。为 0 而 `request_count` > 0 = 「有流量但全失败」，
    /// 与「从未经过代理」是两种截然不同的处境，面板要分开讲。
    pub success_count: i64,
    /// 全部请求条数（含失败）
    pub request_count: i64,
}

/// 渠道归属过滤：排除会话伪供应商（`_session` / `_codex_session` / …）。
///
/// 这些行是 CLI 直连供应商时从会话文件扫出来的，**没有渠道归属**
/// （`services/session_usage.rs` 一律写 `"_session"`），因此不参与静默判定：
/// 既不该被当成某个渠道的活动，也不该出现在渠道表里（否则用户会看到一排
/// 「Claude (Session)」要求给它加规则，而那条规则永远不会被正确评估）。
///
/// `ESCAPE '\'` 是让 `_` 按字面匹配——LIKE 里裸 `_` 是「任意单字符」通配符，
/// 漏掉转义会把所有单字母前缀的真实供应商一起误杀。
const EXCLUDE_SESSION_PROVIDERS: &str = "l.provider_id NOT LIKE '\\_%' ESCAPE '\\'";

impl Database {
    // --- 配置 ---

    /// 读取静默监控配置；从未配置过返回默认值（关闭 + 空规则）。
    ///
    /// 存在但解析不了时**报错，不静默回落默认值**：回落会让下一次保存把坏配置
    /// 覆盖成空规则集，用户丢了规则还找不到原因。报错则面板与后台循环都能把这条
    /// 原因原样讲出来（后台循环见错即跳过本轮，不崩、不牵动其它功能）。
    pub fn get_idle_watch_config(&self) -> Result<IdleWatchConfig, AppError> {
        match self.get_setting("idle_watch_config")? {
            Some(json) => serde_json::from_str(&json)
                .map_err(|e| AppError::Message(format!("解析渠道静默监控配置失败: {e}"))),
            None => Ok(IdleWatchConfig::default()),
        }
    }

    /// 整块保存配置。
    pub fn save_idle_watch_config(&self, config: &IdleWatchConfig) -> Result<(), AppError> {
        let json = serde_json::to_string(config)
            .map_err(|e| AppError::Message(format!("序列化渠道静默监控配置失败: {e}")))?;
        self.set_setting("idle_watch_config", &json)
    }

    // --- 活动查询 ---

    /// 全渠道活动汇总（面板整表与后台循环**共用**这一条查询：一次 `GROUP BY` 出全部，
    /// 不做每规则一条 SQL 的 N+1）。
    ///
    /// 只认 **2xx**（用户明确要求：失败请求不算「用过」——一个一直 5xx 的渠道恰恰是
    /// 「没被真正用上」的典型场景）。`app_type` 在 SELECT 与 GROUP BY 里用**同一个**
    /// 折叠表达式——否则面板把 `claude` / `claude-desktop` 拆成两行、而规则按合并口径
    /// 判定，用户看到的静默时长和实际提醒会对不上。
    ///
    /// 只包含「日志里出现过」的渠道；从未经过代理的渠道由命令层按规则补零行。
    pub fn list_channel_idle_activity(&self) -> Result<Vec<ChannelIdle>, AppError> {
        let conn = lock_conn!(self.conn);
        let folded = folded_app_type_sql("l.app_type");
        let sql = format!(
            "SELECT {folded} AS app_type,
                    l.provider_id AS provider_id,
                    MAX({pname}) AS provider_name,
                    MAX(CASE WHEN l.status_code BETWEEN 200 AND 299 THEN l.created_at END) AS last_success_at,
                    SUM(CASE WHEN l.status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS success_count,
                    COUNT(*) AS request_count
             FROM proxy_request_logs l
             LEFT JOIN providers p ON l.provider_id = p.id AND l.app_type = p.app_type
             WHERE {exclude}
             GROUP BY {folded}, l.provider_id
             ORDER BY provider_name ASC, app_type ASC",
            pname = provider_name_sql("l", "p"),
            exclude = EXCLUDE_SESSION_PROVIDERS,
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| AppError::Database(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ChannelIdle {
                    app_type: row.get(0)?,
                    provider_id: row.get(1)?,
                    provider_name: row.get(2)?,
                    last_success_at: row.get(3)?,
                    success_count: row.get(4)?,
                    request_count: row.get(5)?,
                })
            })
            .map_err(|e| AppError::Database(e.to_string()))?;
        let mut out = Vec::new();
        for row in rows {
            let item = row.map_err(|e| AppError::Database(e.to_string()))?;
            // SQL 侧的 LIKE 已滤掉下划线前缀；这里再兜一层——伪渠道混进面板会显示成
            // 一排无法有效加规则的条目，宁可少显示也不要误导。
            if !item.provider_id.starts_with('_') {
                out.push(item);
            }
        }
        Ok(out)
    }
}

/// SQL 标量表达式：把 `claude-desktop` 在展示口径上折叠进 `claude`。
///
/// 与 `services::usage_stats::folded_app_type_sql` 同义（那边是模块私有的，跨模块
/// 复用要牵动 dashboard 的可见性；这里刻意留一份局部副本，语义变动两边一起改）。
fn folded_app_type_sql(column: &str) -> String {
    format!("CASE WHEN {column} = 'claude-desktop' THEN 'claude' ELSE {column} END")
}

/// SQL **聚合**表达式：供应商展示名。providers 查不到时（已删供应商 / 历史残留日志行）
/// 回落到 provider_id。会话伪供应商已被 WHERE 排除，故不需要它们的可读名。
///
/// 写成 `COALESCE(MAX(p.name), MAX(l.provider_id))` 而不是 `MAX(COALESCE(...))`：
/// 折叠后的分组里可能**同时**有 joined 与未 joined 的行（`claude` 有 providers 行、
/// `claude-desktop` 没有），后者会把 provider_id 喂进同一个聚合，而 `MAX` 是按字符串
/// 比的——小写 id 排在大写名称前面，于是名字会被 id 顶掉。`MAX` 忽略 NULL，所以先取
/// 「组内任意一个名字」，一个都没有才回落 id。
fn provider_name_sql(log_alias: &str, provider_alias: &str) -> String {
    format!("COALESCE(MAX({provider_alias}.name), MAX({log_alias}.provider_id))")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;

    /// 直插一条日志行（绕过 logger：测试只关心 SQL 口径，不关心计价）。
    ///
    /// 这里**不用** `lock_conn!`——那个宏里带 `?`，只能出现在返回 `Result` 的函数里，
    /// 而本辅助函数返回 `()`；测试里直接 `expect` 更直白。
    fn insert_log(
        db: &Database,
        request_id: &str,
        provider_id: &str,
        app_type: &str,
        status: u16,
        created_at: i64,
    ) {
        let conn = db.conn.lock().expect("lock test conn");
        conn.execute(
            "INSERT INTO proxy_request_logs (
                request_id, provider_id, app_type, model, input_tokens, output_tokens,
                total_cost_usd, latency_ms, status_code, created_at, data_source
             ) VALUES (?1, ?2, ?3, 'm', 1, 1, '0', 10, ?4, ?5, 'proxy')",
            rusqlite::params![request_id, provider_id, app_type, status as i64, created_at],
        )
        .unwrap();
    }

    #[test]
    fn config_roundtrip_and_default_when_absent() {
        let db = Database::memory().unwrap();
        let fresh = db.get_idle_watch_config().unwrap();
        assert!(!fresh.enabled, "未配置时应默认关闭");
        assert!(fresh.rules.is_empty());

        let cfg = IdleWatchConfig {
            enabled: true,
            keepalive_enabled: true,
            rules: vec![IdleWatchRule {
                app_type: "claude".into(),
                provider_id: "prov-a".into(),
                mode: IdleWatchMode::Once,
                threshold_minutes: 90,
                created_at_sec: 1_700_000_000,
            }],
        };
        db.save_idle_watch_config(&cfg).unwrap();
        let got = db.get_idle_watch_config().unwrap();
        assert!(got.enabled);
        assert!(got.keepalive_enabled);
        assert_eq!(got.rules.len(), 1);
        assert_eq!(got.rules[0].mode, IdleWatchMode::Once);
        assert_eq!(got.rules[0].threshold_minutes, 90);
        assert_eq!(got.rules[0].created_at_sec, 1_700_000_000);
    }

    #[test]
    fn corrupt_config_errors_instead_of_resetting() {
        let db = Database::memory().unwrap();
        db.set_setting("idle_watch_config", "{ not json").unwrap();
        assert!(
            db.get_idle_watch_config().is_err(),
            "坏配置必须报错：静默回落默认值会让下一次保存清空用户的规则"
        );
    }

    #[test]
    fn only_success_counts_as_activity() {
        let db = Database::memory().unwrap();
        // 500 / 400 都不算活动：一直报错的渠道恰恰是「没被真正用上」
        insert_log(&db, "r1", "p", "claude", 500, 1_000);
        insert_log(&db, "r2", "p", "claude", 400, 2_000);
        let rows = db.list_channel_idle_activity().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].last_success_at, None, "全失败时没有成功起点");
        assert_eq!(rows[0].success_count, 0);
        assert_eq!(rows[0].request_count, 2);

        insert_log(&db, "r3", "p", "claude", 200, 3_000);
        let rows = db.list_channel_idle_activity().unwrap();
        assert_eq!(rows[0].last_success_at, Some(3_000));
        assert_eq!(rows[0].success_count, 1);

        // 更晚的失败不推后基线（但计入总数，面板据此显示「全部失败」以外的处境）
        insert_log(&db, "r4", "p", "claude", 503, 4_000);
        let rows = db.list_channel_idle_activity().unwrap();
        assert_eq!(rows[0].last_success_at, Some(3_000));
        assert_eq!(rows[0].request_count, 4);
    }

    #[test]
    fn claude_desktop_folds_into_claude_and_never_yields_its_own_row() {
        let db = Database::memory().unwrap();
        insert_log(&db, "r1", "p", "claude-desktop", 200, 5_000);
        insert_log(&db, "r2", "p", "claude", 200, 6_000);

        let rows = db.list_channel_idle_activity().unwrap();
        assert_eq!(rows.len(), 1, "两个 app_type 的流量合成一行");
        assert_eq!(rows[0].app_type, "claude");
        assert_eq!(rows[0].last_success_at, Some(6_000));
        // 折叠是单向的：表里永远不会出现 `claude-desktop` 行。挂在该 app_type 上的
        // 规则因此恒查不到活动 → 静默时长只涨不降 → 到点必误报，这正是命令层在保存
        // 时就拒绝它的原因（见 commands::idle_watch::build_config）。
        assert!(!rows.iter().any(|r| r.app_type == "claude-desktop"));
    }

    #[test]
    fn channel_query_folds_and_counts_successes_separately() {
        let db = Database::memory().unwrap();
        insert_log(&db, "r1", "prov-a", "claude", 200, 2_000);
        insert_log(&db, "r2", "prov-a", "claude", 500, 3_000);
        // 同供应商的 desktop 流量必须并入 claude 一行（与规则判定同口径）
        insert_log(&db, "r3", "prov-a", "claude-desktop", 200, 4_000);

        let rows = db.list_channel_idle_activity().unwrap();
        assert_eq!(rows.len(), 1, "折叠后 claude 与 claude-desktop 应合成一行");
        let row = &rows[0];
        assert_eq!(row.app_type, "claude");
        assert_eq!(row.success_count, 2);
        assert_eq!(
            row.request_count, 3,
            "失败请求计入总数（面板据此区分全失败与没用过）"
        );
        assert_eq!(row.last_success_at, Some(4_000));
        assert_eq!(row.provider_name, "prov-a", "providers 无此供应商时回落 id");
    }

    #[test]
    fn channel_query_excludes_session_pseudo_providers() {
        let db = Database::memory().unwrap();
        insert_log(&db, "r1", "_session", "claude", 200, 1_000);
        insert_log(&db, "r2", "_codex_session", "codex", 200, 1_000);
        insert_log(&db, "r3", "prov-a", "claude", 200, 2_000);

        let rows = db.list_channel_idle_activity().unwrap();
        assert_eq!(rows.len(), 1, "会话伪渠道不该出现在渠道表里");
        assert_eq!(rows[0].provider_id, "prov-a");
    }

    #[test]
    fn folded_group_prefers_provider_name_over_id() {
        // 折叠分组里 `claude` 有 providers 行、`claude-desktop` 没有（后者的 LEFT JOIN
        // 落空，把 provider_id 喂进同一个聚合）。名字必须赢：写反成
        // MAX(COALESCE(name, provider_id)) 时，小写 id 按字符串序顶掉大写名字。
        let db = Database::memory().unwrap();
        {
            let conn = db.conn.lock().expect("lock test conn");
            conn.execute(
                "INSERT INTO providers (id, app_type, name, settings_config, meta)
                 VALUES ('zz-id', 'claude', 'A Nice Name', '{}', '{}')",
                [],
            )
            .unwrap();
        }
        insert_log(&db, "r1", "zz-id", "claude", 200, 2_000);
        insert_log(&db, "r2", "zz-id", "claude-desktop", 200, 3_000);

        let rows = db.list_channel_idle_activity().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].provider_name, "A Nice Name");
    }

    #[test]
    fn like_escape_does_not_glob_single_char_prefixes() {
        // 裸 `_` 在 LIKE 里是通配符；若转义丢失，真实供应商 `a-prov` 会被误杀
        let db = Database::memory().unwrap();
        insert_log(&db, "r1", "a-prov", "claude", 200, 1_000);
        let rows = db.list_channel_idle_activity().unwrap();
        assert_eq!(rows.len(), 1, "单字母开头的供应商不能被下划线通配误伤");
    }

    #[test]
    fn threshold_sec_guards_against_zero() {
        let rule = IdleWatchRule {
            app_type: "claude".into(),
            provider_id: "p".into(),
            mode: IdleWatchMode::Always,
            threshold_minutes: 0,
            created_at_sec: 0,
        };
        assert_eq!(rule.threshold_sec(), 60, "0 分钟兜成 60 秒，避免除零");
    }

    #[test]
    fn rule_key_separates_channels() {
        let a = IdleWatchRule {
            app_type: "claude".into(),
            provider_id: "p".into(),
            mode: IdleWatchMode::Once,
            threshold_minutes: 5,
            created_at_sec: 0,
        };
        let b = IdleWatchRule {
            app_type: "codex".into(),
            provider_id: "p".into(),
            ..a.clone()
        };
        assert_ne!(a.key(), b.key());
    }
}
