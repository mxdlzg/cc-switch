import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
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
 * 请求调试捕获：内存态的「客户端入站 / 上送上游 / 响应 / 错误体」面板。
 *
 * 独立于「应用诊断日志」——那个写 logs/ 下的文件，这个只在内存里留最近 50 条，
 * 重启即清空。开关是进程内全局态，立即生效、无需重启代理；**关闭只停新捕获，
 * 已捕获内容保留可回看**，显式清空或重启才消失。
 *
 * 展示单元是「一次请求」而非单条事件：同一请求的入站/出站/响应配对成一张卡，
 * 卡内按管道顺序竖排，避免入站与出站两份 body 在扁平列表里混在一起。
 */
export function DebugCaptureSection() {
  const { t } = useTranslation();
  const { data: enabled } = useDebugCaptureEnabled();
  const setEnabled = useSetDebugCaptureEnabled();
  const clearCapture = useClearDebugCapture();
  const { data: events } = useDebugCaptureEvents(!!enabled);
  const [openTurn, setOpenTurn] = useState<number | null>(null);
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

  // 正序配对（卡内步骤才是 客户端→上游→响应），再整体倒序（最新请求在最上）。
  const turns = useMemo(() => buildTurns(visible).reverse(), [visible]);

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

  /** 摘要里的管道进度：客户端→上游→响应，缺的那步标灰。 */
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

  const renderTurn = (turn: Turn) => {
    const isOpen = openTurn === turn.key;
    const first = turn.events[0];
    const last = turn.events[turn.events.length - 1];
    const status = last.status ?? first.status;
    return (
      <li key={turn.key} className="rounded border">
        <button
          type="button"
          className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5 text-left text-xs hover:bg-muted/50"
          onClick={() => setOpenTurn(isOpen ? null : turn.key)}
        >
          <span className="font-mono text-muted-foreground">
            {formatTime(first.atMs)}
          </span>
          <span className="font-medium">
            {channelLabel(turn.appType, turn.providerId)}
          </span>
          <span className="truncate text-muted-foreground">
            {turn.model || "—"}
          </span>
          {renderPipeline(turn)}
          {status !== null && (
            <span
              className={`font-mono ${
                turn.hasError
                  ? "text-red-600 dark:text-red-400"
                  : "text-muted-foreground"
              }`}
            >
              {status}
            </span>
          )}
          {!turn.hasTerminal && (
            <span className="text-amber-600 dark:text-amber-500">
              {t(
                "settings.advanced.debugCapture.noTerminal",
                "无响应（流式或进行中）",
              )}
            </span>
          )}
          {turn.events.some((e) => e.truncated) && (
            <span className="text-amber-600 dark:text-amber-500">
              {t("settings.advanced.debugCapture.truncated", "已截断")}
            </span>
          )}
        </button>
        {isOpen && (
          <div className="space-y-2 border-t p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="break-all font-mono text-[11px] text-muted-foreground">
                {`session=${turn.sessionId || "—"} · ${t(
                  "settings.advanced.debugCapture.stepCount",
                  { n: turn.events.length, defaultValue: "{{n}} 步" },
                )}`}
              </span>
            </div>
            {turn.events.map((ev) => (
              <div key={ev.seq} className="rounded border bg-muted/30">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1 text-[11px]">
                  <Badge
                    className={`border-transparent px-1.5 py-0 ${KIND_CLASS[ev.kind]}`}
                  >
                    {kindLabel(ev.kind)}
                  </Badge>
                  <span className="font-mono text-muted-foreground">
                    {formatTime(ev.atMs)}
                  </span>
                  {ev.status !== null && (
                    <span className="font-mono text-muted-foreground">
                      {ev.status}
                    </span>
                  )}
                  <span className="truncate font-mono text-muted-foreground">
                    {ev.model || "—"}
                  </span>
                  {ev.kind === "response" && (
                    <span className="text-muted-foreground">
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
                      {t("settings.advanced.debugCapture.truncated", "已截断")}
                    </span>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto h-6 shrink-0 px-2 text-[11px]"
                    onClick={() => copyBody(ev.body)}
                  >
                    {t("common.copy")}
                  </Button>
                </div>
                <pre className="max-h-72 overflow-auto border-t bg-muted/50 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
                  {ev.body || "—"}
                </pre>
              </div>
            ))}
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

      {/* 捕获器不随开关隐藏：关闭只停新捕获，缓冲里的内容仍可回看。 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {!enabled && !allEmpty && (
              <Badge className="border-transparent bg-amber-500/15 px-1.5 py-0 text-[11px] text-amber-600 dark:text-amber-500">
                {t("settings.advanced.debugCapture.pausedBadge", "已暂停")}
              </Badge>
            )}
            <span className="truncate text-xs text-muted-foreground">
              {allEmpty
                ? enabled
                  ? t(
                      "settings.advanced.debugCapture.emptyToggle",
                      "开启后新请求将记录在下方",
                    )
                  : t(
                      "settings.advanced.debugCapture.emptyPaused",
                      "暂无捕获（开启开关后发请求即记录在这里）",
                    )
                : t("settings.advanced.debugCapture.count", {
                    n: chronological.length,
                    defaultValue: `已捕获 ${chronological.length} 条（最多保留 50 条）`,
                  })}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {channels.length > 1 && (
              <Select value={effectiveFilter} onValueChange={setChannelFilter}>
                <SelectTrigger className="h-7 w-[190px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {t("settings.advanced.debugCapture.filterAll", "全部渠道")}
                  </SelectItem>
                  {channels.map(([key, ch]) => (
                    <SelectItem key={key} value={key}>
                      {channelLabel(ch.appType, ch.providerId)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button
              size="sm"
              variant="outline"
              className="text-xs"
              disabled={allEmpty || clearCapture.isPending}
              onClick={() => clearCapture.mutate()}
            >
              {t("settings.advanced.debugCapture.clear")}
            </Button>
          </div>
        </div>

        {allEmpty ? (
          <div className="rounded-lg bg-muted/50 px-4 py-6 text-center text-xs text-muted-foreground">
            {t("settings.advanced.debugCapture.empty")}
          </div>
        ) : (
          <ul className="max-h-[30rem] space-y-1.5 overflow-auto">
            {turns.map(renderTurn)}
          </ul>
        )}
      </div>
    </div>
  );
}
