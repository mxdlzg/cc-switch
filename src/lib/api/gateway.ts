import { invoke } from "@tauri-apps/api/core";

/**
 * 本地网关（`/gateway/*`）的类型定义。
 *
 * 网关与「接管」互不相干：它不改写任何 CLI 的 Live 配置文件，只是把 cc-switch
 * 已有的供应商 + 协议转换能力，额外用一个 Bearer token 暴露给第三方工具。
 */

/** 目录里的一条记录：客户端可见的 model → 处理它的 provider。 */
export interface GatewayCatalogEntry {
  /** 客户端请求里出现的模型名（原样匹配，不做别名/大小写归一） */
  model: string;
  /** 命中该 model 时路由到的 provider id */
  providerId: string;
}

/** 单个 namespace 的网关视图（namespace 同 app_type，如 "claude"）。 */
export interface GatewayNamespaceInfo {
  namespace: string;
  /** URL 前缀，如 "/gateway/claude" */
  pathPrefix: string;
  /** 该 namespace 的模型目录（空 = 该端点所有请求 404） */
  catalog: GatewayCatalogEntry[];
}

/** 网关整体信息。 */
export interface GatewayInfo {
  /** 网关总开关。为 false 时 `/gateway/*` 一律 401。 */
  enabled: boolean;
  /** 访问令牌明文（仅本机 UI 可读，用于复制到第三方工具） */
  token: string;
  namespaces: GatewayNamespaceInfo[];
}

/** 供应商下拉框候选项。 */
export interface GatewayProviderOption {
  id: string;
  name: string;
  namespace: string;
}

/** 从供应商拉回来的模型条目（供目录勾选）。 */
export interface FetchedModel {
  id: string;
  ownedBy?: string | null;
}

export const gatewayApi = {
  /** 读取网关信息（令牌 + 各 namespace 的模型目录）。 */
  async getGatewayInfo(): Promise<GatewayInfo> {
    return invoke("get_gateway_info");
  },

  /** 重新生成访问令牌（旧令牌立即失效）。 */
  async rotateGatewayToken(): Promise<string> {
    return invoke("rotate_gateway_token");
  },

  /**
   * 设置自定义访问令牌（旧令牌立即失效）。
   *
   * 后端校验为准（可见 ASCII、无空格、8-256 字符），返回生效后的令牌；
   * 校验失败会 reject 并带可读消息。
   */
  async setGatewayToken(token: string): Promise<string> {
    return invoke("set_gateway_token", { token });
  },

  /** 开/关网关（关闭后 `/gateway/*` 一律 401）。 */
  async setGatewayEnabled(enabled: boolean): Promise<void> {
    return invoke("set_gateway_enabled", { enabled });
  },

  /** 覆盖写入某个 namespace 的模型目录（空数组 = 清空 → 该端点全部 404）。 */
  async setGatewayCatalog(
    namespace: string,
    entries: GatewayCatalogEntry[],
  ): Promise<void> {
    return invoke("set_gateway_catalog", { namespace, entries });
  },

  /** 列出所有 namespace 的可选供应商。 */
  async getGatewayProviderOptions(): Promise<GatewayProviderOption[]> {
    return invoke("get_gateway_provider_options");
  },

  /**
   * 拉取某供应商的可用模型列表，供目录勾选。
   *
   * base URL / key 由后端从 provider 配置提取（API Key 不出本机后端）。动态
   * token 类鉴权（Copilot / 各家 OAuth）无法静态拉取，会 reject 并带可读消息，
   * 前端据此回落到手动输入。
   */
  async getGatewayProviderModels(
    namespace: string,
    providerId: string,
  ): Promise<FetchedModel[]> {
    return invoke("get_gateway_provider_models", { namespace, providerId });
  },
};
