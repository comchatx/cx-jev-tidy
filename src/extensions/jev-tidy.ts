import {
  estimateTokens,
  getAgentDir,
  SettingsManager,
  shouldCompact,
  type BoundaryResult,
  type BoundaryState,
  type ContextEditEntryDraft,
  type ExtensionAPI,
  type ExtensionContext,
  type ProjectedSessionEntry,
} from "@earendil-works/pi-coding-agent";
import { decide, type CallDecision } from "../core/decide.js";
import { httpAsker, JevError, type JevAsker } from "../core/jev.js";
import { recentFrom, type TidyMessage, type ToolCall } from "../core/state.js";

type AgentMessage = ProjectedSessionEntry["messages"][number];
type Content = Extract<AgentMessage, { role: "assistant" }>["content"];

/** The box's own listener; it adds the box token and the platform proxy puts the tenant's TypeSafe key, or the platform's, in the placeholder's place. */
export const JEV_URL = "http://127.0.0.1:8081/providers/typesafe/v1/systemone";
const PROXY_HEADERS = Object.freeze({ authorization: "Bearer cmx-placeholder-key" });
const TIMEOUT_MS = 20_000;
/** A pass that frees less than this share of the context proposes nothing, and pi's summary follows. */
export const MIN_FREED = 0.25;
/**
 * A pass removes at most this share of the context it found, whatever Jev answers: the oldest of what Jev would let go goes first, and the
 * rest stays. A pass needs a quarter to stand and runs again at the next line, so half is room enough; past it, one pass could leave the
 * model a conversation whose working past is gone, which pi's own summary, written from the whole, would not.
 */
export const MAX_FREED = 0.5;
/** Characters of a dropped tool result that stay, ahead of the note. */
export const HEAD_CHARS = 300;
/** The custom entry a pass writes into the session where it ran, the record the page reads the conversation from. */
export const PASS_ENTRY = "cx-jev-tidy";
/** What one pass did: the context's tokens before it and after, how many results it cut and calls it dropped, and what the stubs cost. */
export type PassRecord = { readonly before: number; readonly after: number; readonly cut: number; readonly dropped: number; readonly stubTokens: number };

export type Deps = {
  readonly asker: JevAsker;
  /** Pi's own compaction settings for the current model: whether tidying is on, and the model's reserve. */
  readonly settings: (ctx: ExtensionContext) => ReturnType<SettingsManager["getCompactionSettings"]>;
  readonly log: (line: string) => void;
};

const textOf = (content: string | readonly { readonly type: string; readonly text?: string }[]): string =>
  typeof content === "string" ? content : content.flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n");

/** The model-visible user, assistant and tool-result messages, each with the entry it came from; custom, summary and system messages are not read. */
function readMessages(entries: readonly ProjectedSessionEntry[]): { readonly messages: TidyMessage[]; readonly byEntry: ReadonlyMap<string, AgentMessage> } {
  const messages: TidyMessage[] = [];
  const byEntry = new Map<string, AgentMessage>();
  for (const { sourceEntry, messages: projected } of entries) {
    const message = projected[0];
    if (sourceEntry.type !== "message" || projected.length !== 1 || message === undefined) continue;
    const entryId = sourceEntry.id;
    if (message.role === "user") messages.push({ entryId, role: "user", text: textOf(message.content), toolCalls: [], tokens: estimateTokens(message) });
    else if (message.role === "assistant") {
      const toolCalls = message.content.flatMap((block) => (block.type === "toolCall" ? [{ id: block.id, name: block.name, arguments: block.arguments }] : []));
      messages.push({ entryId, role: "assistant", text: textOf(message.content), toolCalls, tokens: estimateTokens(message) });
    } else if (message.role === "toolResult") {
      messages.push({ entryId, role: "toolResult", text: "", toolCalls: [], result: { toolCallId: message.toolCallId, chars: textOf(message.content).length, isError: message.isError }, tokens: estimateTokens(message) });
    } else continue;
    byEntry.set(entryId, message);
  }
  return { messages, byEntry };
}

/** A call that buys from a supplier: `cx get` or `cx raw` in a shell command. Its answer cost the seller money and is not fetched twice. */
const PAID = /(?:^|[\s;&|(`])cx\s+(?:get|raw)\b/;
export const isPaid = (input: Readonly<Record<string, unknown>>): boolean => typeof input["command"] === "string" && PAID.test(input["command"]);

/** The files a `cx` receipt says its answers landed at: `-> <path>` on a text line, `"file"` in `--json`; each once, in order. */
export function landedAt(text: string): readonly string[] {
  const paths = [...text.matchAll(/(?:^|\s)-> (\/\S+)/gm), ...text.matchAll(/"file"\s*:\s*"(\/[^"]+)"/g)].map((match) => match[1]!);
  return [...new Set(paths)];
}

/**
 * A dropped result keeps its head and a note naming everything that went, images included, and where a paid answer lies on disk; one whose
 * text is already short is left as it is.
 */
export function cutResult(text: string, isError: boolean, images = 0, paths: readonly string[] = []): string {
  if (text.length <= HEAD_CHARS + 120) return text;
  const alsoImages = images === 0 ? "" : ` and ${images} image${images === 1 ? "" : "s"}`;
  const onDisk = paths.length === 0 ? "" : `; what it fetched is on disk at ${paths.join(", ")}`;
  return `${text.slice(0, HEAD_CHARS)}\n[cx-jev-tidy cut ${text.length - HEAD_CHARS} chars${alsoImages} of this tool result${isError ? " (error)" : ""}${onDisk}]`;
}

const STUB_INPUT_CHARS = 120;

/** What stands where a dropped call stood: its tool, its input's first line, and that the pass dropped it with its result. */
export function stubFor(tool: string, input: Readonly<Record<string, unknown>>): string {
  const said = typeof input["command"] === "string" ? input["command"] : JSON.stringify(input);
  const line = (said.split("\n")[0] ?? "").trim();
  return `[cx-jev-tidy dropped this ${tool} call and its result: ${line.length > STUB_INPUT_CHARS ? `${line.slice(0, STUB_INPUT_CHARS - 1)}…` : line}]`;
}

type Pass = { readonly edits: ContextEditEntryDraft[]; readonly freed: number; readonly cut: number; readonly dropped: number; readonly stubTokens: number };

/**
 * The `context_edit` drafts for the decisions, oldest first, up to `bound` tokens freed: a dropped call leaves a stub in its place and goes
 * with its result, which a paid call never does; a cut result keeps its head and a note; text is never edited. A decision that would pass
 * the bound is taken as a cut where a cut still fits, else as a keep.
 */
export function editsFor(decisions: readonly CallDecision[], messages: readonly TidyMessage[], byEntry: ReadonlyMap<string, AgentMessage>, bound = Number.POSITIVE_INFINITY): Pass {
  const results: ContextEditEntryDraft[] = [];
  const assistants = new Map<string, { content: Content; tokens: number }>();
  let freed = 0;
  let cut = 0;
  let dropped = 0;
  let stubTokens = 0;
  for (const { call, action } of decisions) {
    if (action === "keep") continue;
    const resultEntry = messages[call.resultIndex]!.entryId;
    const result = byEntry.get(resultEntry)!;
    if (result.role !== "toolResult") continue;
    const paid = isPaid(call.input);
    const text = textOf(result.content);
    const cutText = cutResult(text, result.isError, result.content.filter((block) => block.type !== "text").length, paid ? landedAt(text) : []);
    const content = [{ type: "text" as const, text: cutText }];
    const cutting = cutText === text ? undefined : estimateTokens(result) - estimateTokens({ ...result, content });
    if (action === "drop_call" && !paid) {
      const callEntry = messages[call.callIndex]!.entryId;
      const message = byEntry.get(callEntry)!;
      if (message.role !== "assistant") continue;
      const now = assistants.get(callEntry) ?? { content: message.content, tokens: estimateTokens(message) };
      const stub = stubFor(call.tool, call.input);
      const stubbed: Content = now.content.map((block) => (block.type === "toolCall" && block.id === call.toolCallId ? { type: "text", text: stub } : block));
      const tokens = estimateTokens({ ...message, content: stubbed });
      const dropping = estimateTokens(result) + now.tokens - tokens;
      if (freed + dropping <= bound) {
        assistants.set(callEntry, { content: stubbed, tokens });
        results.push({ type: "context_edit", targetId: resultEntry, replacement: null });
        freed += dropping;
        dropped += 1;
        stubTokens += estimateTokens({ ...message, content: [{ type: "text", text: stub }] }) - estimateTokens({ ...message, content: [] });
        continue;
      }
    }
    if (cutting === undefined || freed + cutting > bound) continue;
    results.push({ type: "context_edit", targetId: resultEntry, replacement: { content } });
    freed += cutting;
    cut += 1;
  }
  const edits: ContextEditEntryDraft[] = [...results, ...[...assistants].map(([targetId, { content }]) => ({ type: "context_edit" as const, targetId, replacement: { content } }))];
  return { edits, freed, cut, dropped, stubTokens };
}

/**
 * One boundary: when the projected context is past pi's own line for the current model, one Jev pass proposes `context_edit` entries, and
 * nothing else. Anything short of a pass that frees a quarter of the context proposes nothing, so pi's own check that follows runs its summary.
 * Undefined when the boundary is not past the line: nothing was asked.
 */
export async function tidy(event: BoundaryState, ctx: ExtensionContext, deps: Deps): Promise<BoundaryResult | undefined> {
  if (event.outcome !== "completed" || ctx.model === undefined) return undefined;
  let usage: { readonly tokens: number; readonly keepRecentTokens: number };
  try {
    const known = ctx.getContextUsage();
    const settings = deps.settings(ctx);
    if (known?.tokens == null || !shouldCompact(known.tokens, known.contextWindow, settings)) return undefined;
    usage = { tokens: known.tokens, keepRecentTokens: settings.keepRecentTokens };
  } catch {
    // Settings pi cannot read are pi's to report; the pass stays out of the way.
    return undefined;
  }
  try {
    const { messages, byEntry } = readMessages(event.context.contextEntries);
    // A paid answer whose receipt names no file has nowhere else to be read from: it stays whole and Jev is not asked about it.
    const whole = (call: Pick<ToolCall, "input" | "resultIndex">): boolean => {
      const result = byEntry.get(messages[call.resultIndex]!.entryId);
      return isPaid(call.input) && result?.role === "toolResult" && landedAt(textOf(result.content)).length === 0;
    };
    const { decisions, requests } = await decide(messages, deps.asker, { recentFrom: recentFrom(messages, usage.keepRecentTokens), whole });
    const pass = editsFor(decisions, messages, byEntry, MAX_FREED * usage.tokens);
    if (pass.freed < MIN_FREED * usage.tokens) {
      if (requests > 0) deps.log(`cx-jev-tidy: freed ${pass.freed} of ${usage.tokens} tokens, under a quarter; pi's summary follows`);
      return {};
    }
    const record: PassRecord = { before: usage.tokens, after: usage.tokens - pass.freed, cut: pass.cut, dropped: pass.dropped, stubTokens: pass.stubTokens };
    return { entries: [...pass.edits, { type: "custom", customType: PASS_ENTRY, data: record }] };
  } catch (error) {
    deps.log(`cx-jev-tidy: ${error instanceof JevError ? `${error.kind}: ${error.message}` : "failed"}; pi's summary follows`);
    return {};
  }
}

/** The newest model-visible message entry: a boundary that sees the one a pass already saw has nothing new to ask Jev about. */
const newestMessage = (event: BoundaryState): string | undefined => event.context.contextEntries.findLast((entry) => entry.sourceEntry.type === "message")?.sourceEntry.id;

export function jevTidy(deps: Deps): (pi: ExtensionAPI) => void {
  return (pi) => {
    let seen: string | undefined;
    const boundary = async (event: BoundaryState, ctx: ExtensionContext): Promise<BoundaryResult> => {
      const newest = newestMessage(event);
      if (newest === undefined || newest === seen) return {};
      const result = await tidy(event, ctx, deps);
      if (result === undefined) return {};
      seen = newest;
      return result;
    };
    pi.on("turn_end", boundary);
    pi.on("agent_before_settle", boundary);
  };
}

export default jevTidy({
  asker: httpAsker(JEV_URL, PROXY_HEADERS, TIMEOUT_MS),
  settings: (ctx) => SettingsManager.create(ctx.cwd, getAgentDir()).getCompactionSettings(ctx.model),
  log: (line) => console.error(line),
});
