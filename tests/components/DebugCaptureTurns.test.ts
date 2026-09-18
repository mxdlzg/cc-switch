import { describe, expect, it } from "vitest";
import type { CaptureEvent, CaptureKind } from "@/lib/api/debugCapture";
import { buildTurns } from "@/components/settings/DebugCaptureSection";

/**
 * 查看器分组逻辑：一行 = 一次入站请求（后端 turnId）。
 *
 * 用户明确反馈过「搞不清哪个是一轮问答」，所以轮次边界、故障转移归组、结局判定
 * 这三件事都被钉住了——它们正是原来用「相邻同 session」分组会算错的地方。
 */
let seqCounter = 0;
function ev(
  turnId: number,
  kind: CaptureKind,
  over: Partial<CaptureEvent> = {},
): CaptureEvent {
  return {
    seq: seqCounter++,
    turnId,
    atMs: 1700000000000,
    kind,
    sessionId: "sess-1",
    appType: "claude",
    providerId: "prov-a",
    model: "claude-sonnet-5",
    status: null,
    rawUpstream: false,
    body: "{}",
    truncated: false,
    ...over,
  };
}

describe("buildTurns", () => {
  it("groups events by turnId, not by adjacency", () => {
    // 并发：两个请求的事件在环形缓冲里交错。按「相邻同 session」会挤成一团。
    const turns = buildTurns([
      ev(1, "client_request"),
      ev(2, "client_request"),
      ev(1, "request"),
      ev(2, "request"),
      ev(1, "response", { status: 200 }),
      ev(2, "response", { status: 200 }),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns.map((t) => t.turnId)).toEqual([1, 2]);
    expect(turns[0].events.map((e) => e.kind)).toEqual([
      "client_request",
      "request",
      "response",
    ]);
  });

  it("keeps a failover retry chain inside one turn", () => {
    const turns = buildTurns([
      ev(7, "client_request"),
      ev(7, "request", { providerId: "prov-a" }),
      ev(7, "error", { providerId: "prov-a", status: 429 }),
      ev(7, "client_request", { providerId: "prov-b" }),
      ev(7, "request", { providerId: "prov-b" }),
      ev(7, "response", { providerId: "prov-b", status: 200 }),
    ]);
    const [turn] = turns;
    expect(turns).toHaveLength(1);
    // 重试不另起一行，但本轮确实碰过两个供应商。
    expect(turn.providerIds).toEqual(["prov-a", "prov-b"]);
    expect(turn.failedAttempts).toBe(1);
    // 撞过 429 又被救回 → 这一轮算成功，行首显示 200 而不是 429。
    expect(turn.succeeded).toBe(true);
    expect(turn.errored).toBe(false);
    expect(turn.shownStatus).toBe(200);
  });

  it("marks a turn as failed only when nothing succeeded", () => {
    const turns = buildTurns([
      ev(3, "client_request"),
      ev(3, "request"),
      ev(3, "error", { status: 400 }),
      ev(3, "error", { status: 400 }),
    ]);
    const [turn] = turns;
    expect(turn.succeeded).toBe(false);
    expect(turn.errored).toBe(true);
    expect(turn.failedAttempts).toBe(2);
    expect(turn.shownStatus).toBe(400);
  });

  it("treats an in-flight turn as terminal-less (no status yet)", () => {
    const [turn] = buildTurns([ev(4, "client_request"), ev(4, "request")]);
    expect(turn.hasTerminal).toBe(false);
    expect(turn.shownStatus).toBe(null);
    expect(turn.errored).toBe(false);
  });

  it("replay responses are their own turn and count as success", () => {
    const [turn] = buildTurns([ev(9, "replay_response", { status: 200 })]);
    expect(turn.turnId).toBe(9);
    expect(turn.succeeded).toBe(true);
    expect(turn.shownStatus).toBe(200);
    // 管道末步亮的是「重放」，不是「响应」——那一份响应客户端从未收到。
    expect(turn.terminalKind).toBe("replay_response");
  });

  it("names the terminal step after the outcome, not after the last event", () => {
    const failover = buildTurns([
      ev(1, "error", { status: 429 }),
      ev(1, "response", { status: 200 }),
    ])[0];
    expect(failover.terminalKind).toBe("response");

    const failed = buildTurns([ev(2, "error", { status: 500 })])[0];
    expect(failed.terminalKind).toBe("error");

    const inFlight = buildTurns([ev(3, "request")])[0];
    expect(inFlight.terminalKind).toBe(null);
  });

  it("picks the LAST outbound request as the replayable one", () => {
    // 故障转移留了两份出站；重放该拿真正发出去的那次（最后一次）。
    const first = ev(5, "request", { providerId: "prov-a" });
    const last = ev(5, "request", { providerId: "prov-b" });
    const [turn] = buildTurns([ev(5, "client_request"), first, last]);
    expect(turn.replayableSeq).toBe(last.seq);
  });

  it("orders turns by first appearance (caller reverses for newest-first)", () => {
    const turns = buildTurns([
      ev(11, "client_request"),
      ev(12, "client_request"),
      ev(13, "client_request"),
    ]);
    expect(turns.map((t) => t.turnId)).toEqual([11, 12, 13]);
  });
});
