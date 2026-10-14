# cx-jev-tidy

A [pi](https://pi.dev) package that, when pi's context fills, asks Jev (TypeSafe's scoring model) which old tool calls and outputs still matter and cuts the rest, before pi writes its summary. Every word the user and the model wrote stays.

## What a pass does

pi decides when the context is full: past the context window minus its reserve, for the current model. The package takes over none of that. At pi's two boundaries, `turn_end` and `agent_before_settle`, it runs one pass when the turn completed, compaction is on, pi's own context usage is past pi's own line, and there is a message no pass has seen yet.

For each tool call outside the first message and the newest six, Jev answers two questions — does knowing the call was made still matter, and must its full output stay — and the pass proposes, through pi's `context_edit` entries:

- keep it;
- cut its output to the first 300 characters and a note of what went (`[cx-jev-tidy cut N chars and 1 image of this tool result]`); an output already short is left as it is;
- drop the call with its output.

Text is never edited, and pi's session file keeps every original entry; an edit changes only what the next request carries. A pass that would free under a quarter of the context proposes nothing, and so does every failure, leaving one line on stderr; either way pi's own summary follows, as it would without the package. The package hooks nothing of compaction itself, so a manual compaction and overflow recovery stay pi's.

**What Jev sees**: the user's and the model's text, and each tool call's name and input. A tool output goes only as `ok` or `error` and its length. The model's thinking, the system prompt, skills and summaries are never sent.

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
