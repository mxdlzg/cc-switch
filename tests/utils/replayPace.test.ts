import { describe, expect, it } from "vitest";
import { DEFAULT_REPLAY_CONFIG, type ReplayConfigInput } from "@/lib/api/replay";
import { burstLadderPreview, burstLadderSeconds } from "@/lib/utils/replayPace";

/**
 * burst 时间轴预览（`src/lib/utils/replayPace.ts`）。
 *
 * 这个函数**不参与计算**——真值在后端 `ReplayConfig::delay_after_with` 里。但它决定
 * 用户下单前看到的节奏，算错就等于预览撒谎，所以把它必须与引擎一致的几条钉住：
 * 轮内指数、封顶生效、以及「一轮 N 次只有 N-1 个轮内间隔」。
 */

const form = (overrides: Partial<ReplayConfigInput>): ReplayConfigInput => ({
  ...DEFAULT_REPLAY_CONFIG,
  ...overrides,
});

describe("burstLadderSeconds", () => {
  it("matches the mock the engine test uses (start=2, ×2, cap=30, 5 per round)", () => {
    // 5 次 → 4 个轮内间隔：2 / 4 / 8 / 16，第 5 次之后是轮间随机（不在此列）
    expect(
      burstLadderSeconds(
        form({
          burstAttemptsPerRound: "5",
          backoffStartSecs: "2",
          backoffMultPercent: "200",
          backoffCapSecs: "30",
        }),
      ),
    ).toEqual([2, 4, 8, 16]);
  });

  it("pins at the cap for the rest of the round", () => {
    // 8 次、起 2、×2、封顶 10：2 4 8 10 10 10 10（7 个间隔）
    expect(
      burstLadderSeconds(
        form({
          burstAttemptsPerRound: "8",
          backoffStartSecs: "2",
          backoffMultPercent: "200",
          backoffCapSecs: "10",
        }),
      ),
    ).toEqual([2, 4, 8, 10, 10, 10, 10]);
  });

  it("multiplier below 100% is clamped (same floor as the engine)", () => {
    expect(
      burstLadderSeconds(
        form({
          burstAttemptsPerRound: "4",
          backoffStartSecs: "5",
          backoffMultPercent: "50",
          backoffCapSecs: "60",
        }),
      ),
    ).toEqual([5, 5, 5]);
  });

  it("one attempt per round has no intra-round gap", () => {
    expect(burstLadderSeconds(form({ burstAttemptsPerRound: "1" }))).toEqual([]);
  });

  it("returns nothing while the inputs are half-typed", () => {
    // 用户正在打字：预览必须安静，而不是显示 NaN 或报错
    expect(burstLadderSeconds(form({ burstAttemptsPerRound: "" }))).toEqual([]);
    expect(burstLadderSeconds(form({ backoffStartSecs: "abc" }))).toEqual([]);
    expect(burstLadderSeconds(form({ backoffMultPercent: "-1" }))).toEqual([]);
  });
});

describe("burstLadderPreview", () => {
  it("renders the readable timeline", () => {
    expect(
      burstLadderPreview(
        form({
          burstAttemptsPerRound: "5",
          backoffStartSecs: "2",
          backoffMultPercent: "200",
          backoffCapSecs: "30",
        }),
      ),
    ).toBe("#1 ─2s→ #2 ─4s→ #3 ─8s→ #4 ─16s→ #5");
  });

  it("truncates a long round instead of wrapping a 50-item line", () => {
    const preview = burstLadderPreview(
      form({
        burstAttemptsPerRound: "50",
        backoffStartSecs: "1",
        backoffMultPercent: "100",
        backoffCapSecs: "1",
      }),
    );
    // 49 个轮内间隔只画前 8 段；末尾用「#9+」讲清后面还有（而不是冒充成 #50）
    expect(preview).toBe(
      "#1 ─1s→ #2 ─1s→ #3 ─1s→ #4 ─1s→ #5 ─1s→ #6 ─1s→ #7 ─1s→ #8 ─1s→ #9+",
    );
    // 恰好等于截断阈值（一轮 9 次 = 8 个间隔）时不算截断，末位是真实编号 #9
    expect(
      burstLadderPreview(
        form({
          burstAttemptsPerRound: "9",
          backoffStartSecs: "1",
          backoffMultPercent: "100",
          backoffCapSecs: "1",
        }),
      ),
    ).toBe(
      "#1 ─1s→ #2 ─1s→ #3 ─1s→ #4 ─1s→ #5 ─1s→ #6 ─1s→ #7 ─1s→ #8 ─1s→ #9",
    );
  });

  it("says #1 alone when every gap is the random round gap", () => {
    expect(burstLadderPreview(form({ burstAttemptsPerRound: "1" }))).toBe("#1");
  });
});
