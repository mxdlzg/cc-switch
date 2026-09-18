import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { AlarmClock, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleRow } from "@/components/ui/toggle-row";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { providersApi } from "@/lib/api/providers";
import type { AppId } from "@/lib/api/types";
import { getAppLabel, PROXY_APP_IDS } from "@/config/appConfig";
import type {
  IdleWatchConfig,
  IdleWatchConfigInput,
  IdleWatchMode,
  IdleWatchRuleInput,
} from "@/lib/api/idleWatch";
import { formatIdleDuration } from "@/lib/utils/idleDuration";
import {
  useChannelIdleStatus,
  useIdleWatchConfig,
  useIdleWatchEventBridge,
  useSaveIdleWatchConfig,
} from "@/lib/query/idleWatch";

/** 阈值区间，与后端 commands/idle_watch.rs 同规则（前端预检，后端为准）。 */
const THRESHOLD = { min: 1, max: 1440 };

const APP_OPTIONS = PROXY_APP_IDS.map((id) => ({ id, label: getAppLabel(id) }));

const ruleKey = (appType: string, providerId: string) =>
  `${appType}/${providerId}`;

/** 后端配置 → 前端输入形状（阈值转字符串，直接绑定输入框）。 */
function toInput(config: IdleWatchConfig): IdleWatchConfigInput {
  return {
    enabled: config.enabled,
    keepaliveEnabled: config.keepaliveEnabled,
    rules: config.rules.map((r) => ({
      appType: r.appType,
      providerId: r.providerId,
      mode: r.mode,
      thresholdMinutes: String(r.thresholdMinutes),
    })),
  };
}

/** 与后端同规则的阈值预检（后端还会再校验一次）。 */
function validateThreshold(raw: string, message: string): string | null {
  const trimmed = raw.trim();
  const value = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (Number.isNaN(value) || value < THRESHOLD.min || value > THRESHOLD.max) {
    return message;
  }
  return null;
}

/**
 * 渠道静默监控面板（设置 → 代理高级选项）。
 *
 * 两块：开关 + 规则编辑，以及「各渠道最近成功 / 已静默」状态表。
 *
 * 两个刻意的设计：
 * - 规则**整块保存**（后端 `save_idle_watch_config` 就是这个粒度）。编辑先落本地
 *   草稿再一次性提交，所以加载时灌一次草稿、保存成功后用后端返回值再灌一次——
 *   后端返回值里有它给新规则打的时间戳，写回请求体会把计时基线弄错。
 * - 阈值输入框**失焦/回车才提交**。逐键保存等于每个按键一次整块读写，一边打字
 *   一边把配置改成一串半截数字。
 *
 * 表里的「已静默」由后端算（与后台提醒同一条基线）。面板不自己减时间戳，否则会
 * 出现「面板显示 3 天、引擎说还没到点」这种看着像 bug 的分歧。
 */
export function IdleWatchPanel() {
  const { t } = useTranslation();
  const rangeError = t("idleWatch.thresholdRange", {
    min: THRESHOLD.min,
    max: THRESHOLD.max,
  });

  useIdleWatchEventBridge();
  const configQuery = useIdleWatchConfig();
  const statusQuery = useChannelIdleStatus();
  const saveConfig = useSaveIdleWatchConfig();

  const config = configQuery.data;
  const rows = statusQuery.data ?? [];

  const [draft, setDraft] = useState<IdleWatchConfigInput | null>(null);
  useEffect(() => {
    if (config) setDraft(toInput(config));
  }, [config]);

  const view = useMemo<IdleWatchConfigInput>(
    () =>
      draft ?? {
        enabled: config?.enabled ?? false,
        keepaliveEnabled: config?.keepaliveEnabled ?? false,
        rules: [],
      },
    [draft, config],
  );

  // 新增行的本地状态
  const [appType, setAppType] = useState<string>(APP_OPTIONS[0].id);
  const [providerId, setProviderId] = useState("");
  const [mode, setMode] = useState<IdleWatchMode>("always");
  const [threshold, setThreshold] = useState("120");

  const providersQuery = useQuery({
    queryKey: ["idleWatchProviders", appType],
    queryFn: () => providersApi.getAll(appType as AppId),
  });
  const providerOptions = useMemo(
    () =>
      Object.values(providersQuery.data ?? {}).map((p) => ({
        id: p.id,
        name: p.name,
      })),
    [providersQuery.data],
  );

  const save = async (next: IdleWatchConfigInput) => {
    setDraft(next);
    try {
      await saveConfig.mutateAsync(next);
    } catch {
      /* mutation 的 onError 已 toast；保留草稿让用户改完再试 */
    }
  };

  const patchRule = (index: number, patch: Partial<IdleWatchRuleInput>) => {
    void save({
      ...view,
      rules: view.rules.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    });
  };

  const removeRule = (index: number) => {
    void save({ ...view, rules: view.rules.filter((_, i) => i !== index) });
  };

  const addRule = () => {
    if (!providerId) {
      toast.error(t("idleWatch.pickProvider"));
      return;
    }
    if (
      view.rules.some((r) => r.appType === appType && r.providerId === providerId)
    ) {
      toast.error(t("idleWatch.duplicate"));
      return;
    }
    const error = validateThreshold(threshold, rangeError);
    if (error) {
      toast.error(error);
      return;
    }
    void save({
      ...view,
      rules: [
        ...view.rules,
        { appType, providerId, mode, thresholdMinutes: threshold.trim() },
      ],
    });
    setProviderId("");
  };

  /** 规则行的渠道名：优先用状态表里后端解析好的名字，退化成 providerId。 */
  const ruleLabel = (rule: IdleWatchRuleInput) =>
    rows.find(
      (r) => ruleKey(r.appType, r.providerId) === ruleKey(rule.appType, rule.providerId),
    )?.providerName ||
    rule.providerId ||
    "—";

  return (
    <div className="space-y-5">
      <Alert className="border-blue-500/40 bg-blue-500/10">
        <AlertDescription className="text-xs">
          {t("idleWatch.proxiedOnlyHint")}
        </AlertDescription>
      </Alert>

      <div className="space-y-3">
        <ToggleRow
          icon={<AlarmClock className="h-4 w-4 text-orange-500" />}
          title={t("idleWatch.enabled")}
          description={t("idleWatch.enabledHint")}
          checked={view.enabled}
          onCheckedChange={(checked) => void save({ ...view, enabled: checked })}
        />
        <ToggleRow
          icon={<AlarmClock className="h-4 w-4 text-teal-500" />}
          title={t("idleWatch.keepalive")}
          description={t("idleWatch.keepaliveHint")}
          checked={view.keepaliveEnabled}
          onCheckedChange={(checked) =>
            void save({ ...view, keepaliveEnabled: checked })
          }
        />
      </div>

      {/* 规则 */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium">{t("idleWatch.rules")}</h4>

        {view.rules.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("idleWatch.noRules")}
          </p>
        ) : (
          <ul className="space-y-2">
            {view.rules.map((rule, index) => (
              <li
                key={ruleKey(rule.appType, rule.providerId)}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/50 p-3"
              >
                <span className="min-w-0 flex-1 truncate text-sm">
                  <span className="font-medium">{ruleLabel(rule)}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {getAppLabel(rule.appType)}
                  </span>
                </span>

                <Select
                  value={rule.mode}
                  onValueChange={(v) =>
                    patchRule(index, { mode: v as IdleWatchMode })
                  }
                >
                  <SelectTrigger className="h-8 w-[120px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="always">
                      {t("idleWatch.mode.always")}
                    </SelectItem>
                    <SelectItem value="once">
                      {t("idleWatch.mode.once")}
                    </SelectItem>
                  </SelectContent>
                </Select>

                <ThresholdInput
                  value={rule.thresholdMinutes}
                  rangeError={rangeError}
                  onCommit={(next) =>
                    patchRule(index, { thresholdMinutes: next })
                  }
                />

                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("idleWatch.delete")}
                  onClick={() => removeRule(index)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        {/* 新增一行 */}
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border p-3">
          <Select
            value={appType}
            onValueChange={(v) => {
              setAppType(v);
              setProviderId("");
            }}
          >
            <SelectTrigger className="h-8 w-[120px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {APP_OPTIONS.map((opt) => (
                <SelectItem key={opt.id} value={opt.id}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={providerId} onValueChange={setProviderId}>
            <SelectTrigger className="h-8 min-w-[150px] flex-1 text-xs">
              <SelectValue
                placeholder={
                  providersQuery.isPending
                    ? t("idleWatch.loadingProviders")
                    : t("idleWatch.pickProvider")
                }
              />
            </SelectTrigger>
            <SelectContent>
              {providerOptions.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={mode} onValueChange={(v) => setMode(v as IdleWatchMode)}>
            <SelectTrigger className="h-8 w-[120px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="always">{t("idleWatch.mode.always")}</SelectItem>
              <SelectItem value="once">{t("idleWatch.mode.once")}</SelectItem>
            </SelectContent>
          </Select>

          <Input
            type="number"
            min={THRESHOLD.min}
            max={THRESHOLD.max}
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            className="h-8 w-[90px] text-sm"
            aria-label={t("idleWatch.threshold")}
          />

          <Button size="sm" variant="outline" onClick={addRule}>
            <Plus className="mr-1 h-4 w-4" />
            {t("idleWatch.add")}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">{t("idleWatch.modeHint")}</p>
      </div>

      {/* 状态表 */}
      <div className="space-y-2">
        <h4 className="text-sm font-medium">{t("idleWatch.statusTitle")}</h4>
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("idleWatch.noRows")}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("idleWatch.col.channel")}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t("idleWatch.col.success")}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t("idleWatch.col.last")}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t("idleWatch.col.idle")}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t("idleWatch.col.rule")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={ruleKey(row.appType, row.providerId)}
                    className="border-t border-border/60"
                  >
                    <td className="px-3 py-2">
                      <span className="block max-w-[220px] truncate">
                        {row.providerName || row.providerId}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {getAppLabel(row.appType)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {row.successCount}/{row.requestCount}
                    </td>
                    <td className="px-3 py-2 text-right text-xs">
                      {row.lastSuccessAt === null
                        ? t("idleWatch.never")
                        : formatIdleDuration(
                            Math.max(0, Date.now() / 1000 - row.lastSuccessAt),
                            t,
                          )}
                    </td>
                    <td className="px-3 py-2 text-right text-xs">
                      {row.requestCount > 0 && row.successCount === 0 ? (
                        <span className="text-amber-600 dark:text-amber-400">
                          {t("idleWatch.allFailed")}
                        </span>
                      ) : (
                        formatIdleDuration(row.idleSec, t)
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {row.mode ? (
                        <Badge className="bg-orange-500/15 text-orange-600 dark:text-orange-400">
                          {t(`idleWatch.mode.${row.mode}`)}{" "}
                          {formatIdleDuration((row.thresholdMinutes ?? 0) * 60, t)}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {t("idleWatch.appMustRunHint")}
        </p>
      </div>
    </div>
  );
}

interface ThresholdInputProps {
  value: string;
  rangeError: string;
  /** 失焦或回车时提交；值没变则不调用 */
  onCommit: (value: string) => void;
}

/**
 * 阈值输入：本地状态 + 失焦提交。
 *
 * 校验不通过就退回原值并 toast——输入框里留着一个后端不肯收的值，比直接报错更
 * 容易让人以为已经保存了。
 */
function ThresholdInput({ value, rangeError, onCommit }: ThresholdInputProps) {
  const { t } = useTranslation();
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);

  const commit = () => {
    if (validateThreshold(local, rangeError)) {
      toast.error(rangeError);
      setLocal(value);
      return;
    }
    if (local.trim() !== value) onCommit(local.trim());
  };

  return (
    <Input
      type="number"
      min={THRESHOLD.min}
      max={THRESHOLD.max}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className="h-8 w-[90px] text-sm"
      aria-label={t("idleWatch.threshold")}
    />
  );
}
