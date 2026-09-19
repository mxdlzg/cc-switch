import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { toast } from "sonner";
import { History } from "lucide-react";
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
import type {
  CaptureEvent,
  CaptureKind,
  StreamStats,
} from "@/lib/api/debugCapture";
import {
  useClearDebugCapture,
  useDebugCaptureEnabled,
  useDebugCaptureEvents,
  useSetDebugCaptureEnabled,
} from "@/lib/query/debugCapture";
import type { ReplaySnapshotInfo } from "@/lib/api/replay";
import { fetchReplaySnapshotInfo } from "@/lib/query/replay";
import { ReplayConfigDialog } from "@/components/settings/ReplayConfigDialog";

/** 各捕获步骤的徽章配色：错误一眼可辨，入站/出站/响应区分开。 */
const KIND_CLASS: Record<CaptureKind, string> = {
  client_request: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
  request: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  response: "bg-green-500/15 text-green-700 dark:text-green-400",
  error: "bg-red-500/15 text-red-600 dark:text-red-400",
  replay_response: "bg-teal-500/15 text-teal-700 dark:text-teal-400",
  // 流式响应：算成功，但和「有正文的响应」区分开，故另用一档青色。
  stream_response: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-400",
};

/**
 * 一轮问答 = **一次入站 HTTP 请求**（用户那一次回车），边界由后端 `turnId` 给出。
 *
 * 后端在 `RequestContext::new` 为每个入站请求发一个 turnId，本轮的入站/出站/响应/
 * 错误事件共享它。故障转移或整流的重复 forward 各留一份入站+出站，但同属一轮，
 * 所以列表里是一行、详情里是多个标签页（同类第 2 次起带 `(2)` 后缀）。
 *
 * 用 Map 按 turnId 归组，不用「相邻同 session」：并发请求的事件在环形缓冲里必然
 * 交错，只有身份键能把它们分回各自轮次；session 是整段对话，只当过滤维度。
 * 输入是 seq 升序，故每个 turn 的 events 天然保持时间正序。
 */
export interface Turn {
  /** 后端轮次号：一行一个号，就是用户的那一次回车 */
  turnId: number;
  events: CaptureEvent[];
  sessionId: string;
  appType: string;
  /** 本轮出现过的供应商（按首次出现顺序）；故障转移跨供应商时长度 > 1 */
  providerIds: string[];
  model: string;
  /** 本轮最终成功（有 response / replay_response / 2xx 流式条目） */
  succeeded: boolean;
  /** 本轮以失败收尾：有 error 且本轮没有任何成功条目——故障转移救回的一轮不算失败 */
  errored: boolean;
  /** 行首要展示的状态码：成功取最后一条成功条目的状态，否则取最后一条错误的 */
  shownStatus: number | null;
  /** 本轮内部的失败条目数（故障转移/整流的每一击各一条）；成功时也要显示 */
  failedAttempts: number;
  /** 有终态事件（response / error / replay_response / stream_response） */
  hasTerminal: boolean;
  /** 结局那一步的 kind（故障转移救回=replay/response，纯失败=error）；未定局=null */
  terminalKind: CaptureKind | null;
  /**
   * 结局是流式条目时的收尾统计（块数/字节/耗时/怎么收尾）；其它结局=null。
   *
   * `terminalKind === "stream_response"` 而这里是 null，说明流还在跑、后端尚未回填。
   */
  terminalStream: StreamStats | null;
  /** 可重放的出站请求条目 seq（没有出站请求条目则为 null） */
  replayableSeq: number | null;
}

/** 终态条目：客户端能拿到的结果——非流式响应、错误体、重放响应、流式响应。
 *
 * 流式条目必须是终态：上游回 200 + `text/event-stream` 时这一轮已经定局（响应到了，
 * 只是正文不抓）。把它排除在外，正是「流式那一轮显示成无响应」的根源。
 */
function isTerminal(ev: CaptureEvent): boolean {
  return (
    ev.kind === "response" ||
    ev.kind === "error" ||
    ev.kind === "replay_response" ||
    ev.kind === "stream_response"
  );
}

/** 流式条目也带状态码；非 2xx 的流（少见）算失败那一击，不算成功。 */
function isStreamSuccess(ev: CaptureEvent): boolean {
  return ev.status !== null && ev.status >= 200 && ev.status < 300;
}

/** 本轮的「成功条目」：非流式响应、重放响应、2xx 流式响应。 */
export function isSuccessEntry(ev: CaptureEvent): boolean {
  return (
    ev.kind === "response" ||
    ev.kind === "replay_response" ||
    (ev.kind === "stream_response" && isStreamSuccess(ev))
  );
}

/** 本轮的「失败条目」：错误体，或非 2xx 的流式响应。每一击都算一次尝试。 */
export function isFailureEntry(ev: CaptureEvent): boolean {
  return (
    ev.kind === "error" ||
    (ev.kind === "stream_response" && !isStreamSuccess(ev))
  );
}

export function buildTurns(events: CaptureEvent[]): Turn[] {
  const byTurn = new Map<number, Turn>();
  for (const ev of events) {
    let turn = byTurn.get(ev.turnId);
    if (!turn) {
      turn = {
        turnId: ev.turnId,
        events: [],
        sessionId: ev.sessionId,
        appType: ev.appType,
        providerIds: [],
        model: "",
        succeeded: false,
        errored: false,
        shownStatus: null,
        failedAttempts: 0,
        hasTerminal: false,
        terminalKind: null,
        terminalStream: null,
        replayableSeq: null,
      };
      byTurn.set(ev.turnId, turn);
    }
    turn.events.push(ev);
    if (isTerminal(ev)) turn.hasTerminal = true;
    if (!turn.providerIds.includes(ev.providerId)) {
      turn.providerIds.push(ev.providerId);
    }
    // 模型名以出站上送的那条为准（映射后的名字），其次任意非空。
    if (ev.kind === "request" && ev.model) turn.model = ev.model;
    else if (!turn.model && ev.model) turn.model = ev.model;
    if (ev.kind === "request") {
      // 快照 keyed by 这条的 seq。能不能真重放要问后端（快照可能因 body 超过 8 MiB
      // 硬顶而没存）；呈现层的 truncated 与此无关（那是 200k 字符的展示截断，
      // 快照存的是完整字节），故此处不按 truncated 预判。
      turn.replayableSeq = ev.seq;
    }
  }

  // 结局要按时间看完全部事件才能定：故障转移的一轮常是「error(429) → response(200)」，
  // 只要出现过成功条目，这一轮就是成功的（后面的成功盖掉前面的失败）。
  for (const turn of byTurn.values()) {
    const successes = turn.events.filter(isSuccessEntry);
    const errors = turn.events.filter(isFailureEntry);
    turn.succeeded = successes.length > 0;
    turn.failedAttempts = errors.length;
    turn.errored = !turn.succeeded && errors.length > 0;
    const outcome =
      successes[successes.length - 1] ?? errors[errors.length - 1];
    turn.terminalKind = outcome ? outcome.kind : null;
    turn.shownStatus = outcome?.status ?? null;
    // 结局是流式时，收尾统计（块数/字节/耗时/怎么结束）跟着一起带出去：行首
    // 状态码是 200 不代表流跑完了，卡住/被断开的痕迹只能靠 outcome 说明。
    turn.terminalStream = outcome?.stream ?? null;
  }
  return [...byTurn.values()];
}

/**
 * 标签页标题：同一轮内同类事件可能有多份（故障转移/整流每次重试各留一份入站与
 * 出站），只写「上游」会让人以为只有一个，故第 2 次起带 `(2)`、`(3)`。
 *
 * 刻意不用 `#N`：`#` 在本查看器里专指轮次号（行首那个），两个含义撞车更难读。
 */
function tabLabelOf(
  kind: CaptureKind,
  occurrence: number,
  kindLabel: (kind: CaptureKind) => string,
): string {
  return occurrence > 0
    ? `${kindLabel(kind)} (${occurrence + 1})`
    : kindLabel(kind);
}

function channelKeyOf(ev: { appType: string; providerId: string }): string {
  return `${ev.appType}/${ev.providerId}`;
}

/**
 * 流式收尾的一行摘要：`1.2s · 48 块 · 23.1 KB · 正常结束`（`counts:false` 时省掉
 * 块数与字节，列表行放不下那么多字，详情标签页里才摊全）。
 *
 * 刻意把 outcome 翻成人话而不是裸枚举：用户要区分「流跑完了」和「卡住被超时掐了 /
 * 客户端断了」，只看 200 是看不出来的。统计缺失（流还在跑）时只说进行中。
 */
function streamBrief(
  stats: StreamStats | null,
  t: TFunction,
  opts: { counts?: boolean } = {},
): string {
  if (!stats)
    return t("settings.advanced.debugCapture.stream.running", "流式进行中");
  const parts = [`${(stats.elapsedMs / 1000).toFixed(1)}s`];
  if (opts.counts !== false) {
    parts.push(
      t("settings.advanced.debugCapture.stream.chunks", {
        n: stats.chunks,
        defaultValue: `${stats.chunks} chunks`,
      }),
      formatBytes(stats.bytes),
    );
  }
  parts.push(
    t(`settings.advanced.debugCapture.stream.outcome.${stats.outcome}`),
  );
  return parts.join(" · ");
}

/** 与 BackupListSection 同口径的字节格式化（此处只需 KB/MB 两档常用量级）。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
  const [selectedTurnId, setSelectedTurnId] = useState<number | null>(null);
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

  // 面板上的计数用**未筛选**的全量：条数是捕获条目数（一轮常占 3 条），轮数才是
  // 用户认识的「问答次数」——只报条数正是他数不出几轮的原因。
  const allTurnCount = useMemo(
    () => buildTurns(chronological).length,
    [chronological],
  );

  // 选中项可能因清空/滚动而消失，回退到最新一条（同样避免渲染期 setState）。
  const selected =
    turns.find((turn) => turn.turnId === selectedTurnId) ?? turns[0] ?? null;

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

  // ── 重放 ────────────────────────────────────────────────────────────────
  const [replayTarget, setReplayTarget] = useState<{
    seq: number;
    info: ReplaySnapshotInfo;
  } | null>(null);

  /**
   * 点「重放」：先向后端确认这条真有快照。抓取自能存快照的版本上线之前、或 body
   * 超过快照硬顶的条目拿不到快照 —— 这时给提示而不是开一个必然失败的弹窗。
   */
  const onReplayRequest = async (turn: Turn) => {
    if (turn.replayableSeq === null) return;
    try {
      const info = await fetchReplaySnapshotInfo(turn.replayableSeq);
      if (!info.available) {
        toast.error(t("replay.noSnapshot"));
        return;
      }
      setReplayTarget({ seq: turn.replayableSeq, info });
    } catch (e) {
      toast.error(String(e));
    }
  };

  const allEmpty = chronological.length === 0;

  /** 列表行里的管道进度：客户端→上游→响应，缺的那步标灰。 */
  const renderPipeline = (turn: Turn) => {
    // 末步按**结局**取：故障转移的一轮既有 error 又有 response，成功了就该亮「响应」；
    // 重放产物那一轮亮「重放」。还没定局（流式/在途）时亮灰的「响应」。
    const lastKind: CaptureKind = turn.terminalKind ?? "response";
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
    const active = selected?.turnId === turn.turnId;
    const head = turn.events[0];
    const status = turn.shownStatus;
    return (
      <li key={turn.turnId} className="flex items-stretch">
        <button
          type="button"
          onClick={() => setSelectedTurnId(turn.turnId)}
          className={`min-w-0 flex-1 rounded px-2 py-1.5 text-left text-xs hover:bg-muted/60 ${
            active ? "bg-muted" : ""
          }`}
        >
          <div className="flex items-center gap-2">
            {/* 轮次号 = 后端 turn_id，一行一个号 = 用户的一次回车。故障转移重试不
                另起行，只在本行的标签页里多出 (2)/(3)。 */}
            <span className="font-mono text-muted-foreground/70">
              #{turn.turnId}
            </span>
            <span className="font-mono text-muted-foreground">
              {formatTime(head.atMs)}
            </span>
            {status !== null ? (
              <span
                className={`font-mono ${
                  turn.errored
                    ? "text-red-600 dark:text-red-400"
                    : "text-muted-foreground"
                }`}
              >
                {status}
              </span>
            ) : (
              <span className="text-amber-600 dark:text-amber-500">—</span>
            )}
            {/* 本轮内部失败过几次（故障转移/整流重试）。成功时也标出来：否则
                「200」看起来像一次就成了，看不出前面还撞了两次 429。 */}
            {turn.failedAttempts > 0 && (
              <span
                className="font-mono text-amber-600 dark:text-amber-500"
                title={t("settings.advanced.debugCapture.attemptNote", {
                  // 与徽章同口径：说的是这一轮一共试了几次（含成功的那一次），
                  // 不是失败次数——徽章写 ×3 而提示写「2 次失败」会自相矛盾。
                  n: turn.failedAttempts + 1,
                  defaultValue: `本轮共尝试 ${turn.failedAttempts + 1} 次（故障转移/整流重试）`,
                })}
              >
                ×{turn.failedAttempts + 1}
              </span>
            )}
            <span className="truncate font-medium">{turn.model || "—"}</span>
            {/* 流式那一轮：状态码是 200 不代表流跑完了，把耗时/结局就地露出来。
                统计没回填（流还在跑）时只说「进行中」，不假装有数据。 */}
            {turn.terminalKind === "stream_response" && (
              <span className="shrink-0 truncate font-mono text-muted-foreground">
                {streamBrief(turn.terminalStream, t, { counts: false })}
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="truncate text-muted-foreground">
              {channelLabel(turn.appType, turn.providerIds[0] ?? "")}
              {/* 故障转移：本轮真实试过的供应商不止一个，标出总数 */}
              {turn.providerIds.length > 1 && (
                <span className="text-amber-600 dark:text-amber-500">
                  {" "}
                  +{turn.providerIds.length - 1}
                </span>
              )}
            </span>
            {renderPipeline(turn)}
          </div>
        </button>
        {/* 重放入口：整宽按钮里不能再嵌 button，故本行改成 flex 兄弟节点。
            没有出站请求条目（如只抓到客户端入站）就没有可重放的东西。 */}
        {turn.replayableSeq !== null && (
          <Button
            size="sm"
            variant="ghost"
            className="h-auto w-9 shrink-0 self-center px-0 text-[11px] text-muted-foreground hover:text-foreground"
            title={t("replay.tip")}
            onClick={() => onReplayRequest(turn)}
          >
            <History className="h-3.5 w-3.5" />
          </Button>
        )}
      </li>
    );
  };

  /**
   * 右列详情。`key={turn.turnId}` 让 Tabs 在换轮次时重挂载，从而 defaultValue
   * 重新生效——默认落在终态那步（响应/错误），不必每次手动点。
   */
  const renderDetail = (turn: Turn) => {
    // 默认落在**结局**那一条：成功看最后一条响应（故障转移时最后那次才是真结果），
    // 失败看最后一条错误，流式那轮落在流式条目上（那里写着「正文不捕获」+ 统计）。
    const lastOf = (kind: CaptureKind) =>
      [...turn.events].reverse().find((e) => e.kind === kind);
    const defaultTab = turn.succeeded
      ? (lastOf("response")?.seq ??
        lastOf("replay_response")?.seq ??
        lastOf("stream_response")?.seq)
      : turn.errored
        ? (lastOf("error")?.seq ?? lastOf("stream_response")?.seq)
        : undefined;
    const fallbackTab = turn.events[turn.events.length - 1].seq;
    // 同类事件的出现序号（供标签页打 #N）：一次换键 precompute，不在 map 里数。
    const occurrences = new Map<number, number>();
    const seen = new Map<CaptureKind, number>();
    turn.events.forEach((ev, i) => {
      const n = seen.get(ev.kind) ?? 0;
      occurrences.set(i, n);
      seen.set(ev.kind, n + 1);
    });
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-xs">
          <span className="font-medium">
            {channelLabel(turn.appType, turn.providerIds[0] ?? "")}
            {turn.providerIds.length > 1 && (
              <span className="text-amber-600 dark:text-amber-500">
                {" "}
                +{turn.providerIds.length - 1}
              </span>
            )}
          </span>
          <span className="font-mono text-muted-foreground">
            {turn.model || "—"}
          </span>
          <span className="break-all font-mono text-muted-foreground">
            {`session=${turn.sessionId || "—"}`}
          </span>
          <span className="font-mono text-muted-foreground">
            {`#${turn.turnId}`}
          </span>
          {renderPipeline(turn)}
        </div>
        <Tabs
          key={turn.turnId}
          defaultValue={String(defaultTab ?? fallbackTab)}
          className="flex min-h-0 flex-1 flex-col"
        >
          {/* 故障转移/整流的一轮可能有好几个标签页，原语给了每个 trigger
              min-w-[120px] 且不换行，会横向撑出弹窗；这里就地换行（不动原语，
              别处的 Tabs 不需要换行）。 */}
          <TabsList className="mx-4 mt-2 max-w-[calc(100%-2rem)] flex-wrap justify-start self-start">
            {turn.events.map((ev, i) => (
              <TabsTrigger
                key={ev.seq}
                value={String(ev.seq)}
                className="gap-1.5"
              >
                {tabLabelOf(ev.kind, occurrences.get(i) ?? 0, kindLabel)}
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
                    {(ev.kind === "response" ||
                      ev.kind === "stream_response") && (
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
                    {ev.kind === "replay_response" && (
                      <span>{t("replay.fromReplay")}</span>
                    )}
                    {/* 流式条目：把收尾统计摊开。没回填就是流还在跑，直说进行中。 */}
                    {ev.kind === "stream_response" && (
                      <span className="font-mono">
                        {streamBrief(ev.stream ?? null, t)}
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
                  {/* 流式条目没有正文，复制按钮无处发力，直接不给。 */}
                  {ev.kind !== "stream_response" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 shrink-0 px-2 text-[11px]"
                      onClick={() => copyBody(ev.body)}
                    >
                      {t("common.copy")}
                    </Button>
                  )}
                </div>
                {/* 弹窗内唯一的正文滚动区：不再叠 max-h，撑满右列即可。
                    流式条目走另一块：那里讲「为什么不存正文」+ 结局，而不是空一片
                    让用户以为没响应——这正是本次改动要修掉的误读。 */}
                {ev.kind === "stream_response" ? (
                  <div className="mx-4 mb-4 flex-1 overflow-auto rounded bg-muted/50 p-3 text-[11px] leading-relaxed">
                    <p className="font-medium">
                      {t(
                        "settings.advanced.debugCapture.stream.title",
                        "流式响应（SSE）：正文不捕获",
                      )}
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      {t(
                        "settings.advanced.debugCapture.stream.hint",
                        "上游已返回上面那个状态码，所以这一轮是有响应的；SSE 体积大且不是排查目标，故只记元信息与收尾统计。",
                      )}
                    </p>
                    <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono">
                      <dt className="text-muted-foreground">
                        {t("settings.advanced.debugCapture.stream.elapsed")}
                      </dt>
                      <dd>
                        {ev.stream
                          ? `${(ev.stream.elapsedMs / 1000).toFixed(1)}s`
                          : "—"}
                      </dd>
                      <dt className="text-muted-foreground">
                        {t("settings.advanced.debugCapture.stream.chunksLabel")}
                      </dt>
                      <dd>{ev.stream?.chunks ?? "—"}</dd>
                      <dt className="text-muted-foreground">
                        {t("settings.advanced.debugCapture.stream.bytesLabel")}
                      </dt>
                      <dd>{ev.stream ? formatBytes(ev.stream.bytes) : "—"}</dd>
                      <dt className="text-muted-foreground">
                        {t(
                          "settings.advanced.debugCapture.stream.outcomeLabel",
                        )}
                      </dt>
                      <dd>
                        {ev.stream
                          ? t(
                              `settings.advanced.debugCapture.stream.outcome.${ev.stream.outcome}`,
                            )
                          : t(
                              "settings.advanced.debugCapture.stream.running",
                              "流式进行中",
                            )}
                      </dd>
                    </dl>
                  </div>
                ) : (
                  <pre className="mx-4 mb-4 flex-1 overflow-auto rounded bg-muted/50 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
                    {ev.body || "—"}
                  </pre>
                )}
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
            turns: allTurnCount,
            defaultValue: `已捕获 ${chronological.length} 条 / ${allTurnCount} 轮（条目最多保留 50 条）`,
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
            {/* 用户在这里最容易迷失的是「哪个是一轮」：轮次号由后端按入站请求发号，
                一句话讲清「一行 = 一次请求」以及重试为什么不另起行。 */}
            <p className="text-xs text-muted-foreground">
              {t(
                "settings.advanced.debugCapture.turnLegend",
                "一行 = 一次请求（# 是它的轮次号）。故障转移/整流的重试仍在这一行里，只多开几个标签页，不会另起一行。",
              )}
            </p>
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

      <ReplayConfigDialog
        open={replayTarget !== null}
        onOpenChange={(open) => {
          if (!open) setReplayTarget(null);
        }}
        seq={replayTarget?.seq ?? null}
        info={replayTarget?.info ?? null}
      />
    </div>
  );
}
