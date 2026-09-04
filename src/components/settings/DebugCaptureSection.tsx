import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { APP_IDS } from "@/config/appConfig";
import { providersApi } from "@/lib/api/providers";
import { useQuery } from "@tanstack/react-query";
import type { AppId } from "@/lib/api/types";
import type { CaptureEvent, CaptureKind } from "@/lib/api/debugCapture";
import {
  useClearDebugCapture,
  useDebugCaptureEnabled,
  useDebugCaptureEvents,
  useSetDebugCaptureEnabled,
} from "@/lib/query/debugCapture";

/** 各捕获步骤的徽章配色：错误一眼可辨，入站/出站/响应区分开。 */
const KIND_CLASS: Record<CaptureKind, string> = {
  client_request: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
  request: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  response: "bg-green-500/15 text-green-700 dark:text-green-400",
  error: "bg-red-500/15 text-red-600 dark:text-red-400",
};

/**
 * 一次 forward() 产生的四类事件在缓冲里相邻且共享 session_id，据此配对成「轮次」。
 *
 * 后端没有贯穿请求→响应的请求 id，只有 session_id（客户端提供或按内容哈希/随机
 * 生成，同一 session 可多轮）。用「连续同 session」分组：并发渠道会交错排列，
 * 同组不连续时拆成多轮展示——可能过度拆分（多轮被判定为一轮），但绝不把不同
 * 请求的 body 混进同一轮。
 */
interface Turn {
  key: number;
  events: CaptureEvent[];
  sessionId: string;
  appType: string;
  providerId: string;
  model: string;
  hasError: boolean;
  /** 有终态事件（response / error） */
  hasTerminal: boolean;
}

function buildTurns(events: CaptureEvent[]): Turn[] {
  const turns: Turn[] = [];
  for (const ev of events) {
    const head = turns[turns.length - 1];
    if (head && head.sessionId === ev.sessionId) {
      head.events.push(ev);
    } else {
      turns.push({
        key: ev.seq,
        events: [ev],
        sessionId: ev.sessionId,
        appType: ev.appType,
        providerId: ev.providerId,
        model: ev.model,
        hasError: false,
        hasTerminal: false,
      });
    }
    const turn = turns[turns.length - 1];
    if (ev.kind === "error") turn.hasError = true;
    if (ev.kind === "response" || ev.kind === "error") turn.hasTerminal = true;
    // 模型名以出站上送的那条为准（映射后的名字），其次任意非空。
    if (ev.kind === "request" && ev.model) turn.model = ev.model;
    else if (!turn.model && ev.model) turn.model = ev.model;
  }
  return turns;
}

function channelKeyOf(ev: { appType: string; providerId: string }): string {
  return `${ev.appType}/${ev.providerId}`;
}

/** 捕获事件里的 appType 是后端 `AppType::as_str()`，与前端 AppId 同字面量。 */
function isAppId(s: string): s is AppId {
  return (APP_IDS as string[]).includes(s);
}

function formatTime(atMs: number): string {
  const d = new Date(atMs);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(
    d.getSeconds(),
  )}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * 请求调试捕获：内存态的「客户端入站 / 上送上游 / 响应 / 错误体」查看器。
 *
 * 独立于「应用诊断日志」——那个写 logs/ 下的文件，这个只在内存里留最近 50 条，
 * 重启即清空。开关是进程内全局态，立即生效、无需重启代理；**关闭只停新捕获，
 * 已捕获内容保留可回看**，显式清空或重启才消失。
 *
 * 布局：面板内只留控件（开关 / 计数 / 清空 / 打开），**不内嵌列表**——内嵌列表会
 * 在「窗口 → 设置页 → 列表 → body」叠出四层滚动条。正文改在弹窗里看：左列请求
 * 列表、右列按步骤分标签页，一次只看一份 body，两处各自独立滚动。
 */
export function DebugCaptureSection() {
  const { t } = useTranslation();
  const { data: enabled } = useDebugCaptureEnabled();
  const setEnabled = useSetDebugCaptureEnabled();
  const clearCapture = useClearDebugCapture();
  const { data: events } = useDebugCaptureEvents(!!enabled);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<number | null>(null);
  const [channelFilter, setChannelFilter] = useState<string>("all");

  // 渠道 = appType + providerId。只为捕获里出现过的 appType 拉供应商列表，
  // 拿不到名字时回退显示 providerId。
  const channelAppTypes = useMemo(() => {
    const set = new Set<AppId>();
    for (const ev of events ?? []) {
      if (isAppId(ev.appType)) set.add(ev.appType);
    }
    return [...set];
  }, [events]);

  // key 用 join 后的字符串（而非数组身份）：轮询每次都产生新数组，但渠道集合
  // 通常不变，这样不会每轮询一次就重取一次供应商列表。
  const namesQuery = useQuery({
    queryKey: ["debugCaptureProviderNames", channelAppTypes.join(",")],
    queryFn: async () => {
      const map: Record<string, string> = {};
      await Promise.all(
        channelAppTypes.map(async (appId) => {
          try {
            const providers = await providersApi.getAll(appId);
            for (const p of Object.values(providers)) {
              map[`${appId}/${p.id}`] = p.name;
            }
          } catch {
            /* 拉不到就用 providerId 显示 */
          }
        }),
      );
      return map;
    },
  });
  const providerNames: Record<string, string> = namesQuery.data ?? {};

  // 后端按 seq 升序返回，这里就是时间正序（客户端→上游→响应）。
  const chronological = events ?? [];

  // 渠道列表按最近活跃排在前：遍历倒序，首次出现的渠道即最新。
  const channels = useMemo(() => {
    const seen = new Map<string, { appType: string; providerId: string }>();
    for (const ev of [...chronological].reverse()) {
      const key = channelKeyOf(ev);
      if (!seen.has(key)) {
        seen.set(key, { appType: ev.appType, providerId: ev.providerId });
      }
    }
    return [...seen.entries()];
  }, [chronological]);

  // 所选渠道可能随缓冲滚动消失，回退到「全部」，不产生渲染期 setState。
  const effectiveFilter =
    channelFilter === "all" || channels.some(([k]) => k === channelFilter)
      ? channelFilter
      : "all";

  const visible = useMemo(
    () =>
      effectiveFilter === "all"
        ? chronological
        : chronological.filter((ev) => channelKeyOf(ev) === effectiveFilter),
    [chronological, effectiveFilter],
  );

  // 正序配对（步骤才是 客户端→上游→响应），再整体倒序（最新请求在最上）。
  const turns = useMemo(() => buildTurns(visible).reverse(), [visible]);

  // 选中项可能因清空/滚动而消失，回退到最新一条（同样避免渲染期 setState）。
  const selected =
    turns.find((turn) => turn.key === selectedKey) ?? turns[0] ?? null;

  const channelLabel = (appType: string, providerId: string): string => {
    const appName = t(`apps.${appType}`, appType);
    const name = providerNames[`${appType}/${providerId}`] || providerId || "—";
    return `${appName} · ${name}`;
  };

  const kindLabel = (kind: CaptureKind) =>
    t(`settings.advanced.debugCapture.kind.${kind}`);

  const copyBody = (body: string) => {
    navigator.clipboard.writeText(body);
    toast.success(t("settings.advanced.debugCapture.copied", "正文已复制"), {
      closeButton: true,
    });
  };

  const allEmpty = chronological.length === 0;

  /** 列表行里的管道进度：客户端→上游→响应，缺的那步标灰。 */
  const renderPipeline = (turn: Turn) => {
    const lastKind: CaptureKind = turn.hasError ? "error" : "response";
    const steps: Array<{ kind: CaptureKind; ok: boolean }> = [
      {
        kind: "client_request",
        ok: turn.events.some((e) => e.kind === "client_request"),
      },
      { kind: "request", ok: turn.events.some((e) => e.kind === "request") },
      { kind: lastKind, ok: turn.hasTerminal },
    ];
    return (
      <span className="flex items-center gap-1">
        {steps.map((step, i) => (
          <span key={step.kind} className="flex items-center gap-1">
            {i > 0 && <span className="text-muted-foreground/50">→</span>}
            <span
              className={
                step.ok
                  ? `rounded px-1 py-0 text-[11px] ${KIND_CLASS[step.kind]}`
                  : "rounded px-1 py-0 text-[11px] text-muted-foreground/50"
              }
            >
              {kindLabel(step.kind)}
            </span>
          </span>
        ))}
      </span>
    );
  };

  const renderListItem = (turn: Turn) => {
    const active = selected?.key === turn.key;
    const head = turn.events[0];
    const status = turn.events[turn.events.length - 1].status;
    return (
      <li key={turn.key}>
        <button
          type="button"
          onClick={() => setSelectedKey(turn.key)}
          className={`w-full rounded px-2 py-1.5 text-left text-xs hover:bg-muted/60 ${
            active ? "bg-muted" : ""
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="font-mono text-muted-foreground">
              {formatTime(head.atMs)}
            </span>
            {status !== null ? (
              <span
                className={`font-mono ${
                  turn.hasError
                    ? "text-red-600 dark:text-red-400"
                    : "text-muted-foreground"
                }`}
              >
                {status}
              </span>
            ) : (
              <span className="text-amber-600 dark:text-amber-500">—</span>
            )}
            <span className="truncate font-medium">{turn.model || "—"}</span>
          </div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="truncate text-muted-foreground">
              {channelLabel(turn.appType, turn.providerId)}
            </span>
            {renderPipeline(turn)}
          </div>
        </button>
      </li>
    );
  };

  /**
   * 右列详情。`key={selected.key}` 让 Tabs 在换请求时重挂载，从而 defaultValue
   * 重新生效——默认落在终态那步（响应/错误），不必每次手动点。
   */
  const renderDetail = (turn: Turn) => {
    const defaultTab = turn.hasError
      ? turn.events.find((e) => e.kind === "error")?.seq
      : turn.events.find((e) => e.kind === "response")?.seq;
    const fallbackTab = turn.events[turn.events.length - 1].seq;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-xs">
          <span className="font-medium">
            {channelLabel(turn.appType, turn.providerId)}
          </span>
          <span className="font-mono text-muted-foreground">
            {turn.model || "—"}
          </span>
          <span className="break-all font-mono text-muted-foreground">
            {`session=${turn.sessionId || "—"}`}
          </span>
          {renderPipeline(turn)}
        </div>
        <Tabs
          key={turn.key}
          defaultValue={String(defaultTab ?? fallbackTab)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="mx-4 mt-2 self-start">
            {turn.events.map((ev) => (
              <TabsTrigger
                key={ev.seq}
                value={String(ev.seq)}
                className="gap-1.5"
              >
                {kindLabel(ev.kind)}
                {ev.truncated && (
                  <span className="text-amber-600 dark:text-amber-500">·</span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
          {turn.events.map((ev) => (
            <TabsContent
              key={ev.seq}
              value={String(ev.seq)}
              className="m-0 min-h-0 flex-1 overflow-hidden"
            >
              {/* display 工具类（flex/grid）刻意放在这一层内部、不放 TabsContent 上：
                  Radix 靠 `hidden` 属性隐藏非活跃标签页，而 Tailwind 的 `flex` 是
                  display 类、可能盖过 UA 的 `[hidden]{display:none}` → 四份 body 同时显示。
                  TabsContent 只留 flex-item / overflow 这类非 display 属性，hidden 必生效。 */}
              <div className="flex h-full min-h-0 flex-col">
                <div className="flex items-center justify-between gap-2 px-4 py-1.5 text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-2">
                    <span className="font-mono">{formatTime(ev.atMs)}</span>
                    {ev.status !== null && (
                      <span className="font-mono">{ev.status}</span>
                    )}
                    {ev.kind === "response" && (
                      <span>
                        {ev.rawUpstream
                          ? t(
                              "settings.advanced.debugCapture.rawUpstream",
                              "上游原文",
                            )
                          : t(
                              "settings.advanced.debugCapture.converted",
                              "转换后响应",
                            )}
                      </span>
                    )}
                    {ev.truncated && (
                      <span className="text-amber-600 dark:text-amber-500">
                        {t(
                          "settings.advanced.debugCapture.truncated",
                          "已截断",
                        )}
                      </span>
                    )}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 shrink-0 px-2 text-[11px]"
                    onClick={() => copyBody(ev.body)}
                  >
                    {t("common.copy")}
                  </Button>
                </div>
                {/* 弹窗内唯一的正文滚动区：不再叠 max-h，撑满右列即可。 */}
                <pre className="mx-4 mb-4 flex-1 overflow-auto rounded bg-muted/50 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
                  {ev.body || "—"}
                </pre>
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </div>
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

      {/* 只放控件：列表与正文都挪进弹窗，避免与窗口/设置页滚动互相嵌套。 */}
      <div className="flex flex-wrap items-center gap-2">
        {!enabled && !allEmpty && (
          <Badge className="border-transparent bg-amber-500/15 px-1.5 py-0 text-[11px] text-amber-600 dark:text-amber-500">
            {t("settings.advanced.debugCapture.pausedBadge", "已暂停")}
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          {t("settings.advanced.debugCapture.count", {
            n: chronological.length,
            defaultValue: `已捕获 ${chronological.length} 条（最多保留 50 条）`,
          })}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={allEmpty}
            onClick={() => setViewerOpen(true)}
          >
            {t("settings.advanced.debugCapture.open", "查看捕获")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={allEmpty || clearCapture.isPending}
            onClick={() => clearCapture.mutate()}
          >
            {t("settings.advanced.debugCapture.clear")}
          </Button>
        </div>
      </div>

      <Dialog open={viewerOpen} onOpenChange={setViewerOpen}>
        <DialogContent className="max-w-[min(1200px,95vw)]">
          <DialogHeader>
            <DialogTitle>
              {t("settings.advanced.debugCapture.viewerTitle", "捕获查看器")}
            </DialogTitle>
          </DialogHeader>

          {allEmpty ? (
            <div className="rounded-lg bg-muted/50 px-4 py-10 text-center text-xs text-muted-foreground">
              {t("settings.advanced.debugCapture.empty")}
            </div>
          ) : (
            <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-hidden border-t md:grid-cols-[300px_minmax(0,1fr)]">
              {/* 左列：渠道筛选 + 请求列表（本列唯一滚动区） */}
              <div className="flex max-h-[40vh] min-h-0 flex-col border-b md:max-h-none md:border-b-0 md:border-r">
                {channels.length > 1 && (
                  <div className="border-b p-2">
                    <Select
                      value={effectiveFilter}
                      onValueChange={setChannelFilter}
                    >
                      <SelectTrigger
                        className="h-8 text-xs"
                        aria-label={t(
                          "settings.advanced.debugCapture.filterAll",
                          "全部渠道",
                        )}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">
                          {t(
                            "settings.advanced.debugCapture.filterAll",
                            "全部渠道",
                          )}
                        </SelectItem>
                        {channels.map(([key, ch]) => (
                          <SelectItem key={key} value={key}>
                            {channelLabel(ch.appType, ch.providerId)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <ul className="min-h-0 flex-1 divide-y overflow-y-auto">
                  {turns.map(renderListItem)}
                </ul>
              </div>

              {/* 右列：选中的请求，步骤按标签页分（本列唯一滚动区是那个 pre） */}
              {selected ? (
                renderDetail(selected)
              ) : (
                <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
                  {t(
                    "settings.advanced.debugCapture.noSelection",
                    "选择左侧一条请求查看正文",
                  )}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
