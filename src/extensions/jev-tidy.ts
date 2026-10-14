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
import type { TidyMessage } from "../core/state.js";

type AgentMessage = ProjectedSessionEntry["messages"][number];
type Content = Extract<AgentMessage, { role: "assistant" }>["content"];

/** The box's own listener; it adds the box token and the platform proxy puts the tenant's TypeSafe key, or the platform's, in the placeholder's place. */
export const JEV_URL = "http://127.0.0.1:8081/providers/typesafe/v1/systemone";
const PROXY_HEADERS = Object.freeze({ authorization: "Bearer cmx-placeholder-key" });
const TIMEOUT_MS = 20_000;
/** A pass that frees less than this share of the context proposes nothing, and pi's summary follows. */
export const MIN_FREED = 0.25;
/** Characters of a dropped tool result that stay, ahead of the note. */
export const HEAD_CHARS = 300;

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
    if (message.role === "user") messages.push({ entryId, role: "user", text: textOf(message.content), toolCalls: [] });
    else if (message.role === "assistant") {
      const toolCalls = message.content.flatMap((block) => (block.type === "toolCall" ? [{ id: block.id, name: block.name, arguments: block.arguments }] : []));
      messages.push({ entryId, role: "assistant", text: textOf(message.content), toolCalls });
    } else if (message.role === "toolResult") {
      messages.push({ entryId, role: "toolResult", text: "", toolCalls: [], result: { toolCallId: message.toolCallId, chars: textOf(message.content).length, isError: message.isError } });
    } else continue;
    byEntry.set(entryId, message);
  }
  return { messages, byEntry };
}

/** A dropped result keeps its head and a note naming everything that went, images included; one whose text is already short is left as it is. */
export function cutResult(text: string, isError: boolean, images = 0): string {
  if (text.length <= HEAD_CHARS + 120) return text;
  const alsoImages = images === 0 ? "" : ` and ${images} image${images === 1 ? "" : "s"}`;
  return `${text.slice(0, HEAD_CHARS)}\n[cx-jev-tidy cut ${text.length - HEAD_CHARS} chars${alsoImages} of this tool result${isError ? " (error)" : ""}]`;
}

/** The `context_edit` drafts for the decisions: a dropped call leaves with its result, and text is never edited. */
export function editsFor(decisions: readonly CallDecision[], messages: readonly TidyMessage[], byEntry: ReadonlyMap<string, AgentMessage>): { readonly edits: ContextEditEntryDraft[]; readonly freed: number } {
  const edits: ContextEditEntryDraft[] = [];
  let freed = 0;
  const droppedCalls = new Map<string, Set<string>>();
  for (const { call, action } of decisions) {
    const resultEntry = messages[call.resultIndex]!.entryId;
    const result = byEntry.get(resultEntry)!;
    if (action === "drop_call") {
      const callEntry = messages[call.callIndex]!.entryId;
      droppedCalls.set(callEntry, (droppedCalls.get(callEntry) ?? new Set()).add(call.toolCallId));
      edits.push({ type: "context_edit", targetId: resultEntry, replacement: null });
      freed += estimateTokens(result);
    } else if (action === "drop_result" && result.role === "toolResult") {
      const text = textOf(result.content);
      const cut = cutResult(text, result.isError, result.content.filter((block) => block.type !== "text").length);
      if (cut === text) continue;
      const content = [{ type: "text" as const, text: cut }];
      edits.push({ type: "context_edit", targetId: resultEntry, replacement: { content } });
      freed += estimateTokens(result) - estimateTokens({ ...result, content });
    }
  }
  for (const [entryId, dropped] of droppedCalls) {
    const message = byEntry.get(entryId)!;
    if (message.role !== "assistant") continue;
    const content: Content = message.content.filter((block) => block.type !== "toolCall" || !dropped.has(block.id));
    const kept = content.some((block) => block.type === "text" || block.type === "toolCall");
    edits.push({ type: "context_edit", targetId: entryId, replacement: kept ? { content } : null });
    freed += estimateTokens(message) - (kept ? estimateTokens({ ...message, content }) : 0);
  }
  return { edits, freed };
}

/**
 * One boundary: when the projected context is past pi's own line for the current model, one Jev pass proposes `context_edit` entries, and
 * nothing else. Anything short of a pass that frees a quarter of the context proposes nothing, so pi's own check that follows runs its summary.
 * Undefined when the boundary is not past the line: nothing was asked.
 */
export async function tidy(event: BoundaryState, ctx: ExtensionContext, deps: Deps): Promise<BoundaryResult | undefined> {
  if (event.outcome !== "completed" || ctx.model === undefined) return undefined;
  let usage: { readonly tokens: number };
  try {
    const known = ctx.getContextUsage();
    if (known?.tokens == null || !shouldCompact(known.tokens, known.contextWindow, deps.settings(ctx))) return undefined;
    usage = { tokens: known.tokens };
  } catch {
    // Settings pi cannot read are pi's to report; the pass stays out of the way.
    return undefined;
  }
  try {
    const { messages, byEntry } = readMessages(event.context.contextEntries);
    const { decisions, requests } = await decide(messages, deps.asker);
    const { edits, freed } = editsFor(decisions, messages, byEntry);
    if (freed < MIN_FREED * usage.tokens) {
      if (requests > 0) deps.log(`cx-jev-tidy: freed ${freed} of ${usage.tokens} tokens, under a quarter; pi's summary follows`);
      return {};
    }
    return { entries: edits };
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
