import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  idleWatchApi,
  type IdleWatchAlert,
  type IdleWatchConfig,
  type IdleWatchConfigInput,
} from "@/lib/api/idleWatch";
import { describeIdleAlert } from "@/lib/utils/idleDuration";

export const idleWatchKeys = {
  config: ["idleWatchConfig"] as const,
  status: ["idleWatchStatus"] as const,
};

/**
 * 静默监控配置。
 *
 * `refetchOnMount: "always"`：面板收起（Accordion 默认卸载内容）期间配置可能被别处
 * 改动（同步导入 / 另一个窗口），重新挂载必须重新对账，否则会在旧配置上编辑并覆盖新值。
 */
export function useIdleWatchConfig() {
  return useQuery({
    queryKey: idleWatchKeys.config,
    queryFn: () => idleWatchApi.getConfig(),
    staleTime: Infinity,
    refetchOnMount: "always",
  });
}

/**
 * 各渠道状态表。挂载读一次，之后每 30 秒刷新——「已静默」是随时间增长的量，
 * 不刷新会停在打开那一刻的数字上，用户会觉得面板是死的。
 */
export function useChannelIdleStatus() {
  return useQuery({
    queryKey: idleWatchKeys.status,
    queryFn: () => idleWatchApi.getStatus(),
    refetchInterval: 30_000,
    placeholderData: (previousData) => previousData,
  });
}

/**
 * 整块保存配置。后端做区间校验、去重，并给新规则打上 `createdAtSec`，所以直接
 * 用返回值写缓存——写回请求体会丢掉后端打的时间戳，计时基线也就错了。
 */
export function useSaveIdleWatchConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (config: IdleWatchConfigInput) =>
      idleWatchApi.saveConfig(config),
    onSuccess: (saved: IdleWatchConfig) => {
      queryClient.setQueryData(idleWatchKeys.config, saved);
      // 规则增删改变状态表的「现有规则」列 → 立刻重取
      void queryClient.invalidateQueries({ queryKey: idleWatchKeys.status });
    },
    onError: (e) => {
      console.error("Failed to save idle watch config:", e);
      toast.error(String(e));
    },
  });
}

/**
 * 把后端 `idle-watch-alert` 事件转成应用内 toast 并刷新表格。
 *
 * 系统通知由 Rust 侧发（用户可能根本不在应用里）；这里补的是**应用内**的那一条，
 * 顺带重取配置与状态——一次性规则触发后已被后端删除，不重取会继续显示那条失效规则。
 */
export function useIdleWatchEventBridge() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let disposed = false;

    (async () => {
      const off = await listen<IdleWatchAlert[]>(
        "idle-watch-alert",
        (event) => {
          for (const alert of event.payload) {
            // 方向写在正文里（`describeIdleAlert` 按 `kind` 分岔），标题保持
            // 「渠道名 · 应用」不变：它负责「哪个渠道」，正文负责「出了什么事」。
            toast.warning(`${alert.providerName} · ${alert.appType}`, {
              description: describeIdleAlert(alert, t),
              duration: 8000,
            });
          }
          void queryClient.invalidateQueries({
            queryKey: idleWatchKeys.status,
          });
          void queryClient.invalidateQueries({
            queryKey: idleWatchKeys.config,
          });
        },
      );

      if (disposed) off();
      else unlisten = off;
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [queryClient, t]);
}
