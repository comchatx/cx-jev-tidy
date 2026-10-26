import { estimateTokens, SettingsManager, type ExtensionAPI, type ContextEditEntryDraft } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { JevError, type JevAsker, type JevQuestions, type JevState } from "../src/core/jev.js";
import { assistant, boundaryOver, contextAt, output, result, shell, user, workingSession } from "./conversation.js";
import { HEAD_CHARS, jevTidy, MAX_FREED, MIN_FREED, PASS_ENTRY, tidy, type Deps, type PassRecord } from "../src/extensions/jev-tidy.js";

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

const edits = (entries: readonly unknown[] | undefined): ContextEditEntryDraft[] => ((entries ?? []) as ContextEditEntryDraft[]).filter((entry) => entry.type === "context_edit");
/** A window of a few tokens: the fillers after a small session's calls hold it, and the calls stand outside it. */
const NARROW = { ...LINE_SETTINGS, keepRecentTokens: 10 };

describe("one Jev pass at a boundary past the line", () => {
  it("proposes context_edit entries and its record: a dropped result keeps its head and a note, a dropped call leaves a stub where it stood, and text stays", async () => {
    const session = workingSession(20, 20_000);
    const { asker, asked } = fakeJev();
    const deps = depsWith(asker);
    const out = await tidy(boundaryOver(session), contextAt(210_000), deps);
    expect(out?.continue).toBeUndefined();
    const proposed = edits(out?.entries);
    expect(proposed.length).toBeGreaterThan(0);
    expect(out!.entries!.slice(0, -1)).toEqual(proposed);
    expect(out!.entries!.at(-1)).toMatchObject({ type: "custom", customType: PASS_ENTRY });
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
        expect(edit.replacement, "an assistant message keeps its text and the stub").not.toBeNull();
        const content = edit.replacement!.content as { type: string; text?: string }[];
        expect(content).toEqual(target.content.map((block) => (block.type === "toolCall" ? { type: "text", text: `[cx-jev-tidy dropped this read call and its result: ${JSON.stringify(block.arguments)}]` } : block)));
      }
    }

    // The first message and pi's recent window are pinned: nothing touches round 20's call and result, or the first request.
    const branch = session.getBranch();
    const pinned = [branch[0]!, ...branch.slice(-4)].map((entry) => entry.id);
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
    const proposed = edits((await tidy(boundaryOver(session), contextAt(4_000, 100_000), depsWith(asker, NARROW)))?.entries);
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
    const proposed = edits((await tidy(boundaryOver(session), contextAt(4_000, 100_000), depsWith(asker, NARROW)))?.entries);
    expect(proposed.length).toBeGreaterThan(0);
    for (const edit of proposed) session.appendContextEdit(edit.targetId, edit.replacement);
    const after = session.buildSessionProjection().messages;
    const results = after.filter((message) => message.role === "toolResult");
    expect(results.map((message) => (message.content[0] as { text: string }).text.slice(0, 1))).toEqual(["B"]);
    const at = after.indexOf(results[0]!);
    const before = after[at - 1]!;
    expect(before.role === "assistant" && before.content.some((block) => block.type === "toolCall" && block.id === "dup" && (block.arguments as { path: string }).path === "b")).toBe(true);
  });

  it("leaves a dropped result already short enough as it is, and leaves the stub alone where a dropped call was all its entry held", async () => {
    const session = workingSession(0, 0);
    session.appendMessage(assistant("", [{ id: "short", path: "a" }]));
    session.appendMessage(result("short", "tiny"));
    session.appendMessage(assistant("", [{ id: "long", path: "b" }]));
    session.appendMessage(result("long", "x".repeat(50_000)));
    for (let i = 0; i < 6; i += 1) session.appendMessage(user(`filler ${i}`));
    const { asker } = fakeJev((q) => (q === "call_t1" ? 0.9 : 0.1));
    // A small model, past its line, where the one long result is well over a quarter of the context and under half.
    const proposed = edits((await tidy(boundaryOver(session), contextAt(30_000, 100_000), depsWith(asker, NARROW)))?.entries);
    const branch = session.getBranch();
    // t1 keeps its call and loses its result, which is too short to cut; t2 goes, and its assistant entry is left the stub.
    expect(proposed).toEqual([
      { type: "context_edit", targetId: branch[4]!.id, replacement: null },
      { type: "context_edit", targetId: branch[3]!.id, replacement: { content: [{ type: "text", text: '[cx-jev-tidy dropped this read call and its result: {"path":"b"}]' }] } },
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

describe("what a pass keeps, and the trace it leaves", () => {
  const ASINS = ["B0A1", "B0A2", "B0A3", "B0A4", "B0A5", "B0A6"];
  const LANDED = ASINS.map((asin) => `/tenant/amazon/us/${asin}/product.json`);
  // cx's receipt: one line per path, the file it landed at last.
  const RECEIPT = ASINS.map((asin, n) => `amazon/us/${asin}/product  bought  Keepa  14 tokens  as of 2026-10-26 10:00  -> ${LANDED[n]}`).join("\n");
  const RAW = JSON.stringify({ lines: [{ path: "keepa /product", outcome: "settled", bytes: 81_920, file: "/tenant/raw/keepa/r-7.json", channel: "platform", meter: "tokens" }], effective: { max_age: "1h" }, note: "n".repeat(400) });
  const NOT_LANDED = `amazon/us/B9/product  bought  Keepa  14 tokens  settled, not landed: the copy did not arrive\n${"the supplier's words ".repeat(30)}`;
  function paidSession() {
    const session = workingSession(0, 0);
    session.appendMessage(shell("get", `cx get ${ASINS.map((asin) => `amazon/us/${asin}/product`).join(" ")}`));
    session.appendMessage(output("get", RECEIPT));
    session.appendMessage(shell("raw", "cd /tenant && cx raw keepa --origin https://api.keepa.com --json"));
    session.appendMessage(output("raw", RAW));
    session.appendMessage(shell("lost", "cx get amazon/us/B9/product"));
    session.appendMessage(output("lost", NOT_LANDED));
    session.appendMessage(shell("ls", "ls -la /tenant\necho done"));
    session.appendMessage(output("ls", "x".repeat(40_000)));
    for (let i = 0; i < 6; i += 1) session.appendMessage(user(`filler ${i}`));
    return session;
  }
  const textOf = (replacement: ContextEditEntryDraft["replacement"]): string => (replacement!.content as { text: string }[])[0]!.text;

  it("cuts a paid result to its head and a note naming where it lies on disk, keeps one that names no file whole and unasked, and leaves a stub where a free call was dropped", async () => {
    const session = paidSession();
    const branch = session.getBranch();
    const { asker, asked } = fakeJev(() => 0.1);
    const out = await tidy(boundaryOver(session), contextAt(30_000, 100_000), depsWith(asker, NARROW));
    // Jev is asked about the two paid calls that name their files and the free one; the one whose answer landed nowhere is not a candidate.
    expect(asked.flatMap(({ questions }) => Object.keys(questions)).sort()).toEqual(["call_t1", "call_t2", "call_t4", "result_t1", "result_t2", "result_t4"]);
    const proposed = edits(out?.entries);
    const at = (index: number) => proposed.find((edit) => edit.targetId === branch[index]!.id);
    expect(textOf(at(2)!.replacement)).toBe(`${RECEIPT.slice(0, HEAD_CHARS)}\n[cx-jev-tidy cut ${RECEIPT.length - HEAD_CHARS} chars of this tool result; what it fetched is on disk at ${LANDED.join(", ")}]`);
    expect(textOf(at(4)!.replacement)).toMatch(/\[cx-jev-tidy cut \d+ chars of this tool result; what it fetched is on disk at \/tenant\/raw\/keepa\/r-7\.json\]$/);
    // A paid call is never dropped, and a paid answer that landed nowhere is not touched.
    expect([at(1), at(3), at(5), at(6)]).toEqual([undefined, undefined, undefined, undefined]);
    expect(at(8)).toEqual({ type: "context_edit", targetId: branch[8]!.id, replacement: null });
    expect(at(7)).toEqual({ type: "context_edit", targetId: branch[7]!.id, replacement: { content: [{ type: "text", text: "[cx-jev-tidy dropped this bash call and its result: ls -la /tenant]" }] } });

    // Applied through pi: the paid calls stand with their results, and the model reads that the dropped command ran.
    for (const edit of proposed) session.appendContextEdit(edit.targetId, edit.replacement);
    const after = session.buildSessionProjection().messages;
    const calls = after.flatMap((message) => (message.role === "assistant" ? message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])) : []));
    expect(calls).toEqual(["get", "raw", "lost"]);
    expect(after.filter((message) => message.role === "toolResult").map((message) => message.toolCallId)).toEqual(["get", "raw", "lost"]);
    expect(JSON.stringify(after)).toContain(NOT_LANDED.slice(-40));
  });

  it("records the pass where it ran, after its edits: the context before and after, what it cut and dropped, and what the stubs cost", async () => {
    const out = await tidy(boundaryOver(paidSession()), contextAt(30_000, 100_000), depsWith(fakeJev(() => 0.1).asker, NARROW));
    const record = out!.entries!.at(-1) as { type: string; customType: string; data: PassRecord };
    expect([record.type, record.customType, record.data.before, record.data.cut, record.data.dropped]).toEqual(["custom", PASS_ENTRY, 30_000, 2, 1]);
    expect(record.data.stubTokens).toBeGreaterThan(0);
    expect(record.data.after).toBeLessThan(record.data.before * (1 - MIN_FREED));
    expect(record.data.after).toBeGreaterThanOrEqual(record.data.before * (1 - MAX_FREED));
    // A pass that proposes nothing records nothing.
    expect(await tidy(boundaryOver(paidSession()), contextAt(30_000, 100_000), depsWith(fakeJev(() => 0.9).asker, NARROW))).toEqual({});
  });

  it("holds pi's recent window for the model in use, its own override included, and proposes nothing inside it", async () => {
    const session = workingSession(20, 20_000);
    const settings = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 900_000, keepRecentTokens: 20_000, modelOverrides: { "fake/fake-1m": { keepRecentTokens: 60_000 } } } });
    const deps: Deps = { asker: fakeJev(() => 0.1).asker, settings: (ctx) => settings.getCompactionSettings(ctx.model), log: () => {} };
    const proposed = edits((await tidy(boundaryOver(session), contextAt(120_000), deps))?.entries);
    expect(proposed.length).toBeGreaterThan(0);
    const branch = session.getBranch();
    // The window as pi counts it: back from the newest message until 60,000 tokens are reached.
    let kept = 0;
    let from = branch.length;
    while (kept < 60_000) { from -= 1; const entry = branch[from]!; kept += entry.type === "message" ? estimateTokens(entry.message) : 0; }
    const touched = proposed.map((edit) => branch.findIndex((entry) => entry.id === edit.targetId));
    expect(Math.max(...touched)).toBeLessThan(from);
    // Six messages back would have reached round 19; the override's window starts rounds before it, and the pass works up to its edge.
    expect(from).toBeLessThan(branch.length - 6 * 4);
    expect(Math.max(...touched)).toBeGreaterThan(from - 8);
  });

  it("removes at most half of the context it found, the oldest first, whatever Jev would let go", async () => {
    const session = workingSession(20, 20_000);
    const deps = depsWith(fakeJev(() => 0.1).asker, { ...LINE_SETTINGS, reserveTokens: 900_000 });
    const out = await tidy(boundaryOver(session), contextAt(120_000), deps);
    const record = (out!.entries!.at(-1) as { data: PassRecord }).data;
    expect(record.before - record.after).toBeLessThanOrEqual(MAX_FREED * 120_000);
    expect(record.before - record.after).toBeGreaterThan((MAX_FREED - 0.05) * 120_000);
    // Rounds 1 on go, in order; the rest Jev would also let go stay as they were.
    const branch = session.getBranch();
    const rounds = [...new Set(edits(out?.entries).map((edit) => Math.ceil(branch.findIndex((entry) => entry.id === edit.targetId) / 4)))].sort((a, b) => a - b);
    expect(rounds).toEqual(Array.from({ length: rounds.length }, (_, n) => n + 1));
    expect(rounds.length).toBeLessThan(15);
  });
});
