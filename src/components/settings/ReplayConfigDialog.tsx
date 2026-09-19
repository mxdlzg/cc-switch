import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogFooter,
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
import {
  DEFAULT_REPLAY_CONFIG,
  type ReplayConfigInput,
  type ReplaySnapshotInfo,
} from "@/lib/api/replay";
import { useStartReplay } from "@/lib/query/replay";
import { burstLadderPreview } from "@/lib/utils/replayPace";

/** 与后端 commands/replay.rs 同规则的区间（前端预检，后端为准）。 */
const RANGES = {
  intervalSecs: { min: 1, max: 3600 },
  backoffStartSecs: { min: 1, max: 3600 },
  backoffMultPercent: { min: 100, max: 1000 },
  backoffCapSecs: { min: 1, max: 3600 },
  burstAttemptsPerRound: { min: 1, max: 50 },
  burstRoundGapMinSecs: { min: 1, max: 3600 },
  burstRoundGapMaxSecs: { min: 1, max: 3600 },
  requiredConsecutive: { min: 1, max: 10 },
  maxAttempts: { min: 1, max: 100000 },
  maxDurationMinutes: { min: 1, max: 1440 },
} as const;

export interface ReplayConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 要重放的 `request` 条目 seq */
  seq: number | null;
  info: ReplaySnapshotInfo | null;
}

/**
 * 重放配置弹窗。
 *
 * 数字用字符串状态（能清空输入框），区间校验在这里做一次、后端再做一次。
 * 顶部那条警示是**必须**的：重放用的是抓取那一刻的鉴权头，用户很可能以为
 * 「切了供应商就会打新的」——正相反，冻结快照正是本功能的用途。
 */
export function ReplayConfigDialog({
  open,
  onOpenChange,
  seq,
  info,
}: ReplayConfigDialogProps) {
  const { t } = useTranslation();
  const startReplay = useStartReplay();
  const [form, setForm] = useState<ReplayConfigInput>(DEFAULT_REPLAY_CONFIG);
  const [validationError, setValidationError] = useState<string | null>(null);

  // 每次打开回到默认值：抢席位参数按场景变化，留着上次的值容易误用。
  useEffect(() => {
    if (open) {
      setForm(DEFAULT_REPLAY_CONFIG);
      setValidationError(null);
    }
  }, [open]);

  // 退避三件套（起始秒/倍数/封顶）在 backoff 与 burst 下都要填：burst 用它算**轮内**
  // 间隔。写成变量而不是散在两处的 `mode === "backoff" || mode === "burst"`，免得
  // 将来加模式时漏掉一处、出现「字段显示与校验不一致」。
  const usesBackoff = form.mode === "backoff" || form.mode === "burst";

  const set = (key: keyof ReplayConfigInput, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const validate = (): string | null => {
    // 必须是纯非负整数（和后端 parse_int 同规则；后端仍会再校验一次）。
    const parse = (raw: string) => {
      const trimmed = raw.trim();
      return /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
    };
    const bad: string[] = [];
    for (const [key, range] of Object.entries(RANGES)) {
      const value = parse(form[key as keyof ReplayConfigInput]);
      if (Number.isNaN(value) || value < range.min || value > range.max) {
        bad.push(`${t(`replay.fields.${key}`)}: ${range.min}-${range.max}`);
      }
    }
    if (bad.length > 0) {
      return t("replay.validationFailed", {
        fields: bad.join("; "),
        defaultValue: `以下字段超出有效范围: ${bad.join("; ")}`,
      });
    }
    // 轮间上下限倒置：后端明确拒绝（不静默交换），前端同规则预检，免得点了才开始
    // 然后才发现填反了。区间非法时上面已经拦下，这里 parse 必然成功。
    const gapMin = parse(form.burstRoundGapMinSecs);
    const gapMax = parse(form.burstRoundGapMaxSecs);
    if (gapMin > gapMax) {
      return t("replay.gapOrderError", {
        min: gapMin,
        max: gapMax,
        defaultValue: `轮间最小秒数（${gapMin}）不能大于最大秒数（${gapMax}）`,
      });
    }
    // 可重试状态码：逗号分隔，每项 100~599；空串允许（= 什么都不重试）。
    for (const part of form.retryableStatuses.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const code = Number(trimmed);
      if (!/^\d+$/.test(trimmed) || code < 100 || code > 599) {
        return t("replay.invalidStatusCode", {
          value: trimmed,
          defaultValue: `可重试状态码无效: ${trimmed}（需 100~599）`,
        });
      }
    }
    return null;
  };

  const handleStart = async () => {
    const error = validate();
    if (error || seq === null) {
      // 之前这里只是 `return`：点了「开始重放」什么也没发生、也没有话，用户只能猜
      // 哪个字段填错了（轮间上下限填反尤其容易踩）。把校验文案就地显示出来。
      setValidationError(error);
      return;
    }
    setValidationError(null);
    try {
      await startReplay.mutateAsync({ seq, config: form });
      onOpenChange(false);
    } catch {
      /* mutation 的 onError 已经 toast，这里只需不关弹窗 */
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[min(720px,95vw)]">
        <DialogHeader>
          <DialogTitle>{t("replay.dialogTitle")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <Alert className="border-amber-500/40 bg-amber-500/10">
            <AlertDescription className="text-xs">
              {t("replay.freezeWarning")}
            </AlertDescription>
          </Alert>

          {info && (
            <div className="rounded-lg border border-white/10 bg-muted/30 p-3 text-xs">
              <div className="font-mono break-all">
                {info.method} {info.targetOrigin}
              </div>
              <div className="mt-1 text-muted-foreground">
                {t("replay.snapshotMeta", {
                  body: (info.bodyLen / 1024).toFixed(1),
                  headers: info.headerCount,
                  model: info.model || "—",
                  defaultValue:
                    "body {{body}} KB · {{headers}} 个头 · model={{model}}",
                })}
              </div>
            </div>
          )}

          {/* 节奏 */}
          <div className="space-y-3 rounded-lg border border-white/10 bg-muted/30 p-4">
            <div className="space-y-2">
              <Label>{t("replay.fields.mode")}</Label>
              <Select
                value={form.mode}
                onValueChange={(v) =>
                  set("mode", v as ReplayConfigInput["mode"])
                }
              >
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixed">
                    {t("replay.mode.fixed")}
                  </SelectItem>
                  <SelectItem value="backoff">
                    {t("replay.mode.backoff")}
                  </SelectItem>
                  <SelectItem value="burst">
                    {t("replay.mode.burst")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {form.mode === "fixed" && (
                <NumberField
                  labelKey="intervalSecs"
                  value={form.intervalSecs}
                  range={RANGES.intervalSecs}
                  onChange={(v) => set("intervalSecs", v)}
                />
              )}
              {/* 「每轮次数」排在退避三件套之前：burst 模式下它是第一个要决定的量，
                  退避参数只是描述一轮*内部*怎么间隔。 */}
              {form.mode === "burst" && (
                <NumberField
                  labelKey="burstAttemptsPerRound"
                  value={form.burstAttemptsPerRound}
                  range={RANGES.burstAttemptsPerRound}
                  onChange={(v) => set("burstAttemptsPerRound", v)}
                />
              )}
              {usesBackoff && (
                <NumberField
                  labelKey="backoffStartSecs"
                  hintKey={
                    form.mode === "burst" ? "backoffStartSecsBurst" : undefined
                  }
                  value={form.backoffStartSecs}
                  range={RANGES.backoffStartSecs}
                  onChange={(v) => set("backoffStartSecs", v)}
                />
              )}
              {usesBackoff && (
                <NumberField
                  labelKey="backoffMultPercent"
                  value={form.backoffMultPercent}
                  range={RANGES.backoffMultPercent}
                  onChange={(v) => set("backoffMultPercent", v)}
                />
              )}
              {usesBackoff && (
                <NumberField
                  labelKey="backoffCapSecs"
                  value={form.backoffCapSecs}
                  range={RANGES.backoffCapSecs}
                  onChange={(v) => set("backoffCapSecs", v)}
                />
              )}
              {form.mode === "burst" && (
                <>
                  <NumberField
                    labelKey="burstRoundGapMinSecs"
                    value={form.burstRoundGapMinSecs}
                    range={RANGES.burstRoundGapMinSecs}
                    onChange={(v) => set("burstRoundGapMinSecs", v)}
                  />
                  <NumberField
                    labelKey="burstRoundGapMaxSecs"
                    value={form.burstRoundGapMaxSecs}
                    range={RANGES.burstRoundGapMaxSecs}
                    onChange={(v) => set("burstRoundGapMaxSecs", v)}
                  />
                </>
              )}
              <NumberField
                labelKey="requiredConsecutive"
                value={form.requiredConsecutive}
                range={RANGES.requiredConsecutive}
                onChange={(v) => set("requiredConsecutive", v)}
              />
            </div>

            {/* burst 是两级节奏（轮内指数 + 轮间随机），光看六个输入框想不出节奏长
                什么样。所以拿用户自己填的值把**第一轮**的等待序列算出来。
                `burstLadderPreview` 只是显示用、不参与计算（真值以引擎为准），算错
                最坏是预览不准——但用户照着它判断"要不要用这个模式"，所以有单测钉住。 */}
            {form.mode === "burst" && (
              <div className="space-y-1">
                <p className="break-words font-mono text-xs text-muted-foreground">
                  {burstLadderPreview(form)}{" "}
                  {t("replay.hints.burstGap", {
                    min: form.burstRoundGapMinSecs,
                    max: form.burstRoundGapMaxSecs,
                  })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("replay.hints.burst")}
                </p>
              </div>
            )}
          </div>

          {/* 错误应对 */}
          <div className="space-y-3 rounded-lg border border-white/10 bg-muted/30 p-4">
            <div className="space-y-2">
              <Label htmlFor="replay-retryable">
                {t("replay.fields.retryableStatuses")}
              </Label>
              <Input
                id="replay-retryable"
                value={form.retryableStatuses}
                onChange={(e) => set("retryableStatuses", e.target.value)}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                {t("replay.hints.retryableStatuses")}
              </p>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <NumberField
                labelKey="maxAttempts"
                value={form.maxAttempts}
                range={RANGES.maxAttempts}
                onChange={(v) => set("maxAttempts", v)}
              />
              <NumberField
                labelKey="maxDurationMinutes"
                value={form.maxDurationMinutes}
                range={RANGES.maxDurationMinutes}
                onChange={(v) => set("maxDurationMinutes", v)}
              />
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            {t("replay.noBilling")}
          </p>

          {validationError && (
            <Alert className="border-red-500/40 bg-red-500/10">
              <AlertDescription className="text-xs">
                {validationError}
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={startReplay.isPending}
          >
            {t("common.cancel")}
          </Button>
          <Button
            onClick={handleStart}
            disabled={startReplay.isPending || !info}
          >
            {startReplay.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            {t("replay.start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface NumberFieldProps {
  labelKey: string;
  /**
   * 覆盖提示文案的 key（默认 `replay.hints.<labelKey>`）。
   *
   * 需要它是因为「退避起始秒」在两个模式下语义不同：`backoff` 里它是整条链的起点
   * （一路涨到封顶），`burst` 里它是**每轮**的起点（每轮重置）。同一句话讲不清两件
   * 事，所以各写一条。
   */
  hintKey?: string;
  value: string;
  range: { min: number; max: number };
  onChange: (value: string) => void;
}

function NumberField({
  labelKey,
  hintKey,
  value,
  range,
  onChange,
}: NumberFieldProps) {
  const { t } = useTranslation();
  const id = `replay-${labelKey}`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t(`replay.fields.${labelKey}`)}</Label>
      <Input
        id={id}
        type="number"
        min={range.min}
        max={range.max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <p className="text-xs text-muted-foreground">
        {t(`replay.hints.${hintKey ?? labelKey}`)}
      </p>
    </div>
  );
}
