//! 本地网关（Local Gateway）相关的 Tauri 命令
//!
//! 前端设置页用这几条命令读取/配置 `/gateway/*` 端点：访问令牌、
//! 每个 namespace 的模型目录、以及「拉取某供应商的模型列表」供勾选。
//!
//! 注意与 `commands/proxy.rs` 的分工：那边管「接管」（会改写 CLI 的 Live 配置），
//! 这边只管网关（不碰任何 Live 配置）。

use crate::error::AppError;
use crate::services::gateway::{self, GatewayCatalogEntry};
use crate::services::model_fetch::{self, FetchedModel};
use crate::store::AppState;
use serde::Serialize;

/// 网关供应商下拉框 / 目录条目里可引用的供应商。
///
/// 只暴露 id + name：下拉框不需要 `settings_config`，而那里头含 API Key，
/// 没必要为一次选择再往前端搬一份。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayProviderOption {
    pub id: String,
    pub name: String,
    /// 该供应商所属的网关命名空间（与 app_type 同名）
    pub namespace: String,
}

/// 读取网关信息（令牌 + 各命名空间的模型目录）。
#[tauri::command]
pub async fn get_gateway_info(
    state: tauri::State<'_, AppState>,
) -> Result<gateway::GatewayInfo, AppError> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || gateway::get_gateway_info(&db))
        .await
        .map_err(|e| AppError::Message(format!("网关信息查询失败: {e}")))?
}

/// 重新生成网关访问令牌（旧令牌立即失效）。
#[tauri::command]
pub async fn rotate_gateway_token(state: tauri::State<'_, AppState>) -> Result<String, AppError> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || gateway::rotate_gateway_token(&db))
        .await
        .map_err(|e| AppError::Message(format!("网关令牌轮换失败: {e}")))?
}

/// 开/关网关。关闭后 `/gateway/*` 一律 401（不影响接管侧与本地 CLI）。
#[tauri::command]
pub async fn set_gateway_enabled(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), AppError> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || gateway::set_gateway_enabled(&db, enabled))
        .await
        .map_err(|e| AppError::Message(format!("网关开关设置失败: {e}")))?
}

/// 覆盖写入某个命名空间的模型目录（空列表 = 清空 → 该端点全部 404）。
#[tauri::command]
pub async fn set_gateway_catalog(
    state: tauri::State<'_, AppState>,
    namespace: String,
    entries: Vec<GatewayCatalogEntry>,
) -> Result<(), AppError> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        gateway::set_gateway_catalog(&db, &namespace, &entries)
    })
    .await
    .map_err(|e| AppError::Message(format!("网关模型目录写入失败: {e}")))?
}

/// 列出所有命名空间的可选供应商（按命名空间分组扁平返回）。
///
/// 数据来源就是首页那批卡片——网关**引用**供应商而非复制一份，所以用户在
/// cc-switch 里改了 key/base URL，网关这边自动跟上。
#[tauri::command]
pub async fn get_gateway_provider_options(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<GatewayProviderOption>, AppError> {
    let db = state.db.clone();
    let options = tauri::async_runtime::spawn_blocking(move || {
        let mut options = Vec::new();
        for namespace in gateway::GATEWAY_NAMESPACES {
            let providers = db.get_all_providers(namespace.as_str())?;
            for provider in providers.values() {
                options.push(GatewayProviderOption {
                    id: provider.id.clone(),
                    name: provider.name.clone(),
                    namespace: namespace.as_str().to_string(),
                });
            }
        }
        Ok::<_, AppError>(options)
    })
    .await
    .map_err(|e| AppError::Message(format!("网关供应商列表读取失败: {e}")))??;

    Ok(options)
}

/// 拉取某个供应商的可用模型列表，供网关目录勾选。
///
/// 与前端表单的 `fetch_models_for_config` 不同：base URL / key 由后端从 provider
/// 配置里提取（复用转发时同一套 adapter 提取逻辑），**API Key 不出本机后端**，
/// 前端只需给 namespace + providerId。
///
/// 需要动态取 token 的鉴权方式（Copilot / 各家 OAuth）无法用静态 key 拉模型，
/// 返回明确错误，前端据此回落到手动输入。
#[tauri::command]
pub async fn get_gateway_provider_models(
    state: tauri::State<'_, AppState>,
    namespace: String,
    provider_id: String,
) -> Result<Vec<FetchedModel>, String> {
    use crate::proxy::providers::{get_adapter, AuthStrategy};

    let db = state.db.clone();
    let (base_url, api_key, api_format) = tauri::async_runtime::spawn_blocking(move || {
        let app_type = gateway::parse_gateway_namespace(&namespace).map_err(|e| e.to_string())?;
        let provider = db
            .get_provider_by_id(&provider_id, app_type.as_str())
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "供应商不存在或不属于该命名空间".to_string())?;

        let adapter = get_adapter(&app_type).ok_or_else(|| "该命名空间无适配器".to_string())?;
        let base_url = adapter
            .extract_base_url(&provider)
            .map_err(|e| e.to_string())?;
        let auth = adapter
            .extract_auth(&provider)
            .ok_or_else(|| "供应商未配置可用的密钥".to_string())?;

        // 静态 key 才能直接拉 /models；动态 token 类鉴权交回前端手动输入。
        let api_format = match auth.strategy {
            AuthStrategy::Anthropic => Some("anthropic-messages"),
            AuthStrategy::Google => Some("google-generative-ai"),
            AuthStrategy::ClaudeAuth | AuthStrategy::Bearer => None,
            other => {
                return Err(format!(
                    "该供应商使用 {other:?} 鉴权（需动态取 token），请手动填写模型名"
                ))
            }
        };
        Ok::<_, String>((base_url, auth.api_key, api_format))
    })
    .await
    .map_err(|e| format!("网关模型列表读取失败: {e}"))??;

    model_fetch::fetch_models(&base_url, &api_key, false, None, None, api_format, None).await
}
