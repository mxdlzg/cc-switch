import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { debugCaptureApi } from "@/lib/api/debugCapture";
import { toast } from "sonner";

export const debugCaptureKeys = {
  enabled: ["debugCaptureEnabled"] as const,
  events: ["debugCaptureEvents"] as const,
};

/** 捕获开关状态（一次性读取，改动后由 mutation 失效刷新）。 */
export function useDebugCaptureEnabled() {
  return useQuery({
    queryKey: debugCaptureKeys.enabled,
    queryFn: () => debugCaptureApi.getEnabled(),
    // 后端是进程内全局态，没有事件推送；面板自行读取即可，无需轮询。
  });
}

/**
 * 轮询捕获快照。**只在开关打开时轮询**——关闭态后端 `record_*` 首行即返回，
 * 缓冲不再增长，轮询只是白跑一次 IPC。
 */
export function useDebugCaptureEvents(enabled: boolean) {
  return useQuery({
    queryKey: debugCaptureKeys.events,
    queryFn: () => debugCaptureApi.getEvents(),
    enabled,
    refetchInterval: enabled ? 1000 : false,
    placeholderData: (previousData) => previousData,
  });
}

/** 开/关捕获。返回值是后端生效后的状态，据此写回缓存。 */
export function useSetDebugCaptureEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => debugCaptureApi.setEnabled(enabled),
    onSuccess: (enabled) => {
      queryClient.setQueryData(debugCaptureKeys.enabled, enabled);
    },
    onError: (e) => {
      console.error("Failed to set debug capture:", e);
      toast.error(String(e));
    },
  });
}

/** 清空缓冲（保留开关状态；关闭开关不会清空，便于回看）。 */
export function useClearDebugCapture() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => debugCaptureApi.clear(),
    onSuccess: () => {
      queryClient.setQueryData(debugCaptureKeys.events, []);
    },
    onError: (e) => {
      console.error("Failed to clear debug capture:", e);
      toast.error(String(e));
    },
  });
}
