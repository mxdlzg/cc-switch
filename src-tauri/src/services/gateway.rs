//! 本地网关（Local Gateway）模块
//!
//! 在本地路由服务之上额外暴露一组 `/gateway/*` 端点，供**非 cc-switch 管理**的
//! 第三方工具接入。与「接管」的关键区别：
//!
//! - **不改写任何 CLI 的 Live 配置文件**，也不产生 `proxy_live_backup` 备份行；
//! - 每个 namespace 各自选一种路由**模式**（引用首页已有的供应商卡片，而非复制一份）：
//!   - **model 模式**（缺省）：持有一张 **model → provider 目录**，请求命中目录才
//!     路由到该 model 指定的 provider，未命中直接 404（空目录 = 全部 404）；
//!   - **provider 模式**：整条 namespace 流量透传给一个默认供应商，不查目录、不 404，
//!     模型名原样送达上游。
//!   切模式不会销毁另一模式的配置（目录在 provider 模式下只是不被读取）。
//! - 访问必须携带 `Authorization: Bearer <token>`（常数时间比较）。
//!
//! 网关请求使用 provider **自身**的 `app_type` 作为 `app_type_str`（而非 "gateway"）：
//! `provider_health` 对 `providers(id, app_type)` 有外键且
//! `PRAGMA foreign_keys = ON`（见 `database/mod.rs`），伪造 app_type 会导致插入失败。

use crate::app_config::AppType;
use crate::database::Database;
use crate::error::AppError;
use crate::provider::Provider;
use serde::{Deserialize, Serialize};

/// 网关访问令牌的存储键（DB `settings` 表）。
const GATEWAY_TOKEN_SETTING_KEY: &str = "gateway_token";

/// 网关总开关的存储键。缺省（未写入）视为启用——用户正是冲这个功能来的，
/// 且网关不改写任何 CLI 文件，默认开无副作用；要关在设置页关掉即可。
const GATEWAY_ENABLED_SETTING_KEY: &str = "gateway_enabled";

/// 某个 namespace 的模型目录，存储键前缀。完整键形如
/// `gateway_catalog_claude`，值为 `Vec<GatewayCatalogEntry>` 的 JSON。
const GATEWAY_CATALOG_SETTING_PREFIX: &str = "gateway_catalog_";

/// 某个 namespace 的路由模式，存储键前缀。完整键形如 `gateway_mode_claude`，
/// 值为 `GatewayMode` 的字面量（`"model"` / `"provider"`）。
const GATEWAY_MODE_SETTING_PREFIX: &str = "gateway_mode_";

/// provider 模式下该 namespace 的默认供应商 id，存储键前缀。完整键形如
/// `gateway_default_provider_claude`。仅在 provider 模式下被读取。
const GATEWAY_DEFAULT_PROVIDER_SETTING_PREFIX: &str = "gateway_default_provider_";

/// 单个 namespace 的路由模式。
///
/// 决定 `/gateway/<ns>` 的请求怎么选 provider，**每个 namespace 各自独立**：
/// - [`GatewayMode::Model`]（缺省）：按模型目录精确路由，未命中 404。
/// - [`GatewayMode::Provider`]：整条流量透传给一个默认供应商，不查目录、不 404，
///   且模型名原样送达上游（网关流量本就跳过模型映射）。
///
/// 缺省 Model 让老库（无此键）沿用现有严格目录语义，升级零行为变化。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GatewayMode {
    /// 按模型目录路由（缺省）。
    #[default]
    Model,
    /// 全部路由到默认供应商。
    Provider,
}

impl GatewayMode {
    /// 存储用的字面量（与 serde 表示一致，避免两处各写一份字符串）。
    fn as_str(self) -> &'static str {
        match self {
            GatewayMode::Model => "model",
            GatewayMode::Provider => "provider",
        }
    }

    /// 解析存储值。未识别的值（手改库、旧版本写入）按缺省 Model 处理并记日志——
    /// 退回严格模式是安全侧：最坏是 404，不会把流量意外发给某个供应商。
    fn parse(raw: &str) -> Self {
        match raw.trim() {
            "provider" => GatewayMode::Provider,
            "" | "model" => GatewayMode::Model,
            other => {
                log::warn!("[Gateway] 未识别的网关模式 {other:?}，按 model 模式处理");
                GatewayMode::Model
            }
        }
    }
}

/// 网关可暴露的 namespace（协议方言）。
///
/// 每个 namespace 对应一类客户端方言，且其目录里引用的 provider 必须属于同名
/// app_type，这样 `app_type_str`、熔断器 key、`provider_health` 外键、session
/// 方言、`proxy_config` 行全部沿用现有约定，无需新增 schema。
pub const GATEWAY_NAMESPACES: [AppType; 4] = [
    AppType::Claude,
    AppType::Codex,
    AppType::Gemini,
    AppType::GrokBuild,
];

/// 目录里的一条记录：客户端可见的 model id → 处理它的 provider。
///
/// 一个 model 恰好对一个 provider（v1 不做 model 内多 provider 故障转移）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayCatalogEntry {
    /// 客户端请求里出现的模型名（原样匹配，不做别名/大小写归一）
    pub model: String,
    /// 命中该 model 时路由到的 provider id（必须属于同一 namespace）
    pub provider_id: String,
}

/// 校验 namespace 字符串是否为受支持的网关 namespace。
pub fn parse_gateway_namespace(raw: &str) -> Result<AppType, AppError> {
    let app_type = GATEWAY_NAMESPACES
        .iter()
        .find(|app_type| app_type.as_str() == raw)
        .cloned()
        .ok_or_else(|| {
            AppError::localized(
                "gateway.namespace.unsupported",
                "不支持的网关命名空间",
                "Unsupported gateway namespace",
            )
        })?;
    Ok(app_type)
}

fn catalog_setting_key(namespace: &str) -> String {
    format!("{GATEWAY_CATALOG_SETTING_PREFIX}{namespace}")
}

fn mode_setting_key(namespace: &str) -> String {
    format!("{GATEWAY_MODE_SETTING_PREFIX}{namespace}")
}

fn default_provider_setting_key(namespace: &str) -> String {
    format!("{GATEWAY_DEFAULT_PROVIDER_SETTING_PREFIX}{namespace}")
}

/// 网关是否启用。缺省（未写入 / 空值）视为启用。
pub fn is_gateway_enabled(db: &Database) -> Result<bool, AppError> {
    Ok(match db.get_setting(GATEWAY_ENABLED_SETTING_KEY)? {
        Some(raw) => !matches!(raw.trim(), "false" | "0"),
        None => true,
    })
}

/// 设置网关总开关。
pub fn set_gateway_enabled(db: &Database, enabled: bool) -> Result<(), AppError> {
    db.set_setting(
        GATEWAY_ENABLED_SETTING_KEY,
        if enabled { "true" } else { "false" },
    )
}

/// 生成（或读取已存在的）网关访问令牌。
///
/// 形状与 Claude Desktop gateway 的令牌一致（`ccs-<uuid simple>`），但是**独立一把**，
/// 轮换互不影响。
pub fn get_or_create_gateway_token(db: &Database) -> Result<String, AppError> {
    if let Some(token) = db.get_setting(GATEWAY_TOKEN_SETTING_KEY)? {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    let token = format!("ccs-{}", uuid::Uuid::new_v4().simple());
    db.set_setting(GATEWAY_TOKEN_SETTING_KEY, &token)?;
    Ok(token)
}

/// 重新生成网关访问令牌，返回新令牌。
///
/// 旧令牌立即失效（单值覆盖，不做双令牌过渡）。
pub fn rotate_gateway_token(db: &Database) -> Result<String, AppError> {
    let token = format!("ccs-{}", uuid::Uuid::new_v4().simple());
    db.set_setting(GATEWAY_TOKEN_SETTING_KEY, &token)?;
    Ok(token)
}

/// 令牌允许长度（trim 后）。下限防空串，上限防误粘贴整篇文本塞满 `settings`。
const GATEWAY_TOKEN_MIN_LEN: usize = 8;
const GATEWAY_TOKEN_MAX_LEN: usize = 256;

/// 校验用户自定义令牌，返回 trim 后的可用值。
///
/// 令牌会原样放进 `Authorization: Bearer <token>` 由第三方发送，故只允许
/// HTTP header 安全的可见 ASCII（0x21..=0x7E，即空格 0x20 与 DEL 0x7F 之外的可打印
/// 字符）。放空格会让 Bearer 解析歧义、放控制字符/非 ASCII 会让 header 非法或被
/// 网关截断——严格校验胜过「存进去再 401 排查半天」。长度亦有上下限。
fn validate_gateway_token(raw: &str) -> Result<String, AppError> {
    let token = raw.trim();
    if token.is_empty() {
        return Err(AppError::localized(
            "gateway.token.empty",
            "令牌不能为空",
            "Token cannot be empty",
        ));
    }
    if !token.bytes().all(|b| (0x21..=0x7E).contains(&b)) {
        return Err(AppError::localized(
            "gateway.token.invalid_chars",
            "令牌只能包含可见 ASCII 字符（不含空格），不支持中文或表情",
            "Token may only contain printable ASCII (no spaces); no CJK or emoji",
        ));
    }
    let len = token.chars().count();
    if !(GATEWAY_TOKEN_MIN_LEN..=GATEWAY_TOKEN_MAX_LEN).contains(&len) {
        return Err(AppError::localized(
            "gateway.token.bad_length",
            format!("令牌长度需为 {GATEWAY_TOKEN_MIN_LEN}-{GATEWAY_TOKEN_MAX_LEN} 个字符"),
            format!(
                "Token length must be {GATEWAY_TOKEN_MIN_LEN}-{GATEWAY_TOKEN_MAX_LEN} characters"
            ),
        ));
    }
    Ok(token.to_string())
}

/// 设置用户自定义访问令牌，返回生效后的令牌。
///
/// 与 `rotate` 同为单值覆盖：新令牌立即生效，旧令牌立刻失效（无过渡）。
/// 校验见 `validate_gateway_token`——比自动生成更严，因为用户手输易带空格/中文。
pub fn set_gateway_token(db: &Database, raw: &str) -> Result<String, AppError> {
    let token = validate_gateway_token(raw)?;
    db.set_setting(GATEWAY_TOKEN_SETTING_KEY, &token)?;
    Ok(token)
}

/// 读取某个 namespace 的模型目录。未配置（键不存在）视为空目录。
///
/// 存储损坏（非法 JSON）时报错而非静默清空——静默清空会让整个 namespace 变 404，
/// 用户看不出原因。
pub fn get_gateway_catalog(
    db: &Database,
    namespace: &AppType,
) -> Result<Vec<GatewayCatalogEntry>, AppError> {
    let Some(raw) = db.get_setting(&catalog_setting_key(namespace.as_str()))? else {
        return Ok(Vec::new());
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str::<Vec<GatewayCatalogEntry>>(raw).map_err(|e| {
        log::warn!(
            "[Gateway] 解析 {} 失败: {e}",
            catalog_setting_key(namespace.as_str())
        );
        AppError::localized(
            "gateway.catalog.corrupt",
            "网关模型目录数据损坏",
            "Gateway model catalog data is corrupt",
        )
    })
}

/// 覆盖写入某个 namespace 的模型目录。
///
/// 写入前逐条校验：provider 必须属于该 namespace（与 v1 单值选择同一约束，防止
/// 越界引用别的 app 的卡片），model 不能为空。空列表合法（= 清空目录 → 该
/// namespace 全部 404）。model 去重，保留首次出现的一条。
pub fn set_gateway_catalog(
    db: &Database,
    namespace: &str,
    entries: &[GatewayCatalogEntry],
) -> Result<(), AppError> {
    let namespace = parse_gateway_namespace(namespace)?;

    let mut seen: Vec<&str> = Vec::with_capacity(entries.len());
    for entry in entries {
        let model = entry.model.trim();
        if model.is_empty() {
            return Err(AppError::localized(
                "gateway.catalog.model_empty",
                "模型名不能为空",
                "Model name must not be empty",
            ));
        }
        if seen.contains(&model) {
            return Err(AppError::localized(
                "gateway.catalog.duplicate_model",
                "模型名重复",
                "Duplicate model name in catalog",
            ));
        }
        if db
            .get_provider_by_id(&entry.provider_id, namespace.as_str())?
            .is_none()
        {
            return Err(AppError::localized(
                "gateway.provider.not_found",
                "该供应商不属于此网关命名空间",
                "Provider does not belong to this gateway namespace",
            ));
        }
        seen.push(model);
    }

    let json = serde_json::to_string(entries)
        .map_err(|e| AppError::Message(format!("序列化网关目录失败: {e}")))?;
    db.set_setting(&catalog_setting_key(namespace.as_str()), &json)
}

/// 按请求模型在目录里查该路由到哪个 provider。
///
/// 未命中（目录为空或没有这个 model）返回 `Ok(None)`——调用方据此返回 404，
/// **绝不**静默回落到该 app 的当前供应商：网关的语义就是"暴露哪些模型
/// 由目录说了算"。命中但 provider 已被删除，同样返回 `Ok(None)`（陈旧条目
/// 等同未配置，不该 500）。
pub fn resolve_gateway_provider(
    db: &Database,
    namespace: &AppType,
    model: &str,
) -> Result<Option<Provider>, AppError> {
    let catalog = get_gateway_catalog(db, namespace)?;
    // 原样匹配（不做大小写 / [1M] 归一）：目录里写的就是客户端该发的名字。
    let Some(entry) = catalog.iter().find(|e| e.model == model) else {
        return Ok(None);
    };
    db.get_provider_by_id(&entry.provider_id, namespace.as_str())
}

/// 读取某个 namespace 的路由模式。缺省（键不存在 / 空值）为 [`GatewayMode::Model`]。
pub fn get_gateway_mode(db: &Database, namespace: &AppType) -> Result<GatewayMode, AppError> {
    Ok(
        match db.get_setting(&mode_setting_key(namespace.as_str()))? {
            Some(raw) => GatewayMode::parse(&raw),
            None => GatewayMode::Model,
        },
    )
}

/// 读取 provider 模式下该 namespace 的默认供应商。
///
/// 未配置（键为空）或供应商已被删除都返回 `Ok(None)`——调用方据此返回 404，
/// 与 model 模式「陈旧条目等同未配置」一致，不 500、不回落首页当前供应商。
pub fn get_gateway_default_provider(
    db: &Database,
    namespace: &AppType,
) -> Result<Option<Provider>, AppError> {
    let Some(raw) = db.get_setting(&default_provider_setting_key(namespace.as_str()))? else {
        return Ok(None);
    };
    let id = raw.trim();
    if id.is_empty() {
        return Ok(None);
    }
    db.get_provider_by_id(id, namespace.as_str())
}

/// 设置某个 namespace 的路由模式与（provider 模式下的）默认供应商。
///
/// 切到 provider 模式**必须**给一个属于该 namespace 的 provider（校验同目录写入）；
/// 切到 model 模式则清空默认供应商键，但**绝不动目录**——目录只在 model 模式被读取，
/// 切回时原样恢复。
pub fn set_gateway_namespace_mode(
    db: &Database,
    namespace: &str,
    mode: GatewayMode,
    default_provider_id: Option<&str>,
) -> Result<(), AppError> {
    let namespace = parse_gateway_namespace(namespace)?;
    let key = default_provider_setting_key(namespace.as_str());

    match mode {
        GatewayMode::Model => {
            db.set_setting(
                &mode_setting_key(namespace.as_str()),
                GatewayMode::Model.as_str(),
            )?;
            // 清掉默认供应商（写空串 = 未配置，见 get_gateway_default_provider）。
            db.set_setting(&key, "")
        }
        GatewayMode::Provider => {
            let id = default_provider_id.map(str::trim).filter(|s| !s.is_empty());
            let Some(id) = id else {
                return Err(AppError::localized(
                    "gateway.provider.required",
                    "provider 模式需要选择一个默认供应商",
                    "Provider mode requires a default provider",
                ));
            };
            if db.get_provider_by_id(id, namespace.as_str())?.is_none() {
                return Err(AppError::localized(
                    "gateway.provider.not_found",
                    "该供应商不属于此网关命名空间",
                    "Provider does not belong to this gateway namespace",
                ));
            }
            db.set_setting(&key, id)?;
            db.set_setting(
                &mode_setting_key(namespace.as_str()),
                GatewayMode::Provider.as_str(),
            )
        }
    }
}

/// provider 模式下实时拉上游模型列表所需的静态参数（`/models` 端点与设置页共用）。
///
/// 只含**同步可得**的信息：provider 查找、base URL、静态 key、方言标记。真正的
/// 网络请求 `fetch_models` 是 async，留在调用方 await——这样同一条链路既能被
/// Tauri 命令（`spawn_blocking`）用，也能被 axum handler 用，阻塞段不会卡住
/// async 运行时。
pub struct UpstreamModelsRequest {
    pub base_url: String,
    pub api_key: String,
    /// 传给 `model_fetch::fetch_models` 的 `api_format`；None = 该鉴权方式无法静态拉取。
    pub api_format: Option<&'static str>,
}

/// 同步准备 provider 模式 `/models` 的请求参数（可能阻塞读库，调用方按需
/// `spawn_blocking`）。动态 token 类鉴权（Copilot / 各家 OAuth）返回 Err——
/// 调用方据此回落到空列表 / 手动输入。
pub fn prepare_upstream_models(
    db: &Database,
    namespace: &AppType,
    provider_id: &str,
) -> Result<UpstreamModelsRequest, String> {
    use crate::proxy::providers::{get_adapter, AuthStrategy};

    let provider = db
        .get_provider_by_id(provider_id, namespace.as_str())
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "供应商不存在或不属于该命名空间".to_string())?;

    let adapter = get_adapter(namespace).ok_or_else(|| "该命名空间无适配器".to_string())?;
    let base_url = adapter
        .extract_base_url(&provider)
        .map_err(|e| e.to_string())?;
    let auth = adapter
        .extract_auth(&provider)
        .ok_or_else(|| "供应商未配置可用的密钥".to_string())?;

    // 静态 key 才能直接拉 /models；动态 token 类鉴权交回调用方处理。
    let api_format = match auth.strategy {
        AuthStrategy::Anthropic => Some("anthropic-messages"),
        AuthStrategy::Google => Some("google-generative-ai"),
        AuthStrategy::ClaudeAuth | AuthStrategy::Bearer => None,
        other => {
            return Err(format!(
                "该供应商使用 {other:?} 鉴权（需动态取 token），无法拉取模型列表"
            ))
        }
    };
    Ok(UpstreamModelsRequest {
        base_url,
        api_key: auth.api_key,
        api_format,
    })
}

/// 单个 namespace 的前端视图。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayNamespaceInfo {
    /// namespace 字符串（同 app_type_str，如 "claude"）
    pub namespace: String,
    /// URL 前缀（如 "/gateway/claude"）
    pub path_prefix: String,
    /// 该 namespace 的路由模式（model 目录 / provider 透传）
    pub mode: GatewayMode,
    /// provider 模式下的默认供应商 id（model 模式或未配置为 None）
    pub default_provider_id: Option<String>,
    /// 该 namespace 的模型目录（model 模式下：空 = 该端点所有请求 404）
    pub catalog: Vec<GatewayCatalogEntry>,
}

/// 该 namespace 的 URL 前缀。与 `server.rs::build_router` 注册的路由保持一致。
pub fn gateway_path_prefix(namespace: &str) -> String {
    format!("/gateway/{namespace}")
}

/// 网关整体信息，供设置页展示。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayInfo {
    /// 网关总开关。为 false 时 `/gateway/*` 一律返回 401（见 `validate_gateway_auth`）。
    pub enabled: bool,
    /// 访问令牌明文。仅本机 UI 可读（Tauri command 不出本机），
    /// 便于用户复制到第三方工具。
    pub token: String,
    pub namespaces: Vec<GatewayNamespaceInfo>,
}

/// 汇总网关信息。
pub fn get_gateway_info(db: &Database) -> Result<GatewayInfo, AppError> {
    let token = get_or_create_gateway_token(db)?;
    let enabled = is_gateway_enabled(db)?;
    let mut namespaces = Vec::with_capacity(GATEWAY_NAMESPACES.len());

    for namespace in GATEWAY_NAMESPACES {
        let catalog = get_gateway_catalog(db, &namespace)?;
        let mode = get_gateway_mode(db, &namespace)?;
        // 默认供应商只在 provider 模式下有意义；model 模式一律报 None，免得前端
        // 在两种模式间显示同一个残留值。
        let default_provider_id = match mode {
            GatewayMode::Provider => db
                .get_setting(&default_provider_setting_key(namespace.as_str()))?
                .map(|raw| raw.trim().to_string())
                .filter(|id| !id.is_empty()),
            GatewayMode::Model => None,
        };
        namespaces.push(GatewayNamespaceInfo {
            namespace: namespace.as_str().to_string(),
            path_prefix: gateway_path_prefix(namespace.as_str()),
            mode,
            default_provider_id,
            catalog,
        });
    }

    Ok(GatewayInfo {
        enabled,
        token,
        namespaces,
    })
}

/// 常数时间字符串比较，避免令牌比对产生计时侧信道。
///
/// 长度不等时直接返回 false —— 长度本身不是秘密（令牌格式固定为
/// `ccs-` + 32 hex），因此这一步的提前返回不构成可利用的信息泄露。
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (left, right) in a.bytes().zip(b.bytes()) {
        diff |= left ^ right;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_eq_matches_equality() {
        assert!(constant_time_eq("", ""));
        assert!(constant_time_eq("ccs-abc", "ccs-abc"));
        assert!(!constant_time_eq("ccs-abc", "ccs-abd"));
        assert!(!constant_time_eq("ccs-abc", "ccs-ab"));
        assert!(!constant_time_eq("ccs-abc", "ccs-abcd"));
    }

    #[test]
    fn constant_time_eq_is_order_independent() {
        // 差异位置不同不应影响结果（同一处差异，前后交换）。
        assert_eq!(
            constant_time_eq("aaaaX", "aaaaY"),
            constant_time_eq("Xaaaa", "Yaaaa")
        );
    }

    #[test]
    fn validate_gateway_token_accepts_printable_ascii_and_trims() {
        // 合法：可见 ASCII，两端空白应被 trim 掉后原样返回。
        assert_eq!(
            validate_gateway_token("  my-secret-token_1  ").unwrap(),
            "my-secret-token_1"
        );
        assert!(validate_gateway_token("ccs-abcdefghijklmnop").is_ok());
    }

    #[test]
    fn validate_gateway_token_rejects_bad_input() {
        // 空 / 全空白。
        assert!(validate_gateway_token("").is_err());
        assert!(validate_gateway_token("    ").is_err());
        // 含空格（Bearer 解析会歧义）。
        assert!(validate_gateway_token("abc defghijkl").is_err());
        // 非 ASCII（中文 / 表情）。
        assert!(validate_gateway_token("令牌token123456").is_err());
        assert!(validate_gateway_token("token😀abc12345").is_err());
        // 控制字符（0x21 之下）。
        assert!(validate_gateway_token("tok\nen12345678").is_err());
        // 长度界限（下限 8，上限 256）。
        assert!(validate_gateway_token("short7").is_err());
        assert!(validate_gateway_token(&"a".repeat(7)).is_err());
        assert!(validate_gateway_token(&"a".repeat(8)).is_ok());
        assert!(validate_gateway_token(&"a".repeat(256)).is_ok());
        assert!(validate_gateway_token(&"a".repeat(257)).is_err());
    }

    #[test]
    fn namespace_parsing_accepts_only_proxy_apps() {
        assert_eq!(parse_gateway_namespace("claude").unwrap(), AppType::Claude);
        assert_eq!(
            parse_gateway_namespace("grokbuild").unwrap(),
            AppType::GrokBuild
        );
        // claude-desktop 有自己的 /claude-desktop 路由与令牌，不在网关范围内。
        assert!(parse_gateway_namespace("claude-desktop").is_err());
        // 非接管类应用没有 provider 语义下的网关方言。
        assert!(parse_gateway_namespace("opencode").is_err());
        assert!(parse_gateway_namespace("").is_err());
    }

    #[test]
    fn every_gateway_namespace_supports_local_proxy() {
        // 前提：网关复用接管类应用的 provider/adapter 语义。
        for namespace in GATEWAY_NAMESPACES {
            assert!(
                namespace.supports_local_proxy(),
                "{} 不应作为网关命名空间",
                namespace.as_str()
            );
        }
    }

    #[test]
    fn path_prefix_matches_router_routes() {
        assert_eq!(gateway_path_prefix("claude"), "/gateway/claude");
    }

    #[test]
    fn catalog_setting_key_is_namespace_scoped() {
        assert_eq!(catalog_setting_key("claude"), "gateway_catalog_claude");
        assert_ne!(catalog_setting_key("claude"), catalog_setting_key("codex"));
    }

    #[test]
    fn catalog_entry_serde_uses_camel_case_provider_id() {
        // 前端类型依赖 `providerId` 这个键名，序列化形状不能漂。
        let json = r#"[{"model":"claude-opus-4-1","providerId":"p-1"}]"#;
        let parsed: Vec<GatewayCatalogEntry> = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].model, "claude-opus-4-1");
        assert_eq!(parsed[0].provider_id, "p-1");

        let round = serde_json::to_string(&parsed).unwrap();
        assert_eq!(round, json);
    }

    #[test]
    fn gateway_mode_parse_defaults_unknown_to_model() {
        assert_eq!(GatewayMode::parse(""), GatewayMode::Model);
        assert_eq!(GatewayMode::parse("model"), GatewayMode::Model);
        assert_eq!(GatewayMode::parse("provider"), GatewayMode::Provider);
        // 未识别值退回严格模式（安全侧：最坏 404，不会把流量发给某供应商）。
        assert_eq!(GatewayMode::parse("garbage"), GatewayMode::Model);
    }

    #[test]
    fn mode_and_default_provider_keys_are_namespace_scoped() {
        assert_eq!(mode_setting_key("claude"), "gateway_mode_claude");
        assert_ne!(mode_setting_key("claude"), mode_setting_key("codex"));
        assert_eq!(
            default_provider_setting_key("claude"),
            "gateway_default_provider_claude"
        );
        assert_ne!(
            default_provider_setting_key("claude"),
            default_provider_setting_key("gemini")
        );
    }

    fn seed_provider(db: &Database, app_type: &str, id: &str) {
        let provider =
            Provider::with_id(id.to_string(), id.to_string(), serde_json::json!({}), None);
        db.save_provider(app_type, &provider)
            .expect("seed provider");
    }

    #[test]
    fn gateway_mode_defaults_to_model_on_fresh_db() {
        let db = Database::memory().expect("memory db");
        // 老库无该键：必须读成 Model（缺省），保证升级零行为变化。
        let mode = get_gateway_mode(&db, &AppType::Claude).unwrap();
        assert_eq!(mode, GatewayMode::Model);
        let provider = get_gateway_default_provider(&db, &AppType::Claude).unwrap();
        assert!(provider.is_none());
    }

    #[test]
    fn provider_mode_requires_a_provider_owned_by_the_namespace() {
        let db = Database::memory().expect("memory db");
        seed_provider(&db, "claude", "p1");

        // 不给 id / 供应商不存在 / 越界引用别的 namespace —— 三种都拒绝。
        let no_id = set_gateway_namespace_mode(&db, "claude", GatewayMode::Provider, None);
        assert!(no_id.is_err());

        let miss = set_gateway_namespace_mode(&db, "claude", GatewayMode::Provider, Some("x"));
        assert!(miss.is_err());

        seed_provider(&db, "codex", "c1");
        let foreign = set_gateway_namespace_mode(&db, "claude", GatewayMode::Provider, Some("c1"));
        assert!(foreign.is_err());

        // 合法：本 namespace 的 provider。
        let ok = set_gateway_namespace_mode(&db, "claude", GatewayMode::Provider, Some("p1"));
        assert!(ok.is_ok());
        let mode = get_gateway_mode(&db, &AppType::Claude).unwrap();
        assert_eq!(mode, GatewayMode::Provider);
        let provider = get_gateway_default_provider(&db, &AppType::Claude).unwrap();
        assert_eq!(provider.id, "p1");
    }

    #[test]
    fn switching_to_model_mode_clears_default_provider_but_not_catalog() {
        let db = Database::memory().expect("memory db");
        seed_provider(&db, "claude", "p1");
        let entry = GatewayCatalogEntry {
            model: "m".to_string(),
            provider_id: "p1".to_string(),
        };
        let seeded = set_gateway_catalog(&db, "claude", &[entry]);
        assert!(seeded.is_ok());

        let on = set_gateway_namespace_mode(&db, "claude", GatewayMode::Provider, Some("p1"));
        assert!(on.is_ok());
        let back = set_gateway_namespace_mode(&db, "claude", GatewayMode::Model, None);
        assert!(back.is_ok());

        // 模式回到 Model，默认供应商清空，但目录还在（切回即恢复）。
        let mode = get_gateway_mode(&db, &AppType::Claude).unwrap();
        assert_eq!(mode, GatewayMode::Model);
        let provider = get_gateway_default_provider(&db, &AppType::Claude).unwrap();
        assert!(provider.is_none());
        let catalog = get_gateway_catalog(&db, &AppType::Claude).unwrap();
        assert_eq!(catalog.len(), 1);
    }

    #[test]
    fn default_provider_deleted_yields_none_rather_than_error() {
        // 供应商被删后，模式键仍指向它的 id（无人来清）。读取必须 Ok(None) 而非
        // Err——调用方据此回 404，与 model 模式「陈旧目录条目等同未配置」一致。
        let db = Database::memory().expect("memory db");
        seed_provider(&db, "claude", "p1");
        let on = set_gateway_namespace_mode(&db, "claude", GatewayMode::Provider, Some("p1"));
        assert!(on.is_ok());

        db.delete_provider("claude", "p1").expect("delete provider");

        let mode = get_gateway_mode(&db, &AppType::Claude).unwrap();
        assert_eq!(mode, GatewayMode::Provider);
        let provider = get_gateway_default_provider(&db, &AppType::Claude).unwrap();
        assert!(provider.is_none());
    }
}
