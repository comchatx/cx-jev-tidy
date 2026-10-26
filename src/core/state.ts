// Ported from tamaratran/fast-jev-compaction at e3f262a7 (MIT); the notice is in the package's THIRD_PARTY_NOTICES.md.
// The port reads pi's message shape: a tool result is its own message, paired with its call by the call's id.
import { JevError } from "./jev.js";

/** One model-visible message, as the pass reads it. */
export type TidyMessage = {
  readonly entryId: string;
  readonly role: "user" | "assistant" | "toolResult";
  /** The message's text blocks, joined; a tool result's text is never read, only its length. */
  readonly text: string;
  readonly toolCalls: readonly { readonly id: string; readonly name: string; readonly arguments: Readonly<Record<string, unknown>> }[];
  readonly result?: { readonly toolCallId: string; readonly chars: number; readonly isError: boolean };
  /** What the message costs in the model's context, as pi estimates it. */
  readonly tokens: number;
};

/** A tool call paired with its result. */
export type ToolCall = {
  /** Short id used in the Jev state and question names (`t1`, `t2`, ...). */
  readonly id: string;
  readonly toolCallId: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly callIndex: number;
  readonly resultIndex: number;
  readonly resultChars: number;
  readonly isError: boolean;
  /** In the first message or pi's recent window, or held whole by the caller; never a candidate. */
  readonly pinned: boolean;
};

type HistoryToolCall = { id: string; tool: string; input: string; result: string };
type HistoryEntry = { i: number; role: "user" | "assistant"; text: string; tool_calls?: HistoryToolCall[] | string[] };
export type CompactionState = { readonly context: string; readonly goal: string; readonly history: HistoryEntry[] };
export type FittedState = { readonly state: CompactionState; readonly tokens: number; readonly stage: string };

export const STATE_CONTEXT =
  "A coding assistant conversation is being compacted to free context. `history` is the whole conversation so far, oldest first; tool outputs are replaced by a short `result` note and long texts may be abridged. Each question asks whether one tool call, or the full output of that call, still needs to stay in the history verbatim. Whatever is not kept is deleted from what the assistant sees. A file on disk can be read again; a supplier fetch (`cx get`, `cx raw`) costs the seller money and is not repeated.";

/** Successive caps on the serialised tool input included per call. */
const INPUT_CHARS = [1000, 200, 60] as const;
const TEXT_HEAD = 400;
const TEXT_TAIL = 150;
const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g;

/**
 * Estimates Jev's tokens without a tokenizer: a word costs one token per six letters, a digit half a token, any other symbol nine tenths.
 * The library calibrated it against the usage Jev reports, landing 2–18% above the true count.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const [piece] of text.matchAll(TOKEN_PIECES)) {
    const first = piece.charCodeAt(0);
    if (first >= 48 && first <= 57) tokens += piece.length / 2;
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) tokens += 1 + Math.floor((piece.length - 1) / 6);
    else tokens += 0.9;
  }
  return Math.ceil(tokens);
}

const truncate = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`);

function abridge(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 40) return text;
  return `${text.slice(0, head)}\n[… ${text.length - head - tail} chars omitted …]\n${text.slice(-tail)}`;
}

export const isPinned = (index: number, recentFrom: number): boolean => index === 0 || index >= recentFrom;

/**
 * Where pi's recent window starts: walking back from the newest message, the one at which the messages from there on reach
 * `keepRecentTokens`, as pi's own cut point counts them; the whole conversation where they never do.
 */
export function recentFrom(messages: readonly TidyMessage[], keepRecentTokens: number): number {
  let kept = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    kept += messages[index]!.tokens;
    if (kept >= keepRecentTokens) return index;
  }
  return 0;
}

/**
 * Pairs every tool call with its result; a call without a result is not a candidate (there is nothing to drop yet). A result belongs to the
 * nearest earlier call carrying its id that has no result yet, as it stands in pi's record, so an id a provider uses in two turns pairs each
 * call with its own result.
 */
export function collectToolCalls(messages: readonly TidyMessage[], recent: number, whole: (call: Omit<ToolCall, "id" | "pinned">) => boolean = () => false): ToolCall[] {
  const open: { readonly callIndex: number; readonly call: TidyMessage["toolCalls"][number]; result?: { readonly index: number; readonly chars: number; readonly isError: boolean } }[] = [];
  messages.forEach((message, index) => {
    for (const call of message.toolCalls) open.push({ callIndex: index, call });
    const result = message.result;
    if (result === undefined) return;
    const owner = open.findLast((one) => one.result === undefined && one.call.id === result.toolCallId && one.callIndex < index);
    if (owner !== undefined) owner.result = { index, chars: result.chars, isError: result.isError };
  });
  const calls: ToolCall[] = [];
  for (const { callIndex, call, result } of open) {
    if (result === undefined) continue;
    const paired = { toolCallId: call.id, tool: call.name, input: call.arguments, callIndex, resultIndex: result.index, resultChars: result.chars, isError: result.isError };
    calls.push({ id: `t${calls.length + 1}`, ...paired, pinned: isPinned(callIndex, recent) || isPinned(result.index, recent) || whole(paired) });
  }
  return calls;
}

function inputText(input: Readonly<Record<string, unknown>>, limit: number): string {
  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    json = "[unserializable input]";
  }
  return truncate(json, limit);
}

/** A result goes to Jev only as a note of its length. */
const resultNote = (call: ToolCall): string => `${call.isError ? "error" : "ok"}, ${call.resultChars} chars (omitted)`;

/** One call as a single line, for when the structured form is too costly. */
function compactCall(call: ToolCall): string {
  const input = Object.entries(call.input)
    .map(([key, value]) => `${key}=${(typeof value === "string" ? value : inputText({ [key]: value }, 200)).replace(/\s+/g, " ")}`)
    .join(" ");
  return `${call.id} ${call.tool} ${truncate(input, INPUT_CHARS[2])} → ${call.isError ? "error" : "ok"} ${call.resultChars}ch`;
}

/** Folds runs of adjacent call-only entries into one entry each, so the per-entry envelope is paid once per run. */
function mergeCallRuns(history: readonly HistoryEntry[], pinned: (e: HistoryEntry) => boolean): HistoryEntry[] {
  const foldable = (e: HistoryEntry): boolean => !pinned(e) && e.text.length === 0 && typeof e.tool_calls?.[0] === "string";
  const merged: HistoryEntry[] = [];
  for (const entry of history) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && foldable(previous) && foldable(entry) && previous.role === entry.role) {
      previous.tool_calls = [...(previous.tool_calls as string[]), ...(entry.tool_calls as string[])];
      continue;
    }
    merged.push({ ...entry });
  }
  return merged;
}

function callsByMessage(calls: readonly ToolCall[]): Map<number, ToolCall[]> {
  const byMessage = new Map<number, ToolCall[]>();
  for (const call of calls) byMessage.set(call.callIndex, [...(byMessage.get(call.callIndex) ?? []), call]);
  return byMessage;
}

function historyEntries(messages: readonly TidyMessage[], calls: readonly ToolCall[], inputChars: number): HistoryEntry[] {
  const byMessage = callsByMessage(calls);
  const entries: HistoryEntry[] = [];
  messages.forEach((message, i) => {
    if (message.role === "toolResult") return;
    const toolCalls = (byMessage.get(i) ?? []).map((call) => ({ id: call.id, tool: call.tool, input: inputText(call.input, inputChars), result: resultNote(call) }));
    if (message.text.trim().length === 0 && toolCalls.length === 0) return;
    entries.push({ i, role: message.role, text: message.text, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) });
  });
  return entries;
}

/** The last three user prompts, as the goal. */
export const goalFromMessages = (messages: readonly TidyMessage[]): string =>
  messages
    .filter((message) => message.role === "user" && message.text.trim().length > 0)
    .slice(-3)
    .map((message) => truncate(message.text, 500))
    .join("\n");

/**
 * Builds the Jev state from the whole conversation and shrinks it in stages until it fits `maxStateTokens`: tool inputs are truncated, then
 * long texts are abridged oldest-first (pinned messages last), then old messages collapse to a one-line note, then old tool calls shrink to
 * one line each, then old messages that carry no call are left out, then runs of old call-only messages are folded into one entry. Throws
 * when even that is too big.
 */
export function fitState(messages: readonly TidyMessage[], calls: readonly ToolCall[], options: { readonly maxStateTokens: number; readonly recentFrom: number }): FittedState {
  const goal = goalFromMessages(messages);
  const stateOf = (history: HistoryEntry[]): CompactionState => ({ context: STATE_CONTEXT, goal, history });
  const entryTokens = (entry: HistoryEntry): number => estimateTokens(JSON.stringify(entry)) + 1;
  const baseTokens = estimateTokens(JSON.stringify(stateOf([])));
  const fitted = (history: HistoryEntry[], tokens: number, stage: string): FittedState => ({ state: stateOf(history), tokens, stage });

  let history: HistoryEntry[] = [];
  let perEntry: number[] = [];
  let tokens = 0;
  const rebuild = (inputChars: number): void => {
    history = historyEntries(messages, calls, inputChars);
    perEntry = history.map(entryTokens);
    tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0);
  };
  const fits = (): boolean => tokens <= options.maxStateTokens;
  const shrink = (index: number, change: (entry: HistoryEntry) => void): void => {
    const entry = history[index];
    if (entry === undefined) return;
    change(entry);
    const now = entryTokens(entry);
    tokens += now - (perEntry[index] ?? 0);
    perEntry[index] = now;
  };

  rebuild(INPUT_CHARS[0]);
  if (fits()) return fitted(history, tokens, "full");
  for (const limit of INPUT_CHARS.slice(1)) {
    rebuild(limit);
    if (fits()) return fitted(history, tokens, `inputs<=${limit}`);
  }

  const pinned = (entry: HistoryEntry): boolean => isPinned(entry.i, options.recentFrom);
  const indices = history.map((_, index) => index);
  const order = [...indices.filter((index) => !pinned(history[index]!)), ...indices.filter((index) => pinned(history[index]!))];

  for (const index of order) {
    if (history[index]!.text.length <= TEXT_HEAD + TEXT_TAIL + 40) continue;
    shrink(index, (e) => { e.text = abridge(e.text, TEXT_HEAD, TEXT_TAIL); });
    if (fits()) return fitted(history, tokens, "texts abridged");
  }

  for (const index of order) {
    const entry = history[index]!;
    if (pinned(entry) || entry.text.length === 0) continue;
    const original = messages[entry.i]?.text.length ?? entry.text.length;
    shrink(index, (e) => { e.text = `[… ${original} chars omitted …]`; });
    if (fits()) return fitted(history, tokens, "old messages collapsed");
  }

  const byMessage = callsByMessage(calls);
  for (const index of order) {
    const entry = history[index]!;
    const own = byMessage.get(entry.i);
    if (pinned(entry) || own === undefined) continue;
    shrink(index, (e) => { e.tool_calls = own.map(compactCall); });
    if (fits()) return fitted(history, tokens, "old calls compacted");
  }

  const left = new Set<number>();
  for (const index of order) {
    const entry = history[index]!;
    if (pinned(entry) || entry.tool_calls !== undefined) continue;
    left.add(index);
    tokens -= perEntry[index] ?? 0;
    if (fits()) return fitted(history.filter((_, i) => !left.has(i)), tokens, "old messages left out");
  }

  history = mergeCallRuns(history.filter((_, i) => !left.has(i)), pinned);
  perEntry = history.map(entryTokens);
  tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0);
  if (fits()) return fitted(history, tokens, "old calls merged");
  throw new JevError("oversize", `history too large for Jev (~${tokens} tokens after truncation, limit ${options.maxStateTokens})`);
}
