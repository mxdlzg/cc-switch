import type { ReplayConfigInput } from "@/lib/api/replay";

/**
 * burst 节奏的**显示用**推算。
 *
 * 与 Rust 侧 `ReplayConfig::backoff_secs` 同一条曲线：`起 × 倍^(n-1)`，逐次累乘并在
 * 封顶处提前停下。刻意不复用后端结果——前端只是把用户自己填的六个数字画成一行时间
 * 轴，好让他下单前就知道「这是不是我想要的节奏」。
 *
 * 两处必须与引擎一致，否则预览会撒谎（有单测钉住这两条）：
 * - **每轮重置**：轮内指数按轮内位置算，所以每轮都从起始秒重新开始。`backoff` 那条
 *   链封顶后就永远按封顶等——这是两个模式的实质区别，也是用户选 burst 的理由。
 * - 一轮 N 次只产生 **N-1 个轮内间隔**：第 N 次之后走轮间随机，不属于这个序列。
 */

/** 一轮上限 50 次（后端 `BURST_PER_ROUND_MAX`），全列出来没人看得下，截断显示。 */
const MAX_PREVIEW_STEPS = 8;

/** 与后端 `backoff_secs` 同式；`n` 从 1 起。 */
function backoffSecs(
  n: number,
  startSecs: number,
  multPercent: number,
  capSecs: number,
): number {
  const mult = Math.max(100, multPercent) / 100;
  const cap = Math.max(1, capSecs);
  let secs = Math.max(1, startSecs);
  for (let i = 1; i < n; i += 1) {
    secs *= mult;
    if (secs >= cap) return cap;
  }
  return Math.min(secs, cap);
}

/**
 * 一轮内的等待序列（秒），长度 = `perRound - 1`。
 *
 * 输入直接取自表单，所以任何一项非法（空、非数字）都退回空数组：用户打字打到一半
 * 时预览不该报错或显示 NaN。
 */
export function burstLadderSeconds(form: ReplayConfigInput): number[] {
  const num = (raw: string) => {
    const trimmed = raw.trim();
    return /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  };
  const perRound = num(form.burstAttemptsPerRound);
  const start = num(form.backoffStartSecs);
  const mult = num(form.backoffMultPercent);
  const cap = num(form.backoffCapSecs);
  if ([perRound, start, mult, cap].some((v) => Number.isNaN(v))) return [];
  const steps = Math.max(0, perRound - 1);
  const out: number[] = [];
  for (let n = 1; n <= steps; n += 1) {
    out.push(Math.round(backoffSecs(n, start, mult, cap)));
  }
  return out;
}

/**
 * 一行时间轴：`#1 ─2s→ #2 ─4s→ #3 ─8s→ #4 ─16s→ #5`（超过 8 段就截断成 `#9+`）。
 *
 * 一轮 1 次时没有轮内间隔，返回 `"#1"`——调用处后面接的「轮间随机 min~max」正好把
 * 这句话补完（每次之间都是随机）。
 */
export function burstLadderPreview(form: ReplayConfigInput): string {
  const ladder = burstLadderSeconds(form);
  if (ladder.length === 0) return "#1";
  const shown = ladder.slice(0, MAX_PREVIEW_STEPS);
  const parts = shown.map((secs, i) => `#${i + 1} ─${secs}s→`);
  // 截断时末位写 `#9+`（= 第 9 次之后还有）而不是 `#…`：`#…` 放在一串编号末尾读起来
  // 像「某个未知的第 N 次」，而用户真正需要知道的是「这里被省略了」。
  parts.push(
    ladder.length > shown.length
      ? `#${shown.length + 1}+`
      : `#${ladder.length + 1}`,
  );
  return parts.join(" ");
}
