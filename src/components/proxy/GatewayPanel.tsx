import { useMemo, useState } from "react";
import {
  Copy,
  RefreshCw,
  KeyRound,
  Loader2,
  Eye,
  EyeOff,
  CircleHelp,
  Plus,
  Trash2,
  Pencil,
  Check,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleRow } from "@/components/ui/toggle-row";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "sonner";
import {
  useGatewayInfo,
  useGatewayProviderOptions,
  useGatewayProviderModels,
  useRotateGatewayToken,
  useSetGatewayToken,
  useSetGatewayEnabled,
  useSetGatewayCatalog,
} from "@/lib/query/gateway";
import type {
  GatewayCatalogEntry,
  GatewayNamespaceInfo,
  GatewayProviderOption,
} from "@/lib/api/gateway";
import { useProxyStatusQuery, useGlobalProxyConfig } from "@/lib/query/proxy";

/**
 * 本地网关设置面板。
 *
 * 网关是「接管」之外的额外能力：不写任何 CLI 的 Live 配置文件，只是把 cc-switch
 * 已有的供应商 + 协议转换能力，用一个 Bearer token 额外暴露成 `/gateway/*` 端点，
 * 供第三方工具接入。因此这里的开关与首页供应商选择、接管开关完全解耦。
 *
 * 每个 namespace 持有一张 model → provider 目录：客户端请求某 model 命中目录才
 * 路由，未命中（含空目录）一律 404。目录以「草稿 + 保存」方式编辑。
 */

/** namespace → 展示用方言标签。 */
const NAMESPACE_LABELS: Record<string, string> = {
  claude: "Anthropic Messages",
  codex: "OpenAI Responses / Chat",
  gemini: "Gemini",
  grokbuild: "OpenAI Responses",
};

/**
 * 该 namespace 客户端该填的 base URL。
 *
 * 各家 SDK 拼路径的方式不同，这里给出「填到工具里就对的」形态：
 * - Claude 系：填到 `{origin}/gateway/claude`（客户端再补 `/v1/messages`）
 * - Codex / Grok：Responses 客户端填 `{origin}/gateway/<ns>/v1`
 * - Gemini SDK：填 `{origin}/gateway/gemini/v1beta`
 */
function gatewayBaseUrl(origin: string, namespace: string): string {
  switch (namespace) {
    case "claude":
      return `${origin}/gateway/claude`;
    case "codex":
      return `${origin}/gateway/codex/v1`;
    case "grokbuild":
      return `${origin}/gateway/grokbuild/v1`;
    case "gemini":
      return `${origin}/gateway/gemini/v1beta`;
    default:
      return `${origin}/gateway/${namespace}`;
  }
}

function formatAddressForUrl(address: string, port: number): string {
  const isIPv6 = address.includes(":");
  const host = isIPv6 ? `[${address}]` : address;
  return `http://${host}:${port}`;
}

/**
 * 监听地址是否为环回（仅本机可访问）。
 *
 * `0.0.0.0` / `::` 是「监听全部网卡」，不是环回，因此返回 false。
 * 只有环回之外才需要提示暴露风险——网关本身有 token，但同端口上的
 * `/health`、`/status` 及全部接管路由都**无鉴权**，局域网内可见供应商拓扑。
 */
function isLoopbackAddress(address: string): boolean {
  const trimmed = address.trim();
  if (trimmed === "localhost") return true;
  if (trimmed.startsWith("127.")) return true;
  if (trimmed === "::1") return true;
  return false;
}

/** 下拉框里表示「未选择」的哨兵值（Radix Select 不允许空字符串 value）。 */
const NONE_VALUE = "__gateway_none__";

/** 复制到剪贴板并弹提示。`label` 由调用方翻译好传入。 */
function copyToClipboard(text: string, label: string) {
  navigator.clipboard.writeText(text);
  toast.success(label, { closeButton: true });
}

interface NamespaceCatalogProps {
  ns: GatewayNamespaceInfo;
  providers: GatewayProviderOption[];
  baseUrl: string;
  origin: string;
}

/**
 * 单个 namespace 的目录编辑器。
 *
 * 持有本地草稿（draft），点「保存」才整表覆盖写入——避免每勾一个模型就发一次
 * 全量覆盖 mutation。草稿初值来自服务端目录；本组件按 namespace 加 key 挂载，
 * 重新进入面板即与服务端对齐。
 */
function NamespaceCatalog({
  ns,
  providers,
  baseUrl,
  origin,
}: NamespaceCatalogProps) {
  const { t } = useTranslation();
  const setCatalog = useSetGatewayCatalog();

  const [draft, setDraft] = useState<GatewayCatalogEntry[]>(ns.catalog);
  // 拉取模型列表的「来源供应商」——勾选/手动添加的条目都归到它名下。纯 UI 态，
  // 不落库（落库的是每条 model 各自的 providerId）。
  const [sourceId, setSourceId] = useState<string>("");
  const [manualModel, setManualModel] = useState("");

  const sourceProviderId = sourceId === NONE_VALUE ? null : sourceId || null;
  const modelsQuery = useGatewayProviderModels(
    ns.namespace,
    sourceProviderId,
    // 只在选了来源且该来源尚未拉过时才请求，避免每次打开面板都打上游。
    Boolean(sourceProviderId),
  );

  const draftModels = useMemo(
    () => new Set(draft.map((e) => e.model)),
    [draft],
  );
  const providerNameOf = (id: string) =>
    providers.find((p) => p.id === id)?.name ?? id;

  const dirty =
    draft.length !== ns.catalog.length ||
    draft.some(
      (e, i) =>
        ns.catalog[i]?.model !== e.model ||
        ns.catalog[i]?.providerId !== e.providerId,
    );

  const toggleModel = (model: string, checked: boolean) => {
    setDraft((prev) => {
      if (checked) {
        if (!sourceProviderId || prev.some((e) => e.model === model)) {
          return prev;
        }
        return [...prev, { model, providerId: sourceProviderId }];
      }
      return prev.filter((e) => e.model !== model);
    });
  };

  const selectAllFetched = () => {
    if (!sourceProviderId) return;
    const fetched = modelsQuery.data ?? [];
    setDraft((prev) => {
      const known = new Set(prev.map((e) => e.model));
      const added = fetched
        .filter((m) => !known.has(m.id))
        .map((m) => ({ model: m.id, providerId: sourceProviderId }));
      return added.length ? [...prev, ...added] : prev;
    });
  };

  const addManual = () => {
    const model = manualModel.trim();
    if (!model || !sourceProviderId || draftModels.has(model)) return;
    setDraft((prev) => [...prev, { model, providerId: sourceProviderId }]);
    setManualModel("");
  };

  const removeEntry = (model: string) =>
    setDraft((prev) => prev.filter((e) => e.model !== model));

  const save = () =>
    setCatalog.mutate({ namespace: ns.namespace, entries: draft });

  const fetchedModels = modelsQuery.data ?? [];

  return (
    <div className="rounded-lg border border-border bg-card/50 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold capitalize">{ns.namespace}</span>
        <Badge variant="secondary" className="font-normal">
          {NAMESPACE_LABELS[ns.namespace] ?? ns.namespace}
        </Badge>
      </div>

      {/* 模型来源供应商：拉取列表 + 新条目的归属 */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">
          {t("gateway.catalog.sourceLabel", {
            defaultValue: "模型来源供应商（用于拉取列表 / 归属新条目）",
          })}
        </Label>
        <Select
          value={sourceProviderId ?? NONE_VALUE}
          onValueChange={(value) =>
            setSourceId(value === NONE_VALUE ? "" : value)
          }
          disabled={providers.length === 0}
        >
          <SelectTrigger className="w-full">
            <SelectValue
              placeholder={
                providers.length === 0
                  ? t("gateway.provider.noneAvailable", {
                      defaultValue: "该应用下还没有供应商",
                    })
                  : t("gateway.provider.pick", {
                      defaultValue: "选择供应商…",
                    })
              }
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>
              {t("gateway.provider.unset", { defaultValue: "（未选择）" })}
            </SelectItem>
            {providers.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* 拉取模型列表 → 勾选暴露 */}
      {sourceProviderId && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs text-muted-foreground">
              {t("gateway.catalog.fetchLabel", {
                defaultValue: "从该供应商拉取的模型（勾选以暴露）",
              })}
            </Label>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={selectAllFetched}
              disabled={fetchedModels.length === 0}
            >
              {t("gateway.catalog.selectAll", { defaultValue: "全选" })}
            </Button>
          </div>

          {modelsQuery.isFetching ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("gateway.catalog.fetching", { defaultValue: "正在拉取…" })}
            </div>
          ) : modelsQuery.isError ? (
            <p className="text-xs text-yellow-600 dark:text-yellow-400">
              {t("gateway.catalog.fetchFailed", {
                error:
                  (modelsQuery.error as Error)?.message ??
                  t("gateway.catalog.unknownError", {
                    defaultValue: "未知错误",
                  }),
                defaultValue: "拉取失败：{{error}}。可在下方手动填写模型名。",
              })}
            </p>
          ) : fetchedModels.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("gateway.catalog.fetchEmpty", {
                defaultValue: "该供应商未返回模型列表，可在下方手动填写。",
              })}
            </p>
          ) : (
            <ScrollArea className="h-40 rounded border border-border/60">
              <div className="divide-y divide-border/40">
                {fetchedModels.map((m) => (
                  <label
                    key={m.id}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-muted/40"
                  >
                    <Checkbox
                      checked={draftModels.has(m.id)}
                      onCheckedChange={(checked) => toggleModel(m.id, checked)}
                    />
                    <span className="font-mono text-xs truncate">{m.id}</span>
                  </label>
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      )}

      {/* 手动添加（动态 token 供应商 / 未列出的模型兜底） */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">
          {t("gateway.catalog.manualLabel", { defaultValue: "手动添加模型" })}
        </Label>
        <div className="flex items-center gap-2">
          <Input
            value={manualModel}
            onChange={(e) => setManualModel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addManual();
              }
            }}
            placeholder={t("gateway.catalog.manualPlaceholder", {
              defaultValue: "模型名，如 claude-opus-4-1",
            })}
            disabled={!sourceProviderId}
            className="font-mono text-sm"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={addManual}
            disabled={
              !sourceProviderId ||
              !manualModel.trim() ||
              draftModels.has(manualModel.trim())
            }
          >
            <Plus className="mr-1.5 h-4 w-4" />
            {t("common.add", { defaultValue: "添加" })}
          </Button>
        </div>
        {!sourceProviderId && (
          <p className="text-xs text-muted-foreground">
            {t("gateway.catalog.needSource", {
              defaultValue: "先选择来源供应商，每个模型都要归属一个供应商。",
            })}
          </p>
        )}
      </div>

      {/* 当前目录（草稿） */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs text-muted-foreground">
            {t("gateway.catalog.currentLabel", {
              defaultValue: "当前目录（{{count}}）",
              count: draft.length,
            })}
          </Label>
          {draft.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => setDraft([])}
            >
              {t("gateway.catalog.clear", { defaultValue: "清空" })}
            </Button>
          )}
        </div>

        {draft.length === 0 ? (
          <p className="text-xs text-yellow-600 dark:text-yellow-400">
            {t("gateway.catalog.emptyWarning", {
              defaultValue: "目录为空：该端点所有请求都会返回 404。",
            })}
          </p>
        ) : (
          <ScrollArea className="max-h-48 rounded border border-border/60">
            <div className="divide-y divide-border/40">
              {draft.map((e) => (
                <div
                  key={e.model}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm"
                >
                  <span className="font-mono text-xs flex-1 truncate">
                    {e.model}
                  </span>
                  <span className="text-xs text-muted-foreground truncate max-w-[45%]">
                    → {providerNameOf(e.providerId)}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-red-500"
                    onClick={() => removeEntry(e.model)}
                    aria-label={t("gateway.catalog.remove", {
                      defaultValue: "移除",
                    })}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>

      {/* 保存 */}
      <div className="flex items-center justify-end gap-2 pt-1">
        {dirty && (
          <span className="text-xs text-muted-foreground">
            {t("gateway.catalog.unsaved", { defaultValue: "有未保存的改动" })}
          </span>
        )}
        <Button
          size="sm"
          onClick={save}
          disabled={!dirty || setCatalog.isPending}
        >
          {setCatalog.isPending ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : null}
          {t("common.save", { defaultValue: "保存" })}
        </Button>
      </div>

      {/* base URL */}
      <div className="space-y-1.5 pt-1 border-t border-border/40">
        <Label className="text-xs text-muted-foreground">
          {t("gateway.baseUrl.label", { defaultValue: "Base URL" })}
        </Label>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-xs bg-background px-3 py-2 rounded border border-border/60 break-all">
            {baseUrl}
          </code>
          <Button
            size="sm"
            variant="outline"
            disabled={!origin}
            onClick={() =>
              copyToClipboard(
                baseUrl,
                t("gateway.baseUrl.copied", { defaultValue: "地址已复制" }),
              )
            }
          >
            <Copy className="mr-1.5 h-4 w-4" />
            {t("common.copy")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function GatewayPanel() {
  const { t } = useTranslation();
  const { data: status } = useProxyStatusQuery();
  const isRunning = status?.running ?? false;

  // 运行中用真实监听地址；停止时回落到「已配置的」地址端口（即下次启动会用的），
  // 这样 base URL 任何时候都是完整可用的，而不是复制出一段相对路径。
  const { data: globalConfig } = useGlobalProxyConfig();
  const effective =
    status && isRunning
      ? { address: status.address, port: status.port }
      : globalConfig
        ? { address: globalConfig.listenAddress, port: globalConfig.listenPort }
        : null;
  const origin = effective
    ? formatAddressForUrl(effective.address, effective.port)
    : "";

  const { data: info, isLoading } = useGatewayInfo();
  const { data: options = [] } = useGatewayProviderOptions();

  const setEnabled = useSetGatewayEnabled();
  const rotateToken = useRotateGatewayToken();
  const setToken = useSetGatewayToken();

  const [showToken, setShowToken] = useState(false);
  const [editingToken, setEditingToken] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");

  // 与后端 validate_gateway_token 同规则的前端预检：可见 ASCII（不含空格）、
  // 8-256 字符。返回可读错误串或 null（合法）。仅为即时反馈，保存仍以后端为准。
  const tokenDraftError = useMemo(() => {
    const t = tokenDraft.trim();
    if (t.length === 0) {
      return { key: "gateway.token.empty", zh: "令牌不能为空" };
    }
    if (!/^[\x21-\x7E]+$/.test(t)) {
      return {
        key: "gateway.token.invalidChars",
        zh: "只能包含可见 ASCII 字符（不含空格）",
      };
    }
    if (t.length < 8 || t.length > 256) {
      return {
        key: "gateway.token.badLength",
        zh: "长度需为 8-256 个字符",
      };
    }
    return null;
  }, [tokenDraft]);

  const startEditToken = () => {
    setTokenDraft(info?.token ?? "");
    setEditingToken(true);
  };
  const saveToken = () => {
    if (tokenDraftError) return;
    setToken.mutate(tokenDraft.trim(), {
      onSuccess: () => setEditingToken(false),
    });
  };

  const providersFor = (namespace: string) =>
    options.filter((o) => o.namespace === namespace);

  return (
    <div className="space-y-6">
      {/* 总开关 */}
      <ToggleRow
        icon={<KeyRound className="h-4 w-4 text-blue-500" />}
        title={t("gateway.enable.title", { defaultValue: "启用本地网关" })}
        description={t("gateway.enable.description", {
          defaultValue:
            "额外暴露一组带鉴权的 /gateway/* 端点供第三方工具使用。不会改动任何被 cc-switch 管理的 CLI 配置。",
        })}
        checked={info?.enabled ?? false}
        onCheckedChange={(checked) => setEnabled.mutate(checked)}
        disabled={setEnabled.isPending}
      />

      {!isRunning && (
        <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
          <p className="text-sm text-yellow-600 dark:text-yellow-400">
            {t("gateway.needsRunning", {
              defaultValue: "需要先启动本地路由服务，网关端点才会开始监听。",
            })}
          </p>
        </div>
      )}

      {info?.enabled &&
        effective !== null &&
        !isLoopbackAddress(effective.address) && (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 space-y-1">
            <p className="text-sm font-medium text-red-600 dark:text-red-400">
              {t("gateway.lanWarning.title", {
                defaultValue: "监听地址不是环回地址，局域网内可访问",
              })}
            </p>
            <p className="text-xs text-red-600/90 dark:text-red-400/90">
              {t("gateway.lanWarning.body", {
                defaultValue:
                  "网关端点有令牌保护，但同一端口上的 /health、/status 及各接管路由均无鉴权，会向局域网暴露供应商信息。建议把监听地址改回 127.0.0.1。",
              })}
            </p>
          </div>
        )}

      {isLoading || !info ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("common.loading", { defaultValue: "加载中…" })}
        </div>
      ) : (
        <>
          {/* 访问令牌 */}
          <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Label className="text-sm font-semibold">
                {t("gateway.token.title", { defaultValue: "访问令牌" })}
              </Label>
              <TooltipProvider delayDuration={250}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <CircleHelp className="h-3.5 w-3.5 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent>
                    {t("gateway.token.hint", {
                      defaultValue:
                        "第三方请求需在请求头携带：Authorization: Bearer <令牌>",
                    })}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              {editingToken ? (
                <>
                  <Input
                    autoFocus
                    value={tokenDraft}
                    onChange={(e) => setTokenDraft(e.target.value)}
                    placeholder={t("gateway.token.editPlaceholder", {
                      defaultValue: "输入新的访问令牌",
                    })}
                    className={`font-mono text-sm ${
                      tokenDraftError ? "border-red-500" : ""
                    }`}
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={saveToken}
                      disabled={!!tokenDraftError || setToken.isPending}
                    >
                      {setToken.isPending ? (
                        <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="mr-1.5 h-4 w-4" />
                      )}
                      {t("common.save", { defaultValue: "保存" })}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEditingToken(false)}
                      disabled={setToken.isPending}
                    >
                      <X className="mr-1.5 h-4 w-4" />
                      {t("common.cancel", { defaultValue: "取消" })}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <Input
                    readOnly
                    value={
                      showToken
                        ? info.token
                        : "•".repeat(Math.min(info.token.length, 40))
                    }
                    className="font-mono text-sm"
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setShowToken((v) => !v)}
                      aria-label={t("gateway.token.toggle", {
                        defaultValue: "显示/隐藏令牌",
                      })}
                    >
                      {showToken ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        copyToClipboard(
                          info.token,
                          t("gateway.token.copied", {
                            defaultValue: "令牌已复制",
                          }),
                        )
                      }
                    >
                      <Copy className="mr-1.5 h-4 w-4" />
                      {t("common.copy")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={startEditToken}
                    >
                      <Pencil className="mr-1.5 h-4 w-4" />
                      {t("gateway.token.edit", { defaultValue: "自定义" })}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => rotateToken.mutate()}
                      disabled={rotateToken.isPending}
                    >
                      {rotateToken.isPending ? (
                        <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-1.5 h-4 w-4" />
                      )}
                      {t("gateway.token.rotate", { defaultValue: "轮换" })}
                    </Button>
                  </div>
                </>
              )}
            </div>
            {editingToken && tokenDraftError && (
              <p className="text-xs text-red-500">
                {t(tokenDraftError.key, { defaultValue: tokenDraftError.zh })}
              </p>
            )}
            {editingToken && !tokenDraftError && (
              <p className="text-xs text-muted-foreground">
                {t("gateway.token.editHint", {
                  defaultValue:
                    "可见 ASCII、不含空格、8-256 字符。保存即生效，旧令牌立刻失效。",
                })}
              </p>
            )}
          </div>

          {/* 各 namespace：模型目录编辑器 */}
          <div className="space-y-4">
            {info.namespaces.map((ns) => (
              <NamespaceCatalog
                key={ns.namespace}
                ns={ns}
                providers={providersFor(ns.namespace)}
                baseUrl={gatewayBaseUrl(origin, ns.namespace)}
                origin={origin}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
