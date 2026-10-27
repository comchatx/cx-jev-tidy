# cx-jev-tidy

A [pi](https://pi.dev) package that, when pi's context fills, asks Jev (TypeSafe's scoring model) which old tool calls and outputs still matter and cuts the rest, before pi writes its summary. Every word the user and the model wrote stays.

## What a pass does

pi decides when the context is full: past the context window minus its reserve, for the current model. The package takes over none of that. At pi's two boundaries, `turn_end` and `agent_before_settle`, it runs one pass when the turn completed, compaction is on, pi's own context usage is past pi's own line, and there is a message no pass has seen yet.

For each tool call outside the first message and pi's recent window, Jev answers two questions — does knowing the call was made still matter, and must its full output stay — and the pass proposes, through pi's `context_edit` entries:

- keep it;
- cut its output to the first 300 characters and a note of what went (`[cx-jev-tidy cut N chars and 1 image of this tool result]`); an output already short is left as it is;
- drop the call with its output, leaving one line where the call stood, so the model reads that the command ran and that its result is gone: `[cx-jev-tidy dropped this bash call and its result: <the input's first line>]`.

**The recent window** is what the pinned pi's own projected cut point (its `findProjectedCutPoint`, mirrored over pi's exports, each entry counted as the model sees it: an omitted or shortened custom message, a superseded compaction) keeps for `compaction.keepRecentTokens` of the model in use, its `modelOverrides` entry included, read through pi's settings, over the conversation as the model sees it now. Nothing in it is a candidate.

**What was bought stays where it can be read.** A call to `cx` fetched from a supplier through the ComChatX gate, and the seller paid for it; a fetch is not repeated, while a file on disk can be read again, and Jev's standing note says both. A call is read as paid where its output is `cx`'s receipt. A paid call is never dropped. Its output is read by the receipt's own grammar (one line per path ending `-> <file>` where its answer landed, closed by a `cost:` line; or `--json`'s `paths`, each with its `file`; an outcome word `cx` does not know still makes a path line, read without certainty): only where every answer landed may the pass cut it to the head and a note naming those files (`…; what it fetched is on disk at /tenant/…]`); anything else stays whole, and Jev is not asked about it. A paid call whose receipt the reader cannot see, cut by a pipe or hidden behind a script that prints something else, is read like any other call: the receipt is what protects it.

**A pass removes at most half of the context it found**, the oldest of what Jev would let go first; the rest stays as it was. A pass needs a quarter to stand and runs again at the next line, so half is room enough; past it, one pass could leave the model a conversation whose working past is gone, which pi's own summary, written from the whole, would not.

**A pass leaves a record where it ran.** After its edits it writes one `custom` entry, `customType: "cx-jev-tidy"`, into the session, with the context's tokens before and after the pass, how many outputs it cut and calls it dropped, and what the stubs cost (`stubTokens`, already counted in `after`); pi stamps the entry's time. The model never sees it; a page that reads the session can draw it.

Text is never edited, and pi's session file keeps every original entry; an edit changes only what the next request carries. A pass that would free under a quarter of the context proposes nothing and records nothing, and so does every failure, leaving one line on stderr; either way pi's own summary follows, as it would without the package. The package hooks nothing of compaction itself, so a manual compaction and overflow recovery stay pi's.

**What Jev sees**: the user's and the model's text, and each tool call's name and input. A tool output goes only as `ok` or `error` and its length. The model's thinking, the system prompt, skills and summaries are never sent.

**Jev is asked at one address only.** The request is never sent on where a redirect points: a redirect is a failure, and the pass proposes nothing.

## What it needs

A [ComChatX](https://comchatx.com) box. The package reaches Jev only through the box's loopback proxy (`http://127.0.0.1:8081/providers/typesafe/v1/systemone`), which adds the box's credentials and the key: the seller's own TypeSafe key where they saved one, else the platform's, priced like any model. The package holds no key and reads no setting of its own.

Outside a ComChatX box nothing listens at that address: every pass fails, proposes nothing, and pi's own summary runs, as if the package were not installed.

## Install

```bash
pi install -l npm:cx-jev-tidy
pi remove -l npm:cx-jev-tidy
```

On ComChatX, a seller installs it from the Plugins page.

## Develop

```bash
npm ci
npm run typecheck
npm test               # builds dist/ and loads it with the pinned pi
```

The extension is `src/extensions/jev-tidy.ts` and the decision core it runs is `src/core/`. `npm run build` bundles each file in `src/extensions/` into `dist/extensions/`, the directory the package's `pi` manifest names, leaving pi's own packages for pi to supply. Tests live under `test/`: pi loads every module in an extensions directory, so the build refuses anything there that is not an extension.

## Licence

MIT. See [LICENSE](LICENSE). `src/core/` is ported from [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) under its MIT licence; the notice is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and ships with the package.
