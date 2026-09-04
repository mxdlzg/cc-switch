import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  useClearDebugCapture,
  useDebugCaptureEnabled,
  useDebugCaptureEvents,
  useSetDebugCaptureEnabled,
} from "@/lib/query/debugCapture";
import type { CaptureEvent, CaptureKind } from "@/lib/api/debugCapture";

/** 各捕获类型的徽章配色：错误一眼可辨，请求/响应区分开。 */
const KIND_CLASS: Record<CaptureKind, string> = {
  client_request: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
  request: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  response: "bg-green-500/15 text-green-700 dark:text-green-400",
  error: "bg-red-500/15 text-red-600 dark:text-red-400",
};

function formatTime(atMs: number): string {
  const d = new Date(atMs);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(
    d.getSeconds(),
  )}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * 请求调试捕获：内存态的「请求 / 非流式响应 / 错误体」面板。
 *
 * 独立于「应用诊断日志」——那个写 logs/ 下的文件，这个只在内存里留最近 50 条，
 * 重启即清空。开关是进程内全局态，立即生效、无需重启代理。
 */
export function DebugCaptureSection() {
  const { t } = useTranslation();
  const { data: enabled } = useDebugCaptureEnabled();
  const setEnabled = useSetDebugCaptureEnabled();
  const clearCapture = useClearDebugCapture();
  const { data: events } = useDebugCaptureEvents(!!enabled);
  const [openSeq, setOpenSeq] = useState<number | null>(null);

  // 倒序展示：最新的一条在最上方，排查时不必手动滚到底。
  const ordered = events ? [...events].reverse() : [];

  const copyBody = (body: string) => {
    navigator.clipboard.writeText(body);
    toast.success(t("settings.advanced.debugCapture.copied", "正文已复制"), {
      closeButton: true,
    });
  };

  const renderRow = (ev: CaptureEvent) => {
    const isOpen = openSeq === ev.seq;
    return (
      <li key={ev.seq} className="rounded border">
        <button
          type="button"
          className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5 text-left text-xs hover:bg-muted/50"
          onClick={() => setOpenSeq(isOpen ? null : ev.seq)}
        >
          <span className="font-mono text-muted-foreground">
            {formatTime(ev.atMs)}
          </span>
          <Badge
            className={`border-transparent px-1.5 py-0 ${KIND_CLASS[ev.kind]}`}
          >
            {t(`settings.advanced.debugCapture.kind.${ev.kind}`)}
          </Badge>
          {ev.status !== null && (
            <span className="font-mono text-muted-foreground">{ev.status}</span>
          )}
          <span className="truncate font-medium">{ev.model || "—"}</span>
          <span className="truncate text-muted-foreground">
            {ev.appType}
            {ev.providerId ? ` · ${ev.providerId}` : ""}
          </span>
          {ev.kind === "response" && (
            <span className="text-muted-foreground">
              {ev.rawUpstream
                ? t("settings.advanced.debugCapture.rawUpstream", "上游原文")
                : t("settings.advanced.debugCapture.converted", "转换后响应")}
            </span>
          )}
          {ev.truncated && (
            <span className="text-amber-600 dark:text-amber-500">
              {t("settings.advanced.debugCapture.truncated", "已截断")}
            </span>
          )}
        </button>
        {isOpen && (
          <div className="border-t p-2">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="break-all font-mono text-[11px] text-muted-foreground">
                {`session=${ev.sessionId || "—"}`}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 text-xs"
                onClick={() => copyBody(ev.body)}
              >
                {t("common.copy")}
              </Button>
            </div>
            <pre className="max-h-80 overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
              {ev.body || "—"}
            </pre>
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="space-y-4 border-t pt-6">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label>{t("settings.advanced.debugCapture.label")}</Label>
          <p className="text-xs text-muted-foreground">
            {t("settings.advanced.debugCapture.hint")}
          </p>
        </div>
        <Switch
          checked={!!enabled}
          disabled={enabled === undefined}
          onCheckedChange={(checked) => setEnabled.mutate(checked)}
        />
      </div>

      {enabled && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {ordered.length > 0
                ? t("settings.advanced.debugCapture.count", {
                    n: ordered.length,
                    defaultValue: `已捕获 ${ordered.length} 条（最多保留 50 条）`,
                  })
                : t(
                    "settings.advanced.debugCapture.emptyToggle",
                    "开启后新请求将记录在下方",
                  )}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="text-xs"
              disabled={ordered.length === 0 || clearCapture.isPending}
              onClick={() => clearCapture.mutate()}
            >
              {t("settings.advanced.debugCapture.clear")}
            </Button>
          </div>

          {ordered.length === 0 ? (
            <div className="rounded-lg bg-muted/50 px-4 py-6 text-center text-xs text-muted-foreground">
              {t("settings.advanced.debugCapture.empty")}
            </div>
          ) : (
            <ul className="max-h-[26rem] space-y-1.5 overflow-auto">
              {ordered.map(renderRow)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
