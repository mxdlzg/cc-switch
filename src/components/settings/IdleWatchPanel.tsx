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
  ChannelIdleStatus,
  IdleWatchConfig,
  IdleWatchConfigInput,
  IdleWatchMode,
  IdleWatchRuleInput,
} from "@/lib/api/idleWatch";
import {
  THRESHOLD,
  THRESHOLD_UNITS,
  UNIT_FACTORS,
  formatIdleDuration,
  formatThresholdMinutes,
  minutesForValue,
  unitForMinutes,
  valueForMinutes,
} from "@/lib/utils/idleDuration";
import type { ThresholdUnit } from "@/lib/utils/idleDuration";
import {
  useChannelIdleStatus,
  useIdleWatchConfig,
  useIdleWatchEventBridge,
  useSaveIdleWatchConfig,
} from "@/lib/query/idleWatch";

const APP_OPTIONS = PROXY_APP_IDS.map((id) => ({ id, label: getAppLabel(id) }));

const ruleKey = (appType: string, providerId: string) =>
  `${appType}/${providerId}`;

/**
 * 后端配置 → 前端输入形状。
 *
 * 阈值**保持分钟**、只转成字符串：单位（分钟/小时/天）是 `ThresholdInput` 内部的
 * 显示状态，不进草稿。草稿里存分钟意味着并发编辑、保存回包、重新渲染走的都是同一
 * 个权威值，不会因为「当前显示成什么单位」而漂移。
 */
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
  // 区间文案带上天数：只说「43200 分钟」，用户仍得自己心算是多久——这正是本次改造
  // 要解决的问题，错误提示不能犯同一个毛病。
  const rangeError = t("idleWatch.thresholdRange", {
    min: THRESHOLD.min,
    max: THRESHOLD.max,
    maxDays: THRESHOLD.max / UNIT_FACTORS.day,
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

  // 新增行的本地状态。`threshold` 是**当前单位下的数值**（不是分钟）：单位下拉
  // 换掉时输入框里的数字跟着按分钟重算，用户看到的始终是自己刚填的那套单位。
  const [appType, setAppType] = useState<string>(APP_OPTIONS[0].id);
  const [providerId, setProviderId] = useState("");
  const [mode, setMode] = useState<IdleWatchMode>("always");
  const [threshold, setThreshold] = useState("2");
  const [thresholdUnit, setThresholdUnit] = useState<ThresholdUnit>("hour");

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

  /**
   * 新增行的实时预览：把「数值 + 单位」翻成一句人话（「即：连续 2 小时没有成功请求
   * 就提醒」）。非法值返回 null，调用处退化成区间错误文案。
   */
  const addRowPreview = useMemo(() => {
    const minutes = minutesForValue(threshold, thresholdUnit);
    if (minutes === null) return null;
    return t("idleWatch.thresholdPreview", {
      duration: formatThresholdMinutes(minutes, t),
    });
  }, [threshold, thresholdUnit, t]);

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
      view.rules.some(
        (r) => r.appType === appType && r.providerId === providerId,
      )
    ) {
      toast.error(t("idleWatch.duplicate"));
      return;
    }
    // 换回分钟再提交：配置里的存储单位是分钟，单位只是这层的看法。
    const minutes = minutesForValue(threshold, thresholdUnit);
    if (minutes === null) {
      toast.error(rangeError);
      return;
    }
    void save({
      ...view,
      rules: [
        ...view.rules,
        { appType, providerId, mode, thresholdMinutes: String(minutes) },
      ],
    });
    setProviderId("");
  };

  /** 规则行的渠道名：优先用状态表里后端解析好的名字，退化成 providerId。 */
  const ruleLabel = (rule: IdleWatchRuleInput) =>
    rows.find(
      (r) =>
        ruleKey(r.appType, r.providerId) ===
        ruleKey(rule.appType, rule.providerId),
    )?.providerName ||
    rule.providerId ||
    "—";

  /**
   * 渠道 → 该渠道上的规则。用**草稿**（`view.rules`）而不是状态表自带的字段：
   * 用户改完阈值到后端回包之间有一小段窗口，徽章若读后端旧值会当场跟同一行的编辑框
   * 对不上。草稿缺失（规则刚被删、状态表还是旧数据）才退回行上的值。
   */
  const ruleByChannel = useMemo(() => {
    const map = new Map<string, IdleWatchRuleInput>();
    for (const r of view.rules) map.set(ruleKey(r.appType, r.providerId), r);
    return map;
  }, [view.rules]);

  /** 状态表徽章上要显示的阈值分钟数（见 `ruleByChannel` 的取值优先级说明）。 */
  const badgeThreshold = (row: ChannelIdleStatus): number => {
    const draftRule = ruleByChannel.get(ruleKey(row.appType, row.providerId));
    if (draftRule) return Number(draftRule.thresholdMinutes) || 0;
    return row.thresholdMinutes ?? 0;
  };

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
          onCheckedChange={(checked) =>
            void save({ ...view, enabled: checked })
          }
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
                  minutes={rule.thresholdMinutes}
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

          <Select
            value={mode}
            onValueChange={(v) => setMode(v as IdleWatchMode)}
          >
            <SelectTrigger className="h-8 w-[120px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="always">
                {t("idleWatch.mode.always")}
              </SelectItem>
              <SelectItem value="once">{t("idleWatch.mode.once")}</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex items-center gap-1">
            {/* 这一列必须自带语义：光一个数字（曾经的「120」）没人推断得出它是
                「静默多久后提醒」，更猜不到单位。 */}
            <span className="text-xs text-muted-foreground">
              {t("idleWatch.thresholdLabel")}
            </span>
            <Input
              type="text"
              inputMode="decimal"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              className="h-8 w-[70px] text-sm"
              aria-label={t("idleWatch.threshold")}
            />
            <ThresholdUnitSelect
              unit={thresholdUnit}
              onChange={(next) => {
                // 换单位时保住**分钟数**、只重算显示数值：从「2 小时」切到分钟应当
                // 变成「120」，而不是把 2 当成 2 分钟（那是把阈值悄悄改了 60 倍）。
                const minutes = minutesForValue(threshold, thresholdUnit);
                setThresholdUnit(next);
                if (minutes !== null) {
                  setThreshold(String(valueForMinutes(minutes, next)));
                }
              }}
            />
          </div>

          <Button size="sm" variant="outline" onClick={addRule}>
            <Plus className="mr-1 h-4 w-4" />
            {t("idleWatch.add")}
          </Button>
        </div>

        {/* 实时预览：把「2 + 小时」翻成人话。值非法时这行直接变成区间错误——
            与其等用户点「添加」再 toast，不如边打字边说清现在填的是多久。 */}
        <p className="text-xs text-muted-foreground">
          {addRowPreview ?? rangeError}
        </p>
        {/* 整数分钟的限制在分钟单位下同样成立（填 0.5 分钟也不行），所以无条件显示。 */}
        <p className="text-xs text-muted-foreground">
          {t("idleWatch.thresholdIntHint")}
        </p>

        <p className="text-xs text-muted-foreground">
          {t("idleWatch.modeHint")}
        </p>
      </div>

      {/* 状态表 */}
      <div className="space-y-2">
        <h4 className="text-sm font-medium">{t("idleWatch.statusTitle")}</h4>
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("idleWatch.noRows")}
          </p>
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
                          {formatThresholdMinutes(badgeThreshold(row), t)}
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
  /** 存储单位（分钟），来自配置 */
  minutes: string;
  rangeError: string;
  /** 失焦或回车时提交，参数同样是分钟；值没变则不调用 */
  onCommit: (minutes: string) => void;
}

/**
 * 阈值输入：数值 + 单位下拉，本地状态 + 失焦提交。
 *
 * 三个刻意点：
 * - 对外契约始终是**分钟字符串**（配置的存储单位），单位只活在这个组件里。提交前
 *   换算回分钟，所以后端的整数分钟校验、DAO、判定逻辑一律不用改。
 * - 校验不通过就退回原值并 toast——输入框里留着一个后端不肯收的值，比直接报错更
 *   容易让人以为已经保存了。
 * - 外部值回来时**优先保住用户刚选的单位**（能整除就保住），否则退回
 *   `unitForMinutes`。不这么做的话：选「分钟」输入 120 → 提交 → 回包重新同步 →
 *   下拉自己跳到「小时」显示 2，用户会觉得没保存上。
 */
function ThresholdInput({
  minutes,
  rangeError,
  onCommit,
}: ThresholdInputProps) {
  const { t } = useTranslation();
  const [local, setLocal] = useState(minutes);
  const [unit, setUnit] = useState<ThresholdUnit>(() =>
    unitForMinutes(Number(minutes) || 0),
  );

  useEffect(() => {
    const nextMinutes = Number(minutes) || 0;
    setUnit((prev) =>
      nextMinutes % UNIT_FACTORS[prev] === 0
        ? prev
        : unitForMinutes(nextMinutes),
    );
    setLocal(String(valueForMinutes(nextMinutes, unit)));
    // unit 不入依赖：它由外部值推导，加进去会在用户改单位时被这个 effect 打回去
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minutes]);

  const commit = () => {
    const nextMinutes = minutesForValue(local, unit);
    if (nextMinutes === null) {
      toast.error(rangeError);
      setLocal(String(valueForMinutes(Number(minutes) || 0, unit)));
      return;
    }
    if (String(nextMinutes) !== minutes) onCommit(String(nextMinutes));
  };

  return (
    <div className="flex items-center gap-1">
      <Input
        type="text"
        inputMode="decimal"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="h-8 w-[70px] text-sm"
        aria-label={t("idleWatch.threshold")}
      />
      <ThresholdUnitSelect
        unit={unit}
        onChange={(next) => {
          // 换单位保住分钟数、只重算显示数值：「2 小时」切到分钟应变成「120」，
          // 不能把 2 当成 2 分钟（那等于把阈值偷偷改了 60 倍）。
          const kept = minutesForValue(local, unit);
          setUnit(next);
          if (kept !== null) setLocal(String(valueForMinutes(kept, next)));
        }}
      />
    </div>
  );
}

interface ThresholdUnitSelectProps {
  unit: ThresholdUnit;
  onChange: (unit: ThresholdUnit) => void;
}

/** 单位下拉（分钟/小时/天）。新增行与规则行共用，措辞与顺序才不会分岔。 */
function ThresholdUnitSelect({ unit, onChange }: ThresholdUnitSelectProps) {
  const { t } = useTranslation();
  return (
    <Select
      value={unit}
      onValueChange={(next) => onChange(next as ThresholdUnit)}
    >
      <SelectTrigger className="h-8 w-[80px] text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {THRESHOLD_UNITS.map((u) => (
          <SelectItem key={u} value={u}>
            {t(`idleWatch.thresholdUnit.${u}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
