// A plugin folder whose copilot-api is the fake in this folder.
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function fakePluginDir() {
  const dir = mkdtempSync(join(tmpdir(), "copilot-plugin-"));
  const dist = join(dir, "node_modules", "@jeffreycao", "copilot-api", "dist");
  mkdirSync(dist, { recursive: true });
  copyFileSync(join(import.meta.dirname, "fake-copilot-api.mjs"), join(dist, "main.js"));
  return dir;
}
