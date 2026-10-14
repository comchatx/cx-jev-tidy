import { estimateTokens, type ExtensionAPI, type ContextEditEntryDraft } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { JevError, type JevAsker, type JevQuestions, type JevState } from "../src/core/jev.js";
import { assistant, boundaryOver, contextAt, result, user, workingSession } from "./conversation.js";
import { HEAD_CHARS, jevTidy, MIN_FREED, tidy, type Deps } from "../src/extensions/jev-tidy.js";

/** A 1M-window model whose line is 200,000 tokens of context (a ComChatX box's), so a reserve of 800,000. */
const LINE_SETTINGS = { enabled: true, reserveTokens: 800_000, keepRecentTokens: 20_000 };

/** A fake Jev: every result may go; the calls of odd-numbered tool calls go too, the even ones stay. */
function fakeJev(policy: (question: string) => number = (q) => (q.startsWith("result_") ? 0.1 : Number(q.slice("call_t".length)) % 2 === 1 ? 0.1 : 0.9)) {
  const asked: { state: JevState; questions: JevQuestions }[] = [];
  const asker: JevAsker = {
    ask: async (state, questions) => {
      asked.push({ state, questions });
      return { answers: Object.fromEntries(Object.keys(questions).map((q) => [q, { type: "noul", noul: policy(q) }])) };
    },
  };
  return { asker, asked };
}

const depsWith = (asker: JevAsker, settings = LINE_SETTINGS): Deps & { lines: string[] } => {
  const lines: string[] = [];
  return { asker, settings: () => settings, log: (line) => lines.push(line), lines };
};

const edits = (entries: readonly unknown[] | undefined): ContextEditEntryDraft[] => (entries ?? []) as ContextEditEntryDraft[];

describe("one Jev pass at a boundary past the line", () => {
  it("proposes only context_edit entries: a dropped result keeps its head and a note, a dropped call leaves with its result, and text stays", async () => {
    const session = workingSession(20, 20_000);
    const { asker, asked } = fakeJev();
    const deps = depsWith(asker);
    const out = await tidy(boundaryOver(session), contextAt(210_000), deps);
    expect(out?.continue).toBeUndefined();
    const proposed = edits(out?.entries);
    expect(proposed.length).toBeGreaterThan(0);
    expect(proposed.every((entry) => entry.type === "context_edit")).toBe(true);
    expect(asked.length).toBeGreaterThan(0);

    const byId = new Map(session.getBranch().map((entry) => [entry.id, entry]));
    const messageOf = (id: string) => { const entry = byId.get(id); return entry?.type === "message" ? entry.message : undefined; };
    for (const edit of proposed) {
      const target = messageOf(edit.targetId)!;
      expect(target.role, "user messages are never edited").not.toBe("user");
      if (target.role === "toolResult" && edit.replacement !== null) {
        const [block] = edit.replacement.content as { type: string; text: string }[];
        expect(block!.text.slice(0, HEAD_CHARS)).toBe((target.content[0] as { text: string }).text.slice(0, HEAD_CHARS));
        expect(block!.text).toContain(`[cx-jev-tidy cut ${20_000 - HEAD_CHARS} chars of this tool result]`);
      }
      if (target.role === "assistant") {
        expect(edit.replacement, "an assistant message with text keeps it").not.toBeNull();
        const content = edit.replacement!.content as { type: string; text?: string }[];
        expect(content).toEqual(target.content.filter((block) => block.type !== "toolCall"));
      }
    }

    // The first message and the newest six are pinned: nothing touches round 20's call and result, or the first request.
    const branch = session.getBranch();
    const pinned = [branch[0]!, ...branch.slice(-6)].map((entry) => entry.id);
    expect(proposed.filter((edit) => pinned.includes(edit.targetId))).toEqual([]);

    // Applied through pi, no tool result is left without its call, and the next request is smaller.
    const before = session.buildSessionProjection().messages.reduce((sum, message) => sum + estimateTokens(message), 0);
    for (const edit of proposed) session.appendContextEdit(edit.targetId, edit.replacement);
    const after = session.buildSessionProjection().messages;
    const called = new Set(after.flatMap((message) => (message.role === "assistant" ? message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])) : [])));
    for (const message of after) if (message.role === "toolResult") expect(called.has(message.toolCallId)).toBe(true);
    expect(after.reduce((sum, message) => sum + estimateTokens(message), 0)).toBeLessThan(before * (1 - MIN_FREED));
  });

  it("sends Jev the conversation's text and each call with its input, and a tool result only as a note of its length", async () => {
    const { asker, asked } = fakeJev();
    await tidy(boundaryOver(workingSession(20, 20_000)), contextAt(210_000), depsWith(asker));
    const sent = JSON.stringify(asked[0]!.state);
    expect(sent).toContain("Audit the seller's listings");
    expect(sent).toContain("File 3 holds 3 listings");
    expect(sent).toContain('\\"path\\":\\"file-3.csv\\"');
    expect(sent).toContain("ok, 20000 chars (omitted)");
    expect(sent).not.toContain("row of file-");
  });

  it("never sends the model's thinking", async () => {
    const session = workingSession(20, 20_000);
    expect(JSON.stringify(session.getBranch())).toContain("private reasoning before file-3");
    const { asker, asked } = fakeJev();
    await tidy(boundaryOver(session), contextAt(210_000), depsWith(asker));
    expect(asked.length).toBeGreaterThan(0);
    expect(JSON.stringify(asked)).not.toContain("private reasoning");
  });

  it("does nothing under pi's own line for the model, and passes once past it", async () => {
    const session = workingSession(20, 20_000);
    const { asker, asked } = fakeJev();
    expect(await tidy(boundaryOver(session), contextAt(200_000), depsWith(asker))).toBeUndefined();
    expect(asked).toEqual([]);
    expect(edits((await tidy(boundaryOver(session), contextAt(200_001), depsWith(asker)))?.entries).length).toBeGreaterThan(0);
  });

  it.each([
    ["compaction is off", { settings: { ...LINE_SETTINGS, enabled: false } }],
    ["the turn errored (overflow recovery is pi's)", { outcome: "error" as const }],
    ["the turn was aborted", { outcome: "aborted" as const }],
    ["pi does not know the context's size yet", { tokens: null }],
  ])("asks nothing when %s", async (_, when: { settings?: typeof LINE_SETTINGS; outcome?: "error" | "aborted"; tokens?: null }) => {
    const { asker, asked } = fakeJev();
    const out = await tidy(boundaryOver(workingSession(20, 20_000), "turn_end", when.outcome), contextAt(when.tokens === undefined ? 900_000 : when.tokens), depsWith(asker, when.settings));
    expect(out).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it("proposes nothing when the pass frees under a quarter of the context, so pi's summary follows", async () => {
    const { asker, asked } = fakeJev();
    const deps = depsWith(asker);
    // Pi counts the context at four times what the tool results make up: cutting all of them frees under a quarter.
    const session = workingSession(20, 20_000);
    const tokens = 4 * session.buildSessionProjection().messages.reduce((sum, message) => sum + estimateTokens(message), 0);
    expect(await tidy(boundaryOver(session), contextAt(tokens), deps)).toEqual({});
    expect(asked.length).toBeGreaterThan(0);
    expect(deps.lines).toEqual([expect.stringMatching(/^cx-jev-tidy: freed \d+ of \d+ tokens, under a quarter; pi's summary follows$/)]);
  });

  it.each([
    [new JevError("refused", "Jev request refused (404)"), "refused: Jev request refused (404)"],
    [new JevError("timeout", "Jev did not answer within 20000 ms"), "timeout: Jev did not answer within 20000 ms"],
    [new JevError("malformed", "Invalid Jev answer for call_t1"), "malformed: Invalid Jev answer for call_t1"],
    [new Error("something else"), "failed"],
  ])("proposes nothing when Jev fails (%s), leaving the summary to pi", async (error, line) => {
    const deps = depsWith({ ask: async () => { throw error; } });
    expect(await tidy(boundaryOver(workingSession(20, 20_000)), contextAt(210_000), deps)).toEqual({});
    expect(deps.lines).toEqual([`cx-jev-tidy: ${line}; pi's summary follows`]);
  });

  it("stays out of the way when pi's settings cannot be read", async () => {
    const { asker, asked } = fakeJev();
    const deps: Deps = { asker, settings: () => { throw new Error("unreadable settings"); }, log: () => {} };
    expect(await tidy(boundaryOver(workingSession(20, 20_000)), contextAt(900_000), deps)).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it("proposes nothing for an answer missing a question, which is a malformed answer", async () => {
    const deps = depsWith({ ask: async () => ({ answers: {} }) });
    expect(await tidy(boundaryOver(workingSession(20, 20_000)), contextAt(210_000), deps)).toEqual({});
    expect(deps.lines).toEqual(["cx-jev-tidy: malformed: Invalid Jev answer for call_t1; pi's summary follows"]);
  });

  it("asks nothing when every call is pinned", async () => {
    const session = workingSession(1, 20_000);
    const { asker, asked } = fakeJev();
    expect(await tidy(boundaryOver(session), contextAt(210_000), depsWith(asker))).toEqual({});
    expect(asked).toEqual([]);
  });

  it("keeps a cut result's first 300 characters and names the image that left with the rest; a result whose text is short keeps its image", async () => {
    const session = workingSession(0, 0);
    session.appendMessage(assistant("", [{ id: "shot", path: "a" }]));
    session.appendMessage(result("shot", "h".repeat(300) + "t".repeat(1_700), false, 1));
    session.appendMessage(assistant("", [{ id: "small", path: "b" }]));
    session.appendMessage(result("small", "tiny", false, 1));
    for (let i = 0; i < 6; i += 1) session.appendMessage(user(`filler ${i}`));
    const { asker } = fakeJev((q) => (q.startsWith("call_") ? 0.9 : 0.1));
    const proposed = edits((await tidy(boundaryOver(session), contextAt(4_000, 100_000), depsWith(asker)))?.entries);
    expect(proposed).toEqual([{ type: "context_edit", targetId: session.getBranch()[2]!.id, replacement: { content: [{ type: "text", text: `${"h".repeat(300)}\n[cx-jev-tidy cut 1700 chars and 1 image of this tool result]` }] } }]);
  });

  it("pairs a result with the nearest earlier call carrying its id: an id used in two turns, the earlier pair dropped, leaves the later pair whole", async () => {
    const session = workingSession(0, 0);
    session.appendMessage(assistant("First read.", [{ id: "dup", path: "a" }]));
    session.appendMessage(result("dup", "A".repeat(5_000)));
    session.appendMessage(assistant("Second read.", [{ id: "dup", path: "b" }]));
    session.appendMessage(result("dup", "B".repeat(5_000)));
    for (let i = 0; i < 6; i += 1) session.appendMessage(user(`filler ${i}`));
    const { asker } = fakeJev((q) => (q === "call_t1" || q === "result_t1" ? 0.1 : 0.9));
    const proposed = edits((await tidy(boundaryOver(session), contextAt(4_000, 100_000), depsWith(asker)))?.entries);
    expect(proposed.length).toBeGreaterThan(0);
    for (const edit of proposed) session.appendContextEdit(edit.targetId, edit.replacement);
    const after = session.buildSessionProjection().messages;
    const results = after.filter((message) => message.role === "toolResult");
    expect(results.map((message) => (message.content[0] as { text: string }).text.slice(0, 1))).toEqual(["B"]);
    const at = after.indexOf(results[0]!);
    const before = after[at - 1]!;
    expect(before.role === "assistant" && before.content.some((block) => block.type === "toolCall" && block.id === "dup" && (block.arguments as { path: string }).path === "b")).toBe(true);
  });

  it("leaves a dropped result already short enough as it is, and drops an assistant entry left with no text and no call", async () => {
    const session = workingSession(0, 0);
    session.appendMessage(assistant("", [{ id: "short", path: "a" }]));
    session.appendMessage(result("short", "tiny"));
    session.appendMessage(assistant("", [{ id: "long", path: "b" }]));
    session.appendMessage(result("long", "x".repeat(50_000)));
    for (let i = 0; i < 6; i += 1) session.appendMessage(user(`filler ${i}`));
    const { asker } = fakeJev((q) => (q === "call_t1" ? 0.9 : 0.1));
    // A small model, past its line, where the one long result is well over a quarter of the context.
    const proposed = edits((await tidy(boundaryOver(session), contextAt(20_000, 100_000), depsWith(asker)))?.entries);
    const branch = session.getBranch();
    // t1 keeps its call and loses its result, which is too short to cut; t2 goes whole, and its assistant entry holds nothing else.
    expect(proposed).toEqual([
      { type: "context_edit", targetId: branch[4]!.id, replacement: null },
      { type: "context_edit", targetId: branch[3]!.id, replacement: null },
    ]);
  });
});

describe("the extension pi loads", () => {
  const load = (deps: Deps) => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    jevTidy(deps)({ on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, handler) } as unknown as ExtensionAPI);
    return handlers;
  };

  it("hooks the two boundaries and nothing of compaction, so a manual compaction and overflow recovery stay pi's own", () => {
    expect([...load(depsWith(fakeJev().asker)).keys()].sort()).toEqual(["agent_before_settle", "turn_end"]);
  });

  it("asks Jev once for a state: the settle boundary after a turn_end pass has nothing new to ask about", async () => {
    const session = workingSession(20, 20_000);
    const { asker, asked } = fakeJev();
    const handlers = load(depsWith(asker));
    await handlers.get("turn_end")!(boundaryOver(session), contextAt(210_000));
    const once = asked.length;
    expect(once).toBeGreaterThan(0);
    expect(await handlers.get("agent_before_settle")!(boundaryOver(session, "agent_before_settle"), contextAt(210_000))).toEqual({});
    expect(asked.length).toBe(once);
    session.appendMessage(assistant("Done with the files."));
    await handlers.get("agent_before_settle")!(boundaryOver(session, "agent_before_settle"), contextAt(210_000));
    expect(asked.length).toBe(2 * once);
  });

  it("checks again at the next boundary when the last one was under the line", async () => {
    const session = workingSession(20, 20_000);
    const { asker, asked } = fakeJev();
    const handlers = load(depsWith(asker));
    expect(await handlers.get("turn_end")!(boundaryOver(session), contextAt(150_000))).toEqual({});
    await handlers.get("agent_before_settle")!(boundaryOver(session, "agent_before_settle"), contextAt(210_000));
    expect(asked.length).toBeGreaterThan(0);
  });
});
