/**
 * Whether a tool call bought from a supplier, read only where it is certain: by the receipt `cx` prints, the one truth source.
 * The receipt's grammar is the one `cx` renders (ComChatX's `src/cx/receipt.ts`): one line per path, `-> <file>` last on a line whose
 * answer landed, the money on a closing `cost:` line; or, with `--json`, one object whose `paths` each name a `file`.
 */

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
