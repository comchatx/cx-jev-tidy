import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BoundaryState } from "@earendil-works/pi-coding-agent";

type Message = Parameters<SessionManager["appendMessage"]>[0];

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 }) as Message;
export const assistant = (text: string, calls: readonly { id: string; path: string }[] = [], totalTokens = 0, thinking = ""): Message =>
  ({
    role: "assistant",
    content: [...(thinking === "" ? [] : [{ type: "thinking", thinking }]), ...(text === "" ? [] : [{ type: "text", text }]), ...calls.map(({ id, path }) => ({ type: "toolCall", id, name: "read", arguments: { path } }))],
    api: "openai-completions",
    provider: "fake",
    model: "fake-1m",
    usage: { ...USAGE, input: totalTokens, totalTokens },
    stopReason: calls.length > 0 ? "toolUse" : "stop",
    timestamp: 0,
  }) as Message;
export const result = (id: string, text: string, isError = false, images = 0): Message =>
  ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }, ...Array.from({ length: images }, () => ({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }))], isError, timestamp: 0 }) as Message;

/**
 * A long working session in pi's own session manager: `rounds` rounds of a question, a read of one file and its long output, each answered.
 * Round `r` reads `file-r` and its output is `resultChars` characters of that file; the model thinks before each read, which never leaves the box.
 */
export function workingSession(rounds: number, resultChars: number): SessionManager {
  const session = SessionManager.inMemory("/tenant");
  session.appendMessage(user("Audit the seller's listings and tell me which ones lost the buy box this week."));
  for (let r = 1; r <= rounds; r += 1) {
    session.appendMessage(assistant(`Reading file-${r}.`, [{ id: `call-${r}`, path: `file-${r}.csv` }], 0, `private reasoning before file-${r}`));
    session.appendMessage(result(`call-${r}`, `row of file-${r} `.repeat(Math.ceil(resultChars / 14) + 1).slice(0, resultChars)));
    session.appendMessage(assistant(`File ${r} holds ${r} listings that lost the buy box.`));
    session.appendMessage(user(`Now look at the next file (${r + 1}).`));
  }
  return session;
}

/** The boundary pi would hand the extension over this session: its projection as the context preview, no drafts yet. */
export function boundaryOver(session: SessionManager, type: "turn_end" | "agent_before_settle" = "turn_end", outcome: BoundaryState["outcome"] = "completed"): BoundaryState & { type: string } {
  const projection = session.buildSessionProjection();
  return { type, entries: [], continue: false, outcome, context: { contextEntries: projection.entries, contextMessages: projection.messages, llmMessages: [], pendingMessages: [], canContinue: false } };
}

/** The slice of the extension context the pass reads: the model, and pi's context usage for it. */
export const contextAt = (tokens: number | null, contextWindow = 1_000_000): ExtensionContext =>
  ({ model: { provider: "fake", id: "fake-1m", contextWindow }, cwd: "/tenant", getContextUsage: () => ({ tokens, contextWindow, percent: tokens === null ? null : (tokens / contextWindow) * 100 }) }) as unknown as ExtensionContext;

/** A turn that runs one shell command through pi's bash tool. */
export const shell = (id: string, command: string): Message =>
  ({ ...assistant(""), content: [{ type: "toolCall", id, name: "bash", arguments: { command } }], stopReason: "toolUse" }) as Message;
export const output = (id: string, text: string): Message => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: 0 }) as Message;
