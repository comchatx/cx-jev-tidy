// Ported from tamaratran/fast-jev-compaction at e3f262a7 (MIT); the notice is in the package's THIRD_PARTY_NOTICES.md.
import { JevError, noulAnswer, type JevAsker, type JevQuestions } from "./jev.js";
import { collectToolCalls, estimateTokens, fitState, type CompactionState, type TidyMessage, type ToolCall } from "./state.js";

/** The library's defaults, kept: a call or result stays at a keep probability of one half. Which messages are pinned is the caller's. */
export const OPTIONS = Object.freeze({ keepThreshold: 0.5, maxStateTokens: 25_000, maxRequestTokens: 30_000 });

/** What a pass holds back from Jev: the messages from `recentFrom` on (pi's recent window), and any call `whole` says must stay. */
export type Pins = { readonly recentFrom: number; readonly whole?: (call: Omit<ToolCall, "id" | "pinned">) => boolean };

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

export type CallAction = "keep" | "drop_result" | "drop_call";
export type CallDecision = { readonly call: ToolCall; readonly action: CallAction };

/** The two `noul` questions asked about one call: keep the call, keep its result. */
export const questionsFor = (call: ToolCall): JevQuestions => ({
  [`call_${call.id}`]: {
    type: "noul",
    instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
  },
  [`result_${call.id}`]: {
    type: "noul",
    instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
  },
});

/** Splits the candidate calls into batches whose questions, together with the (always complete) state, fit one request. */
export function batchCalls(calls: readonly ToolCall[], stateTokens: number, maxRequestTokens: number): ToolCall[][] {
  const budget = maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) throw new JevError("oversize", `state leaves no room for questions (~${stateTokens} of ${maxRequestTokens} tokens)`);
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** A call whose result must stay is kept; else one whose call must stay loses its result; else both go. */
export function decideCall(call: ToolCall, keepCall: number, keepResult: number, keepThreshold: number): CallAction {
  if (call.pinned || keepResult >= keepThreshold) return "keep";
  return keepCall >= keepThreshold ? "drop_result" : "drop_call";
}

async function askBatch(asker: JevAsker, state: CompactionState, batch: readonly ToolCall[]): Promise<Map<string, readonly [number, number]>> {
  const { answers } = await asker.ask(state, Object.assign({}, ...batch.map(questionsFor)) as JevQuestions);
  return new Map(batch.map((call) => [call.id, [noulAnswer(answers, `call_${call.id}`), noulAnswer(answers, `result_${call.id}`)] as const]));
}

/**
 * Asks Jev, for every tool call outside the first message, the recent window and the calls held whole, whether the call and whether its
 * result must stay. The whole
 * history (results omitted, fitted into the state budget) is sent with every batch of questions. Throws when Jev fails or the history cannot
 * be fitted; the caller falls back.
 */
export async function decide(messages: readonly TidyMessage[], asker: JevAsker, pins: Pins): Promise<{ readonly decisions: readonly CallDecision[]; readonly requests: number }> {
  const calls = collectToolCalls(messages, pins.recentFrom, pins.whole);
  const candidates = calls.filter((call) => !call.pinned);
  if (candidates.length === 0) return { decisions: [], requests: 0 };
  const fitted = fitState(messages, calls, { maxStateTokens: OPTIONS.maxStateTokens, recentFrom: pins.recentFrom });
  const batches = batchCalls(candidates, fitted.tokens, OPTIONS.maxRequestTokens);
  const answers = new Map<string, readonly [number, number]>();
  for (const map of await Promise.all(batches.map((batch) => askBatch(asker, fitted.state, batch)))) for (const [id, answer] of map) answers.set(id, answer);
  const decisions = candidates.map((call) => {
    const [keepCall, keepResult] = answers.get(call.id) ?? [1, 1];
    return { call, action: decideCall(call, keepCall, keepResult, OPTIONS.keepThreshold) };
  });
  return { decisions, requests: batches.length };
}
