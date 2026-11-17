// bb's provider bridge conformance suite against this plugin's provider; see
// fixtures/conformance-run.mjs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const runner = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "conformance-run.mjs");

test("the provider passes bb's bridge conformance suite", { timeout: 120_000 }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-conformance-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reportFile = join(dir, "report.json");
  execFileSync(process.execPath, [runner, dir, reportFile], {
    env: { ...process.env, XDG_STATE_HOME: join(dir, "state") },
    stdio: ["ignore", "ignore", "inherit"],
    timeout: 110_000,
  });
  const { report, text } = JSON.parse(readFileSync(reportFile, "utf8"));
  assert.deepEqual(report.results.filter((result) => result.status === "fail").map((result) => result.id), [], text);
  assert.equal(report.passed, true, text);
});
