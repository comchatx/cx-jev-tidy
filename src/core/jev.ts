// Ported from tamaratran/fast-jev-compaction at e3f262a7 (MIT); the notice is in the package's THIRD_PARTY_NOTICES.md.

/** The `state` of a Jev request: any JSON-serialisable object. */
export type JevState = object;
export type NoulQuestion = { readonly type: "noul"; readonly instructions: string };
export type JevQuestions = Readonly<Record<string, NoulQuestion>>;
export type JevResponse = { readonly answers: Readonly<Record<string, unknown>> };

/** Anything that can answer Jev questions: the proxy route, or a test's fake. */
export type JevAsker = { ask(state: JevState, questions: JevQuestions): Promise<JevResponse> };

export const JEV_MODEL = "jev-latest";

export class JevError extends Error {
  constructor(readonly kind: "refused" | "timeout" | "malformed" | "oversize", message: string) {
    super(message);
  }
}

export const jevBody = (state: JevState, questions: JevQuestions): string => JSON.stringify({ model: JEV_MODEL, state, questions });

/** Validates a Jev response body; throws on anything but an `answers` object. The body itself is never echoed. */
export function parseJevResponse(status: number, text: string): JevResponse {
  if (status < 200 || status >= 300) throw new JevError("refused", `Jev request refused (${status})`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JevError("malformed", "Jev returned malformed JSON");
  }
  if (parsed === null || typeof parsed !== "object" || !("answers" in parsed) || parsed.answers === null || typeof parsed.answers !== "object") {
    throw new JevError("malformed", "Jev response is missing answers");
  }
  return parsed as JevResponse;
}

/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(answers: Readonly<Record<string, unknown>>, name: string): number {
  const answer = answers[name];
  const noul = typeof answer === "object" && answer !== null && "noul" in answer ? answer.noul : undefined;
  if (typeof noul !== "number" || !Number.isFinite(noul)) throw new JevError("malformed", `Invalid Jev answer for ${name}`);
  return noul;
}

/** Asks Jev over HTTP at `url`, bounded by `timeoutMs`; the caller's key header is its own. */
export const httpAsker = (url: string, headers: Readonly<Record<string, string>>, timeoutMs: number): JevAsker => ({
  async ask(state, questions) {
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: jevBody(state, questions), signal: AbortSignal.timeout(timeoutMs) });
      return parseJevResponse(response.status, await response.text());
    } catch (error) {
      if (error instanceof JevError) throw error;
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw new JevError("timeout", `Jev did not answer within ${timeoutMs} ms`);
      throw new JevError("refused", "Jev could not be reached");
    }
  },
});
