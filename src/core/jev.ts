// Ported from tamaratran/fast-jev-compaction at e3f262a7 (MIT); the notice is in the package's THIRD_PARTY_NOTICES.md.
import type { AnswerFailure, Question } from "@comchatx/typesafe";

/** The `state` of a Jev request: any JSON-serialisable object. */
export type JevState = object;
/** A yes-or-no question with no criteria: pi's TypeSafe route sends it to Jev as `noul` with its instructions alone. */
export type JevQuestion = Omit<Question, "criteria">;
export type JevQuestions = Readonly<Record<string, JevQuestion>>;

/** Anything that can answer Jev questions with a probability each: Jev's client in `@comchatx/typesafe`, or a test's fake. */
export type JevAsker = { ask(state: JevState, questions: JevQuestions): Promise<Readonly<Record<string, number>>> };

/** Why a pass asked nothing or got no answer: the client's kinds, and a history too large to leave room for one question. */
export class JevError extends Error {
  constructor(readonly kind: AnswerFailure | "oversize", message: string) {
    super(message);
  }
}

