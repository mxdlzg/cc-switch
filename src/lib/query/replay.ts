import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  replayApi,
  type ReplayConfigInput,
  type ReplayStatus,
} from "@/lib/api/replay";
import { debugCaptureKeys } from "@/lib/query/debugCapture";

export const replayKeys = {
  status: ["replayStatus"] as const,
};

/**
 * 重放进度。初值从后端补一次（面板重挂载时能看到上一次的结果），之后**靠事件**刷新。
 *
 * 不轮询：后端每次尝试都会 emit `replay-progress`，轮询只是多打 IPC。
 *
 * `refetchOnMount: "always"` 是必需的：事件桥挂在进度面板上，面板收起（Accordion
 * 默认卸载内容）期间的事件就收不到了；重新展开时必须重新对账一次，否则会停在
 * 卸载前的进度上。系统通知由 Rust 侧发，不受前端挂载状态影响。
 */
export function useReplayStatus() {
  return useQuery({
    queryKey: replayKeys.status,
    queryFn: () => replayApi.getStatus(),
    staleTime: Infinity,
    refetchOnMount: "always",
  });
}

/**
 * 把后端 `replay-progress` 事件写进查询缓存。挂在会显示进度的面板上。
 *
 * 后端只在「每次尝试后」与「终止时」emit，频率上限 = 1/间隔秒数（间隔下限 1 秒），
 * 不需要防抖。
 */
export function useReplayEventBridge() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let disposed = false;

    (async () => {
      const off = await listen<ReplayStatus>("replay-progress", (event) => {
        queryClient.setQueryData(replayKeys.status, event.payload);
        // 重放成功后会把响应写进抓取缓冲 → 让查看器立刻看到它。
        void queryClient.invalidateQueries({
          queryKey: debugCaptureKeys.events,
        });
      });

      if (disposed) off();
      else unlisten = off;
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [queryClient]);
}

/** 按需读取某条目的快照信息（预检）。 */
export async function fetchReplaySnapshotInfo(seq: number) {
  return replayApi.getSnapshotInfo(seq);
}

/** 启动重放。成功时直接用返回值写缓存（后端已给出 Running 状态）。 */
export function useStartReplay() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { seq: number; config: ReplayConfigInput }) =>
      replayApi.start(args.seq, args.config),
    onSuccess: (status) => {
      queryClient.setQueryData(replayKeys.status, status);
    },
    onError: (e) => {
      console.error("Failed to start replay:", e);
      toast.error(String(e));
    },
  });
}

/** 请求停止。终态由后端事件送达（正在飞的那个请求跑完后才落 stopped）。 */
export function useStopReplay() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => replayApi.stop(),
    onSuccess: (status) => {
      if (status) queryClient.setQueryData(replayKeys.status, status);
    },
    onError: (e) => {
      console.error("Failed to stop replay:", e);
      toast.error(String(e));
    },
  });
}
