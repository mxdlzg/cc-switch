import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { gatewayApi, type GatewayCatalogEntry } from "@/lib/api/gateway";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

export const gatewayKeys = {
  info: ["gatewayInfo"] as const,
  providerOptions: ["gatewayProviderOptions"] as const,
  providerModels: ["gatewayProviderModels"] as const,
};

/**
 * 读取网关信息（令牌 + 各 namespace 的模型目录）。
 *
 * 令牌与目录都只在挂载时读一次即可 —— 它们不会自己变（除非本组件触发轮换/保存），
 * 因此不轮询。目录变更后由 mutation 失效本查询来刷新。
 */
export function useGatewayInfo() {
  return useQuery({
    queryKey: gatewayKeys.info,
    queryFn: () => gatewayApi.getGatewayInfo(),
  });
}

/** 供应商下拉框的候选项（随首页供应商卡片变化，切换供应商后需失效）。 */
export function useGatewayProviderOptions(enabled = true) {
  return useQuery({
    queryKey: gatewayKeys.providerOptions,
    queryFn: () => gatewayApi.getGatewayProviderOptions(),
    enabled,
  });
}

/** 轮换访问令牌。 */
export function useRotateGatewayToken() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: () => gatewayApi.rotateGatewayToken(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: gatewayKeys.info });
      toast.success(
        t("gateway.toast.tokenRotated", {
          defaultValue: "访问令牌已重新生成，旧令牌立即失效",
        }),
        { closeButton: true },
      );
    },
  });
}

/** 开/关网关。 */
export function useSetGatewayEnabled() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (enabled: boolean) => gatewayApi.setGatewayEnabled(enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: gatewayKeys.info });
    },
  });
}

/** 设置某个 namespace 的模型目录（覆盖写入；空数组 = 清空 → 该端点全部 404）。 */
export function useSetGatewayCatalog() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: ({
      namespace,
      entries,
    }: {
      namespace: string;
      entries: GatewayCatalogEntry[];
    }) => gatewayApi.setGatewayCatalog(namespace, entries),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: gatewayKeys.info });
    },
    onError: (error: Error) => {
      toast.error(
        t("gateway.toast.catalogSetFailed", {
          error: error.message,
          defaultValue: `保存网关模型目录失败: ${error.message}`,
        }),
      );
    },
  });
}

/**
 * 拉取某供应商的可用模型列表，供目录勾选。
 *
 * 仅在选中了 provider 时启用（`enabled` 由调用方给）。动态 token 类鉴权的供应商
 * 会 reject，调用方展示错误并回落到手动输入。结果按 (namespace, providerId) 缓存，
 * 不自动刷新——拉模型是显式动作，不该在每次打开面板时打上游。
 */
export function useGatewayProviderModels(
  namespace: string,
  providerId: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: [...gatewayKeys.providerModels, namespace, providerId],
    queryFn: () => gatewayApi.getGatewayProviderModels(namespace, providerId!),
    enabled: enabled && Boolean(providerId),
  });
}
