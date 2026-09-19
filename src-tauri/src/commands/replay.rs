//! 请求重放（Replay）相关的 Tauri 命令
//!
//! 把「请求查看器」里抓到的某一条出站请求交给重放器，按频率自动重发直到拿到席位。
//! 实现与状态在 `crate::proxy::replay`，这里只做**配置校验 + 参数转换**：数值一律
//! 由前端传字符串，区间校验集中在本文件（同 AutoFailover 的做法），前端只做同规则
//! 预检——以后端为准，防绕过 UI 直接 invoke 塞进非法值。

use crate::error::AppError;
use crate::proxy::replay::{self, PaceMode, ReplayConfig, ReplayStatus};

/// 查看器条目的重放可用性预检（**只回元信息，不回鉴权头**）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaySnapshotInfo {
    /// 是否可重放
    pub available: bool,
    pub method: String,
    /// 目标 URL 的 origin（不含 path——path 可能内嵌密钥）
    pub target_origin: String,
    pub app_type: String,
    pub provider_id: String,
    pub model: String,
    /// body 字节数
    pub body_len: usize,
    pub header_count: usize,
}

/// 按需读取某条目的快照信息。前端点「重放」时先调它预检：取不到就说明这条
/// 没法重放（旧数据 / body 过大被跳过），据此禁用按钮并说明原因。
///
/// 快照含鉴权头，**刻意不回传头内容**：配置 Dialog 只需让用户确认「打哪儿、多大」。
#[tauri::command]
pub fn get_debug_capture_snapshot(seq: u64) -> Result<ReplaySnapshotInfo, AppError> {
    let Some(snap) = crate::proxy::debug_capture::get_snapshot(seq) else {
        return Ok(ReplaySnapshotInfo {
            available: false,
            method: String::new(),
            target_origin: String::new(),
            app_type: String::new(),
            provider_id: String::new(),
            model: String::new(),
            body_len: 0,
            header_count: 0,
        });
    };
    Ok(ReplaySnapshotInfo {
        available: true,
        method: snap.method,
        target_origin: crate::redact_url_origin_for_log(&snap.url),
        app_type: snap.app_type,
        provider_id: snap.provider_id,
        model: snap.model,
        body_len: snap.body.len(),
        header_count: snap.headers.len(),
    })
}

/// 前端传来的重放配置（数值为字符串，便于输入框直接绑定 + 后端集中校验）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayConfigInput {
    /// `"fixed"` | `"backoff"` | `"burst"`
    pub mode: String,
    pub interval_secs: String,
    pub backoff_start_secs: String,
    /// 百分比整数（200 = ×2）
    pub backoff_mult_percent: String,
    pub backoff_cap_secs: String,
    /// 一轮里连打几次（`burst` 用；轮内退避复用上面三个 backoff 字段）
    pub burst_attempts_per_round: String,
    /// 轮间随机间隔下限秒
    pub burst_round_gap_min_secs: String,
    /// 轮间随机间隔上限秒
    pub burst_round_gap_max_secs: String,
    pub required_consecutive: String,
    /// 逗号分隔状态码，如 `"500"` 或 `"500, 503, 529"`
    pub retryable_statuses: String,
    pub max_attempts: String,
    pub max_duration_minutes: String,
}

/// 区间界限。下限保证不会把用户锁死在「每 0 秒打一次」的洪水里，上限防手滑。
const INTERVAL_MIN: u64 = 1;
const INTERVAL_MAX: u64 = 3600;
const CAP_MIN: u64 = 1;
const CAP_MAX: u64 = 3600;
const BURST_PER_ROUND_MIN: u32 = 1;
const BURST_PER_ROUND_MAX: u32 = 50;
const CONSECUTIVE_MIN: u32 = 1;
const CONSECUTIVE_MAX: u32 = 10;
const MULT_MIN: u32 = 100;
const MULT_MAX: u32 = 1000;
const ATTEMPTS_MIN: u32 = 1;
const ATTEMPTS_MAX: u32 = 100_000;
const DURATION_MIN: u64 = 1;
const DURATION_MAX: u64 = 1440;

/// 解析一个整数并夹到区间外时报错（不静默夹：静默改用户填的值更容易踩坑）。
fn parse_int(field: &str, raw: &str, min: u64, max: u64) -> Result<u64, AppError> {
    let trimmed = raw.trim();
    let value: i64 = trimmed
        .parse()
        .map_err(|_| AppError::InvalidInput(format!("{field} 必须是整数（当前: {raw}）")))?;
    if value < min as i64 || value > max as i64 {
        return Err(AppError::InvalidInput(format!(
            "{field} 需在 {min}~{max} 之间（当前: {value}）"
        )));
    }
    Ok(value as u64)
}

/// 校验并转成引擎配置。
///
/// 数值**不分模式**一律解析并校验区间（与既有做法一致：`fixed` 模式也一样校验退避
/// 三件套）。好处是校验规则只有一条「这份配置本身合法」，不会随模式切换而变——用户
/// 在 burst 里填了倒置的轮间上下限，切回 fixed 保存就该同样被拦下，而不是「切回固定
/// 间隔之后非法值又合法了」。
fn build_config(input: ReplayConfigInput) -> Result<ReplayConfig, AppError> {
    let mode = match input.mode.trim().to_ascii_lowercase().as_str() {
        "fixed" => PaceMode::Fixed,
        "backoff" => PaceMode::Backoff,
        "burst" => PaceMode::Burst,
        other => {
            return Err(AppError::InvalidInput(format!(
                "未知节奏模式: {other}（应为 fixed、backoff 或 burst）"
            )))
        }
    };

    let interval_secs = parse_int("间隔秒数", &input.interval_secs, INTERVAL_MIN, INTERVAL_MAX)?;
    let backoff_start_secs = parse_int(
        "退避起始秒数",
        &input.backoff_start_secs,
        INTERVAL_MIN,
        INTERVAL_MAX,
    )?;
    let backoff_cap_secs = parse_int("退避封顶秒数", &input.backoff_cap_secs, CAP_MIN, CAP_MAX)?;
    let backoff_mult_percent = parse_int(
        "退避倍数(%)",
        &input.backoff_mult_percent,
        MULT_MIN as u64,
        MULT_MAX as u64,
    )? as u32;
    let burst_attempts_per_round = parse_int(
        "每轮次数",
        &input.burst_attempts_per_round,
        BURST_PER_ROUND_MIN as u64,
        BURST_PER_ROUND_MAX as u64,
    )? as u32;
    let burst_round_gap_min_secs = parse_int(
        "轮间最小秒数",
        &input.burst_round_gap_min_secs,
        INTERVAL_MIN,
        INTERVAL_MAX,
    )?;
    let burst_round_gap_max_secs = parse_int(
        "轮间最大秒数",
        &input.burst_round_gap_max_secs,
        INTERVAL_MIN,
        INTERVAL_MAX,
    )?;
    // 倒置要**明确拒绝**，不静默交换、也不静默按下限：静默改用户填的数字，比报个错
    // 更容易踩坑（与 parse_int 同一立场）。引擎侧另有一层兜底，见 delay_after_with。
    if burst_round_gap_min_secs > burst_round_gap_max_secs {
        return Err(AppError::InvalidInput(format!(
            "轮间最小秒数不能大于最大秒数（当前: {burst_round_gap_min_secs} > {burst_round_gap_max_secs}）"
        )));
    }
    let required_consecutive = parse_int(
        "连续成功次数",
        &input.required_consecutive,
        CONSECUTIVE_MIN as u64,
        CONSECUTIVE_MAX as u64,
    )? as u32;
    let max_attempts = parse_int(
        "最大次数",
        &input.max_attempts,
        ATTEMPTS_MIN as u64,
        ATTEMPTS_MAX as u64,
    )? as u32;
    let max_duration_minutes = parse_int(
        "最长时长(分钟)",
        &input.max_duration_minutes,
        DURATION_MIN,
        DURATION_MAX,
    )?;

    // 可重试状态码：空串 = 空集合（一切都不重试，等价于「只跑一次」）；
    // 非法项直接报错，不静默丢掉——用户填 50x 少打个 0 时静默丢会导致行为与预期不符。
    let mut retryable_statuses: Vec<u16> = Vec::new();
    for part in input.retryable_statuses.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let code: u16 = part.parse().map_err(|_| {
            AppError::InvalidInput(format!(
                "可重试状态码必须是 100~599 的整数（当前项: {part}）"
            ))
        })?;
        if !(100..600).contains(&code) {
            return Err(AppError::InvalidInput(format!(
                "可重试状态码需在 100~599 之间（当前项: {code}）"
            )));
        }
        if !retryable_statuses.contains(&code) {
            retryable_statuses.push(code);
        }
    }

    Ok(ReplayConfig {
        mode,
        interval_secs,
        backoff_start_secs,
        backoff_mult_percent,
        backoff_cap_secs,
        burst_attempts_per_round,
        burst_round_gap_min_secs,
        burst_round_gap_max_secs,
        required_consecutive,
        retryable_statuses,
        max_attempts,
        max_duration_minutes,
    })
}

/// 启动重放。快照缺失或已有任务在跑时返回 Err。
#[tauri::command]
pub fn start_replay(
    app: tauri::AppHandle,
    snapshot_seq: u64,
    config: ReplayConfigInput,
) -> Result<ReplayStatus, AppError> {
    let cfg = build_config(config)?;
    replay::start(&app, snapshot_seq, cfg).map_err(AppError::InvalidInput)
}

/// 请求停止（异步生效：间隔期内立刻退出，正在飞的那个请求跑完后落终态）。
#[tauri::command]
pub fn stop_replay() -> Option<ReplayStatus> {
    replay::stop()
}

/// 读取当前/上一次重放状态（面板重挂载时补进度用）。
#[tauri::command]
pub fn get_replay_status() -> Option<ReplayStatus> {
    replay::status()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(overrides: &[(&str, &str)]) -> ReplayConfigInput {
        let mut input = ReplayConfigInput {
            mode: "fixed".into(),
            interval_secs: "3".into(),
            backoff_start_secs: "2".into(),
            backoff_mult_percent: "200".into(),
            backoff_cap_secs: "30".into(),
            burst_attempts_per_round: "5".into(),
            burst_round_gap_min_secs: "30".into(),
            burst_round_gap_max_secs: "180".into(),
            required_consecutive: "1".into(),
            retryable_statuses: "500".into(),
            max_attempts: "500".into(),
            max_duration_minutes: "60".into(),
        };
        for (key, value) in overrides {
            match *key {
                "mode" => input.mode = (*value).into(),
                "interval_secs" => input.interval_secs = (*value).into(),
                "backoff_start_secs" => input.backoff_start_secs = (*value).into(),
                "backoff_mult_percent" => input.backoff_mult_percent = (*value).into(),
                "backoff_cap_secs" => input.backoff_cap_secs = (*value).into(),
                "burst_attempts_per_round" => input.burst_attempts_per_round = (*value).into(),
                "burst_round_gap_min_secs" => input.burst_round_gap_min_secs = (*value).into(),
                "burst_round_gap_max_secs" => input.burst_round_gap_max_secs = (*value).into(),
                "required_consecutive" => input.required_consecutive = (*value).into(),
                "retryable_statuses" => input.retryable_statuses = (*value).into(),
                "max_attempts" => input.max_attempts = (*value).into(),
                "max_duration_minutes" => input.max_duration_minutes = (*value).into(),
                other => panic!("unknown field {other}"),
            }
        }
        input
    }

    #[test]
    fn defaults_parse_into_engine_config() {
        let cfg = build_config(input(&[])).expect("默认值应通过校验");
        assert_eq!(cfg.mode, PaceMode::Fixed);
        assert_eq!(cfg.interval_secs, 3);
        assert_eq!(cfg.retryable_statuses, vec![500]);
        assert_eq!(cfg.required_consecutive, 1);
        assert_eq!(cfg.max_attempts, 500);
        assert_eq!(cfg.max_duration_minutes, 60);
        // burst 三件套即使当前模式用不到也要解析出来（校验规则不随模式切换而变）
        assert_eq!(cfg.burst_attempts_per_round, 5);
        assert_eq!(cfg.burst_round_gap_min_secs, 30);
        assert_eq!(cfg.burst_round_gap_max_secs, 180);
    }

    #[test]
    fn burst_mode_parses() {
        let cfg = build_config(input(&[("mode", " Burst ")])).expect("burst 是合法模式");
        assert_eq!(cfg.mode, PaceMode::Burst);
    }

    #[test]
    fn rejects_inverted_round_gap_rather_than_swapping_it() {
        // 静默交换=后端偷偷改用户填的数字；报错才讲得清到底填了什么
        assert!(build_config(input(&[
            ("burst_round_gap_min_secs", "180"),
            ("burst_round_gap_max_secs", "30"),
        ]))
        .is_err());
        // 相等是合法的（等于固定间隔，只是没有抖动）
        assert!(build_config(input(&[
            ("burst_round_gap_min_secs", "60"),
            ("burst_round_gap_max_secs", "60"),
        ]))
        .is_ok());
    }

    #[test]
    fn rejects_out_of_range_burst_fields() {
        assert!(build_config(input(&[("burst_attempts_per_round", "0")])).is_err());
        assert!(build_config(input(&[("burst_attempts_per_round", "51")])).is_err());
        assert!(build_config(input(&[("burst_round_gap_min_secs", "0")])).is_err());
        assert!(build_config(input(&[("burst_round_gap_max_secs", "3601")])).is_err());
        assert!(build_config(input(&[("burst_attempts_per_round", "abc")])).is_err());
        // 边界本身合法
        assert!(build_config(input(&[("burst_attempts_per_round", "50")])).is_ok());
    }

    #[test]
    fn rejects_out_of_range_and_non_numeric() {
        assert!(
            build_config(input(&[("interval_secs", "0")])).is_err(),
            "下限 1"
        );
        assert!(build_config(input(&[("interval_secs", "3601")])).is_err());
        assert!(build_config(input(&[("interval_secs", "abc")])).is_err());
        assert!(build_config(input(&[("interval_secs", "2.5")])).is_err());
        assert!(build_config(input(&[("required_consecutive", "11")])).is_err());
        assert!(build_config(input(&[("max_duration_minutes", "1441")])).is_err());
        assert!(build_config(input(&[("mode", "hourly")])).is_err());
    }

    #[test]
    fn trims_and_dedupes_retryable_statuses() {
        let cfg = build_config(input(&[("retryable_statuses", " 500, 500 ,529,")]))
            .expect("空白与尾逗号应被容忍");
        assert_eq!(cfg.retryable_statuses, vec![500, 529]);
    }

    #[test]
    fn rejects_invalid_status_codes_loudly() {
        // 手滑写 "50" 必须报错，而不是静默丢掉这一项
        assert!(build_config(input(&[("retryable_statuses", "500,50")])).is_err());
        assert!(build_config(input(&[("retryable_statuses", "500,600")])).is_err());
        assert!(build_config(input(&[("retryable_statuses", "five")])).is_err());
    }

    #[test]
    fn empty_retryable_means_nothing_retries() {
        let cfg = build_config(input(&[("retryable_statuses", "")])).expect("空串合法");
        assert!(cfg.retryable_statuses.is_empty());
    }

    #[test]
    fn negative_is_rejected() {
        assert!(build_config(input(&[("max_attempts", "-1")])).is_err());
    }
}
