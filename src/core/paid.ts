/**
 * Whether a tool call bought from a supplier, read only where it is certain: the shell words of its command, and the receipt `cx` prints.
 * The receipt's grammar is the one `cx` renders (ComChatX's `src/cx/receipt.ts`): one line per path, `-> <file>` last on a line whose
 * answer landed, the money on a closing `cost:` line; or, with `--json`, one object whose `paths` each name a `file`.
 */

const SEPARATORS = new Set([";", "&", "|", "(", ")", "`", "<", ">", "\n"]);
const NESTED = /[\s;&|`]|\$\(/;
const DEPTH = 4;

/**
 * The words a shell would see in `command`, quotes removed and line continuations joined; a word that itself holds a command — a
 * `bash -lc '…'` string, a quoted `$(…)` — is read for its words too.
 */
export function shellWords(command: string, depth = 0): readonly string[] {
  const words: string[] = [];
  let word: string | undefined;
  const end = (): void => { if (word !== undefined) words.push(word); word = undefined; };
  for (let at = 0; at < command.length; at += 1) {
    const char = command[at]!;
    if (char === "\\") {
      const next = command[at + 1];
      at += 1;
      if (next === undefined || next === "\n") continue;
      word = (word ?? "") + next;
    } else if (char === "'") {
      const close = command.indexOf("'", at + 1);
      word = (word ?? "") + command.slice(at + 1, close === -1 ? command.length : close);
      at = close === -1 ? command.length : close;
    } else if (char === '"') {
      let text = "";
      for (at += 1; at < command.length && command[at] !== '"'; at += 1) {
        if (command[at] === "\\" && at + 1 < command.length && '"\\$`\n'.includes(command[at + 1]!)) {
          at += 1;
          if (command[at] !== "\n") text += command[at];
        } else text += command[at];
      }
      word = (word ?? "") + text;
    } else if (char === " " || char === "\t") end();
    else if (SEPARATORS.has(char)) end();
    else word = (word ?? "") + char;
  }
  end();
  return depth >= DEPTH ? words : words.flatMap((one) => (NESTED.test(one) ? [one, ...shellWords(one, depth + 1)] : [one]));
}

/** A command that runs `cx` in any visible spelling: a word whose last path segment is `cx`. */
export const runsCx = (command: string): boolean => shellWords(command).some((one) => one.replace(/\/+$/, "").split("/").at(-1) === "cx");

/** What a receipt says of its answers: the files they landed at, or none where any answer did not land or a line cannot be read. */
export type ReceiptRead = { readonly landed: readonly string[] };

const LANDED_WORDS = /^(?:fresh|cached|stale_served)(?: \(.*\))?$/;
const OUTCOME_WORDS = /^(?:fresh|cached|stale_served|priced|failed|not_landed|sent, outcome unknown)(?: \(.*\))?$/;
const LANDED_KINDS = new Set(["fresh", "cached", "stale_served"]);
const FACT_LINE = /^(?:channel|meter|header): /;

function readJson(text: string): ReceiptRead | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("served_from_tree" in parsed) || !("paths" in parsed) || !Array.isArray(parsed.paths)) return undefined;
  const files = parsed.paths.map((line: unknown) => {
    if (typeof line !== "object" || line === null) return undefined;
    const { outcome, file } = line as { outcome?: unknown; file?: unknown };
    const kind = typeof outcome === "object" && outcome !== null ? (outcome as { kind?: unknown }).kind : undefined;
    return typeof kind === "string" && LANDED_KINDS.has(kind) && typeof file === "string" && file.startsWith("/") ? file : undefined;
  });
  return { landed: files.length > 0 && files.every((file) => file !== undefined) ? [...new Set(files as string[])] : [] };
}

/** A text receipt: some line in the path grammar and the closing `cost:` line. A line it cannot read, the supplier's words among them, leaves no path. */
function readText(text: string): ReceiptRead | undefined {
  const lines = text.replace(/\n+$/, "").split("\n");
  if (lines.length < 2 || !lines.at(-1)!.startsWith("cost: ")) return undefined;
  const files: (string | undefined)[] = [];
  let certain = true;
  for (const line of lines.slice(0, -1)) {
    if (FACT_LINE.test(line)) continue;
    const fields = line.split("  ");
    if (fields.length < 2 || fields[0]!.length === 0 || !/^\S/.test(fields[1]!)) { certain = false; continue; }
    // cx prints an outcome word it does not know as it came: the line is still a path line, read without certainty.
    if (!OUTCOME_WORDS.test(fields[1]!)) { files.push(undefined); continue; }
    const arrow = line.lastIndexOf("  -> ");
    files.push(LANDED_WORDS.test(fields[1]!) && arrow !== -1 && line[arrow + 5] === "/" ? line.slice(arrow + 5) : undefined);
  }
  if (files.length === 0) return undefined;
  return { landed: certain && files.every((file) => file !== undefined) ? [...new Set(files as string[])] : [] };
}

/** The receipt in a tool's output, read whole by its grammar; undefined where the output is not a receipt. */
export const readReceipt = (text: string): ReceiptRead | undefined => readJson(text.trim()) ?? readText(text);
