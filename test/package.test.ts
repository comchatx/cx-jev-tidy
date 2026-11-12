import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { build } from "../scripts/build.mjs";
import { loadPackage, scratch } from "./pi.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

it("the pinned pi loads the extension from the built dist/, hooking the two boundaries and nothing of compaction", async () => {
  expect(build(ROOT)).toEqual([join(ROOT, "dist", "extensions", "jev-tidy.js")]);
  const { extensions, errors } = await loadPackage(ROOT);
  expect(errors).toEqual([]);
  expect(extensions.map((extension) => extension.path)).toEqual([join(ROOT, "dist", "extensions", "jev-tidy.js")]);
  expect(extensions.map((extension) => [...extension.handlers.keys()].sort())).toEqual([["agent_before_settle", "turn_end"]]);
});

it("the comchatx field is the card the product's catalogue record draws, Jev in builds with its reason", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { readonly comchatx: unknown };
  expect(manifest.comchatx).toEqual({"name":"Jev Cleanup","about":"让 cx 清掉长对话里用不上的步骤结果，说过的话一字不删。","mark":{"line":"chat"},"section":"extensions","order":70,"builds":[{"on":"jev","why":{"en":"Judges which step results are no longer needed.","zh":"判断哪些步骤结果已经用不上。"}}]});
  const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: ROOT, encoding: "utf8" })) as { files: { path: string }[] }[];
  expect(packed[0]!.files.map((file) => file.path)).toContain("package.json");
});

it("the build refuses a test under src/extensions/, which pi would load as an extension", () => {
  const root = scratch();
  mkdirSync(join(root, "src", "extensions"), { recursive: true });
  writeFileSync(join(root, "src", "extensions", "jev-tidy.ts"), "export default () => {};\n");
  writeFileSync(join(root, "src", "extensions", "jev-tidy.test.ts"), "export {};\n");
  expect(() => build(root)).toThrow("src/extensions/jev-tidy.test.ts is not an extension; tests live under test/");
});
