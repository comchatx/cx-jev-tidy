import { describe, expect, it } from "vitest";
import { batchCalls, decideCall, questionsFor } from "../src/core/decide.js";
import { collectToolCalls, fitState, type TidyMessage } from "../src/core/state.js";

const call = (i: number): TidyMessage => ({ entryId: `a${i}`, role: "assistant", text: `Step ${i}: ${"reasoning ".repeat(80)}`, toolCalls: [{ id: `c${i}`, name: "read", arguments: { path: `file-${i}.csv`, note: "x".repeat(900) } }] });
const outcome = (i: number): TidyMessage => ({ entryId: `r${i}`, role: "toolResult", text: "", toolCalls: [], result: { toolCallId: `c${i}`, chars: 20_000, isError: false } });
const conversation = (rounds: number): TidyMessage[] => [
  { entryId: "u0", role: "user", text: "Audit the listings.", toolCalls: [] },
  ...Array.from({ length: rounds }, (_, i) => [call(i + 1), outcome(i + 1)]).flat(),
];

describe("the decision core", () => {
  it("pins the first message and every call reaching the recent window it is given, and pairs each call with its result", () => {
    const messages = conversation(10);
    // The window starting at round 7's result: round 7's call is before it, its result in it, so the pair stays.
    const calls = collectToolCalls(messages, 14);
    expect(calls).toHaveLength(10);
    expect(calls.filter((c) => c.pinned).map((c) => c.toolCallId)).toEqual(["c7", "c8", "c9", "c10"]);
    expect(calls[0]).toMatchObject({ id: "t1", toolCallId: "c1", tool: "read", callIndex: 1, resultIndex: 2, resultChars: 20_000 });
    // A call the caller holds whole is pinned wherever it stands.
    expect(collectToolCalls(messages, 21, (one) => one.toolCallId === "c2").filter((c) => c.pinned).map((c) => c.toolCallId)).toEqual(["c2"]);
  });

  it("keeps a call whose result must stay, cuts a result whose call must stay, and else drops both; a pinned call is always kept", () => {
    const [unpinned] = collectToolCalls(conversation(10), 15);
    expect(decideCall(unpinned!, 0.1, 0.9, 0.5)).toBe("keep");
    expect(decideCall(unpinned!, 0.9, 0.1, 0.5)).toBe("drop_result");
    expect(decideCall(unpinned!, 0.1, 0.1, 0.5)).toBe("drop_call");
    expect(decideCall({ ...unpinned!, pinned: true }, 0, 0, 0.5)).toBe("keep");
  });

  it("shrinks a long history in stages to fit Jev's state budget, and refuses one it cannot fit", () => {
    const messages = conversation(200);
    const calls = collectToolCalls(messages, 395);
    const fitted = fitState(messages, calls, { maxStateTokens: 25_000, recentFrom: 395 });
    expect(fitted.tokens).toBeLessThanOrEqual(25_000);
    expect(fitted.stage).not.toBe("full");
    expect(() => fitState(messages, calls, { maxStateTokens: 500, recentFrom: 395 })).toThrow(expect.objectContaining({ kind: "oversize" }));
  });

  it("batches questions to fit one request beside the state, and refuses when the state leaves no room", () => {
    const calls = collectToolCalls(conversation(40), 75).filter((c) => !c.pinned);
    const batches = batchCalls(calls, 29_000, 30_000);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(calls);
    expect(Object.keys(questionsFor(calls[0]!))).toEqual(["call_t1", "result_t1"]);
    expect(() => batchCalls(calls, 30_000, 30_000)).toThrow(expect.objectContaining({ kind: "oversize" }));
  });
});
