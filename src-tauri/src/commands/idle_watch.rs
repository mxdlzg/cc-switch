//! 渠道静默监控（Idle Watch）的 Tauri 命令
//!
//! 三件事：读配置、存配置（**区间校验与去重集中在这里**）、给面板出一份状态表。
//! 数值字段一律以字符串进来，跟 `commands/replay.rs` 同一套做法——以后端为准，
//! 防绕过 UI 直接 invoke 塞进非法值。
//!
//! 状态表的 `idleSec` 与后台引擎**用同一条基线公式**（`max(最近成功, 规则建立时刻)`），
//! 否则面板显示「静默 3 天」而引擎判定「还没到点」，用户只会认为功能坏了。

use crate::database::{IdleWatchConfig, IdleWatchMode, IdleWatchRule};
use crate::error::AppError;
use crate::services::idle_watch::ChannelIdleStatus;
use crate::store::AppState;
use serde::Deserialize;
use tauri::State;

/// 阈值界限（分钟）。下限 1 分钟便于拿真机验证，上限 1440 = 一天。
const THRESHOLD_MIN: u64 = 1;
const THRESHOLD_MAX: u64 = 1440;

/// 前端传来的规则（阈值为字符串，便于输入框直接绑定）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleWatchRuleInput {
    pub app_type: String,
    pub provider_id: String,
    /// `"once"` | `"always"`
    pub mode: String,
    pub threshold_minutes: String,
}

/// 前端传来的整块配置。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleWatchConfigInput {
    pub enabled: bool,
    pub keepalive_enabled: bool,
    pub rules: Vec<IdleWatchRuleInput>,
}

/// 校验 + 转换整块配置。
///
/// 输入里不带 `createdAtSec`：**新**规则由本命令打上当前时刻，**已存在**的规则
/// 保留原值。改阈值不该把计时基线重置成「现在」——那等于每次编辑都要重新等一个
/// 完整周期，用户会觉得「刚改完怎么反而不提醒了」。
fn build_config(
    input: IdleWatchConfigInput,
    existing: &IdleWatchConfig,
    now_sec: i64,
) -> Result<IdleWatchConfig, AppError> {
    let mut rules: Vec<IdleWatchRule> = Vec::with_capacity(input.rules.len());
    let mut seen: Vec<(String, String)> = Vec::new();

    for item in input.rules {
        let app_type = item.app_type.trim().to_string();
        let provider_id = item.provider_id.trim().to_string();
        if app_type.is_empty() || provider_id.is_empty() {
            return Err(AppError::InvalidInput(
                "规则必须同时选择应用与供应商".into(),
            ));
        }
        // 会话伪渠道（`_session` 等）没有渠道归属，加了规则也永远不会被正确评估
        // ——明确拒绝，而不是让用户对着一行「从未有成功请求」猜提醒为什么不来。
        if provider_id.starts_with('_') {
            return Err(AppError::InvalidInput(format!(
                "「{provider_id}」是会话扫描出的占位渠道，无法按渠道监控"
            )));
        }
        // app_type 必须是本程序认识的规范写法。写了个认不出的值，规则会查不到
        // 供应商、下一轮被当「渠道已删」静默清掉——用户会看到规则凭空消失，所以
        // 在保存时就拦下来。
        let parsed_app = app_type
            .parse::<crate::app_config::AppType>()
            .map_err(|_| AppError::InvalidInput(format!("未知应用: {app_type}")))?;
        if parsed_app.as_str() != app_type {
            return Err(AppError::InvalidInput(format!(
                "应用标识写法不规范（应为 {}）",
                parsed_app.as_str()
            )));
        }
        // claude-desktop 的规则永远不会触发：读日志时 app_type 会被折叠进 `claude`
        // （见 dao::idle_watch 的折叠表达式），于是 `WHERE 折叠后 = 'claude-desktop'`
        // 恒不成立，规则只能显示「从未有成功请求」。要盯 Desktop 网关的流量，正确
        // 做法是挂到 `claude` 上——它本来就包含 Desktop 那部分。
        if parsed_app == crate::app_config::AppType::ClaudeDesktop {
            return Err(AppError::InvalidInput(
                "Claude Desktop 的用量按 Claude 统计，请把规则加到 Claude 上".into(),
            ));
        }

        let mode = match item.mode.trim().to_ascii_lowercase().as_str() {
            "once" => IdleWatchMode::Once,
            "always" => IdleWatchMode::Always,
            other => {
                return Err(AppError::InvalidInput(format!(
                    "未知提醒模式: {other}（应为 once 或 always）"
                )))
            }
        };

        let raw = item.threshold_minutes.trim();
        let minutes: i64 = raw
            .parse()
            .map_err(|_| AppError::InvalidInput(format!("阈值必须是整数分钟（当前: {raw}）")))?;
        if minutes < THRESHOLD_MIN as i64 || minutes > THRESHOLD_MAX as i64 {
            return Err(AppError::InvalidInput(format!(
                "阈值需在 {THRESHOLD_MIN}~{THRESHOLD_MAX} 分钟之间（当前: {minutes}）"
            )));
        }

        if seen.contains(&(app_type.clone(), provider_id.clone())) {
            return Err(AppError::InvalidInput(
                "同一渠道只能有一条规则（请改现有那条，不要再加一条）".into(),
            ));
        }
        seen.push((app_type.clone(), provider_id.clone()));

        // 命中旧规则就沿用它的 created_at（见函数头说明）。
        let created_at_sec = existing
            .rules
            .iter()
            .find(|r| r.app_type == app_type && r.provider_id == provider_id)
            .map_or(now_sec, |r| r.created_at_sec);

        rules.push(IdleWatchRule {
            app_type,
            provider_id,
            mode,
            threshold_minutes: minutes as u64,
            created_at_sec,
        });
    }

    Ok(IdleWatchConfig {
        enabled: input.enabled,
        keepalive_enabled: input.keepalive_enabled,
        rules,
    })
}

/// 读取静默监控配置。
#[tauri::command]
pub fn get_idle_watch_config(state: State<'_, AppState>) -> Result<IdleWatchConfig, AppError> {
    state.db.get_idle_watch_config()
}

/// 整块保存配置。返回落盘后的配置，前端直接拿它写缓存（含后端打上的创建时刻）。
#[tauri::command]
pub fn save_idle_watch_config(
    state: State<'_, AppState>,
    config: IdleWatchConfigInput,
) -> Result<IdleWatchConfig, AppError> {
    let existing = state.db.get_idle_watch_config()?;
    let built = build_config(config, &existing, chrono::Utc::now().timestamp())?;
    state.db.save_idle_watch_config(&built)?;
    Ok(built)
}

/// 各渠道的「最近成功请求 / 已静默 / 现有规则」整表，供面板显示。
///
/// 含两类行：
/// - 日志里出现过的渠道（包括「有请求但全失败」——与「从未经过代理」分开讲）
/// - 只有规则、还没有任何日志的渠道：新加的规则要立刻看得见，否则用户以为没保存上
#[tauri::command]
pub fn get_channel_idle_status(
    state: State<'_, AppState>,
) -> Result<Vec<ChannelIdleStatus>, AppError> {
    let config = state.db.get_idle_watch_config()?;
    let activity = state.db.list_channel_idle_activity()?;
    let now_sec = chrono::Utc::now().timestamp();

    let mut rows: Vec<ChannelIdleStatus> = Vec::new();

    for item in activity {
        let rule = config
            .rules
            .iter()
            .find(|r| r.app_type == item.app_type && r.provider_id == item.provider_id);
        // 与引擎同一条基线公式。无规则的渠道也照样算，面板才有的可显示。
        let baseline = match (item.last_success_at, rule) {
            (Some(at), Some(r)) => Some(at.max(r.created_at_sec)),
            (Some(at), None) => Some(at),
            // 有日志但无成功记录 → 起点是规则建立时刻；两者都没有 → 没有可度量的起点
            (None, Some(r)) => Some(r.created_at_sec),
            (None, None) => None,
        };
        rows.push(ChannelIdleStatus {
            app_type: item.app_type,
            provider_id: item.provider_id,
            provider_name: item.provider_name,
            idle_sec: baseline.map(|b| (now_sec - b).max(0)),
            last_success_at: item.last_success_at,
            success_count: item.success_count,
            request_count: item.request_count,
            mode: rule.map(|r| r.mode),
            threshold_minutes: rule.map(|r| r.threshold_minutes),
        });
    }

    // 只有规则、日志里还没有的渠道：补一行「从未有成功请求」。
    for rule in &config.rules {
        if rows
            .iter()
            .any(|r| r.app_type == rule.app_type && r.provider_id == rule.provider_id)
        {
            continue;
        }
        let name = state
            .db
            .get_provider_by_id(&rule.provider_id, &rule.app_type)?
            // 供应商已删：后台下一轮会把这条规则清掉，这里先按 id 显示，不报错。
            .map_or_else(|| rule.provider_id.clone(), |p| p.name);
        rows.push(ChannelIdleStatus {
            app_type: rule.app_type.clone(),
            provider_id: rule.provider_id.clone(),
            provider_name: name,
            idle_sec: Some((now_sec - rule.created_at_sec).max(0)),
            last_success_at: None,
            success_count: 0,
            request_count: 0,
            mode: Some(rule.mode),
            threshold_minutes: Some(rule.threshold_minutes),
        });
    }

    // 有规则的排前面，其余按渠道名——面板第一眼要能看到刚设的那条。
    rows.sort_by(|a, b| {
        b.mode
            .is_some()
            .cmp(&a.mode.is_some())
            .then_with(|| a.provider_name.cmp(&b.provider_name))
            .then_with(|| a.app_type.cmp(&b.app_type))
    });
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    fn input(overrides: &[(&str, &str)]) -> IdleWatchConfigInput {
        let mut item = IdleWatchRuleInput {
            app_type: "claude".into(),
            provider_id: "prov-a".into(),
            mode: "always".into(),
            threshold_minutes: "60".into(),
        };
        for (key, value) in overrides {
            match *key {
                "app_type" => item.app_type = (*value).into(),
                "provider_id" => item.provider_id = (*value).into(),
                "mode" => item.mode = (*value).into(),
                "threshold_minutes" => item.threshold_minutes = (*value).into(),
                other => panic!("unknown field {other}"),
            }
        }
        IdleWatchConfigInput {
            enabled: true,
            keepalive_enabled: false,
            rules: vec![item],
        }
    }

    #[test]
    fn happy_path_stamps_creation_time() {
        let cfg = build_config(input(&[]), &IdleWatchConfig::default(), NOW).unwrap();
        assert!(cfg.enabled);
        assert_eq!(cfg.rules.len(), 1);
        assert_eq!(cfg.rules[0].mode, IdleWatchMode::Always);
        assert_eq!(cfg.rules[0].threshold_minutes, 60);
        assert_eq!(cfg.rules[0].created_at_sec, NOW, "新规则打当前时刻");
    }

    #[test]
    fn existing_created_at_survives_edits() {
        let existing = IdleWatchConfig {
            enabled: true,
            keepalive_enabled: false,
            rules: vec![IdleWatchRule {
                app_type: "claude".into(),
                provider_id: "prov-a".into(),
                mode: IdleWatchMode::Always,
                threshold_minutes: 30,
                created_at_sec: 123,
            }],
        };
        // 只改阈值：计时基线不该被重置成「现在」，否则每次编辑都重新等一整周期
        let cfg = build_config(input(&[("threshold_minutes", "60")]), &existing, NOW).unwrap();
        assert_eq!(cfg.rules[0].threshold_minutes, 60);
        assert_eq!(cfg.rules[0].created_at_sec, 123);
    }

    #[test]
    fn rejects_out_of_range_and_non_numeric_thresholds() {
        for raw in ["0", "-1", "1441", "abc", "2.5", ""] {
            assert!(
                build_config(
                    input(&[("threshold_minutes", raw)]),
                    &IdleWatchConfig::default(),
                    NOW
                )
                .is_err(),
                "阈值 {raw:?} 应被拒绝"
            );
        }
        assert!(
            build_config(
                input(&[("threshold_minutes", "1440")]),
                &IdleWatchConfig::default(),
                NOW
            )
            .is_ok(),
            "上限本身合法"
        );
    }

    #[test]
    fn mode_is_case_tolerant_but_rejects_unknown() {
        assert_eq!(
            build_config(input(&[("mode", "Once")]), &IdleWatchConfig::default(), NOW)
                .unwrap()
                .rules[0]
                .mode,
            IdleWatchMode::Once
        );
        assert!(build_config(
            input(&[("mode", "weekly")]),
            &IdleWatchConfig::default(),
            NOW
        )
        .is_err());
    }

    #[test]
    fn rejects_unknown_or_non_canonical_app_type() {
        assert!(build_config(
            input(&[("app_type", "notion")]),
            &IdleWatchConfig::default(),
            NOW
        )
        .is_err());
        // 认识但写法不规范（下划线别名）也要拒：存进去后按原样查会落到另一个
        // 命名空间，规则会被后台当「渠道已删」清掉。
        assert!(build_config(
            input(&[("app_type", "claude_desktop")]),
            &IdleWatchConfig::default(),
            NOW
        )
        .is_err());
        // claude-desktop 是**认识**的 app_type，但规则挂在它上面永远只会误报（读日志
        // 时 app_type 折叠进 claude，那条规则的「最近成功」恒为空 → 静默时长只涨不
        // 降，到点必提醒，即使用户天天在用）。让它明确失败并指出正确做法。
        assert!(build_config(
            input(&[("app_type", "claude-desktop")]),
            &IdleWatchConfig::default(),
            NOW
        )
        .is_err());
    }

    #[test]
    fn rejects_session_pseudo_channels_and_blanks() {
        assert!(build_config(
            input(&[("provider_id", "_session")]),
            &IdleWatchConfig::default(),
            NOW
        )
        .is_err());
        assert!(build_config(
            input(&[("provider_id", "   ")]),
            &IdleWatchConfig::default(),
            NOW
        )
        .is_err());
    }

    #[test]
    fn rejects_duplicate_channel() {
        let mut cfg = input(&[]);
        cfg.rules.push(IdleWatchRuleInput {
            app_type: "claude".into(),
            provider_id: "prov-a".into(),
            mode: "once".into(),
            threshold_minutes: "5".into(),
        });
        assert!(build_config(cfg, &IdleWatchConfig::default(), NOW).is_err());

        // 换一个渠道就不算重复
        let mut ok = input(&[]);
        ok.rules.push(IdleWatchRuleInput {
            app_type: "codex".into(),
            provider_id: "prov-a".into(),
            mode: "once".into(),
            threshold_minutes: "5".into(),
        });
        let built = build_config(ok, &IdleWatchConfig::default(), NOW).unwrap();
        assert_eq!(built.rules.len(), 2);
    }

    #[test]
    fn clearing_rules_is_legal() {
        let empty = IdleWatchConfigInput {
            enabled: true,
            keepalive_enabled: true,
            rules: Vec::new(),
        };
        let cfg = build_config(empty, &IdleWatchConfig::default(), NOW).unwrap();
        assert!(cfg.rules.is_empty(), "清空规则是合法操作");
        assert!(cfg.keepalive_enabled, "保活开关独立于规则集");
    }
}
