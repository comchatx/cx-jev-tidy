import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, ExtensionRunner, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach } from "vitest";

const scratches: string[] = [];
afterEach(() => { for (const scratch of scratches.splice(0)) rmSync(scratch, { recursive: true, force: true }); });

export const scratch = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "pi-package-"));
  scratches.push(directory);
  return directory;
};

/** The pinned pi, its settings listing this package by its root as a local install does, loading what the package declares. */
export async function loadPackage(root: string) {
  const home = scratch();
  const agentDir = join(home, "agent");
  const cwd = join(home, "project");
  for (const directory of [agentDir, cwd]) mkdirSync(directory);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always", packages: [root] }));
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir) });
  await loader.reload();
  const { extensions, runtime, errors } = loader.getExtensions();
  return { extensions, errors, runner: new ExtensionRunner(extensions, runtime, cwd, SessionManager.inMemory(cwd), undefined as never) };
}
