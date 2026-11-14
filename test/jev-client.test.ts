import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []));
const source = files(SRC).map((file) => readFileSync(file, "utf8")).join("\n");
const manifest = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8")) as { readonly dependencies?: Readonly<Record<string, string>> };

it("holds no Jev client of its own: it asks with @comchatx/typesafe's askJev, a dependency npm reads, and nothing calls a Jev route", () => {
  expect(source).toMatch(/import \{[^}]*\baskJev\b[^}]*\} from "@comchatx\/typesafe"/);
  expect(source).not.toMatch(/"jev-latest"|systemone|8081|\bfetch\(/);
  expect(manifest.dependencies?.["@comchatx/typesafe"]).toBeDefined();
});
