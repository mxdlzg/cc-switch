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

/** 与后端 commands/replay.rs 同规则的区间（前端预检，后端为准）。 */
const RANGES = {
  intervalSecs: { min: 1, max: 3600 },
  backoffStartSecs: { min: 1, max: 3600 },
  backoffMultPercent: { min: 100, max: 1000 },
  backoffCapSecs: { min: 1, max: 3600 },
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

  // 每次打开回到默认值：抢席位参数按场景变化，留着上次的值容易误用。
  useEffect(() => {
    if (open) setForm(DEFAULT_REPLAY_CONFIG);
  }, [open]);

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
    if (error || seq === null) return;
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
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {form.mode === "fixed" ? (
                <NumberField
                  labelKey="intervalSecs"
                  value={form.intervalSecs}
                  range={RANGES.intervalSecs}
                  onChange={(v) => set("intervalSecs", v)}
                />
              ) : (
                <>
                  <NumberField
                    labelKey="backoffStartSecs"
                    value={form.backoffStartSecs}
                    range={RANGES.backoffStartSecs}
                    onChange={(v) => set("backoffStartSecs", v)}
                  />
                  <NumberField
                    labelKey="backoffMultPercent"
                    value={form.backoffMultPercent}
                    range={RANGES.backoffMultPercent}
                    onChange={(v) => set("backoffMultPercent", v)}
                  />
                  <NumberField
                    labelKey="backoffCapSecs"
                    value={form.backoffCapSecs}
                    range={RANGES.backoffCapSecs}
                    onChange={(v) => set("backoffCapSecs", v)}
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
  value: string;
  range: { min: number; max: number };
  onChange: (value: string) => void;
}

function NumberField({ labelKey, value, range, onChange }: NumberFieldProps) {
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
        {t(`replay.hints.${labelKey}`)}
      </p>
    </div>
  );
}
