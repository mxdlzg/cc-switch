import { useTranslation } from "react-i18next";
import { CircleStop, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { ReplayState } from "@/lib/api/replay";
import { useReplayEventBridge, useReplayStatus, useStopReplay } from "@/lib/query/replay";

/** 终态徽章配色：成功绿、失败红、上限/停止灰。 */
const STATE_CLASS: Record<ReplayState, string> = {
  running: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  succeeded: "bg-green-500/15 text-green-700 dark:text-green-400",
  failed: "bg-red-500/15 text-red-600 dark:text-red-400",
  capped: "bg-amber-500/15 text-amber-600 dark:text-amber-500",
  stopped: "bg-muted text-muted-foreground",
};

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * 重放进度面板（挂在设置 → 代理高级选项里）。
 *
 * 数据靠后端 `replay-progress` 事件推（每次尝试后一次 + 终止时一次），不轮询。
 * 启动入口在「请求查看器」里选中一条请求后的 Replay 按钮——这里只负责看与停：
 * 用户点了启动就该走开干别的，回来只需要知道「还在跑 / 拿到了 / 为什么停」。
 */
export function ReplayPanel() {
  const { t } = useTranslation();
  useReplayEventBridge();
  const { data: status } = useReplayStatus();
  const stopReplay = useStopReplay();

  if (!status) {
    return (
      <Alert className="border-blue-500/40 bg-blue-500/10">
        <AlertDescription className="text-sm">
          {t("replay.idleHint")}
        </AlertDescription>
      </Alert>
    );
  }

  const running = status.state === "running";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className={STATE_CLASS[status.state]}>
          {running && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
          {t(`replay.state.${status.state}`)}
        </Badge>
        <span className="font-mono text-xs text-muted-foreground">
          {status.method} {status.targetOrigin}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("replay.attempts", {
            attempts: status.attempts,
            consecutive: status.consecutive,
            required: status.requiredConsecutive,
            defaultValue: `第 ${status.attempts} 次 · 连续成功 ${status.consecutive}/${status.requiredConsecutive}`,
          })}
        </span>
        <span className="text-xs text-muted-foreground">
          {formatElapsed(status.elapsedMs)}
        </span>
        {status.lastStatus !== null && (
          <span className="font-mono text-xs text-muted-foreground">
            HTTP {status.lastStatus}
          </span>
        )}
        <div className="ml-auto">
          <Button
            size="sm"
            variant="outline"
            disabled={!running || stopReplay.isPending}
            onClick={() => stopReplay.mutate()}
          >
            <CircleStop className="mr-2 h-4 w-4" />
            {t("replay.stop")}
          </Button>
        </div>
      </div>

      {status.lastError && (
        <p className="break-all font-mono text-[11px] text-red-600 dark:text-red-400">
          {status.lastError}
        </p>
      )}

      <p className="text-xs text-muted-foreground">{t("replay.noBilling")}</p>
    </div>
  );
}
