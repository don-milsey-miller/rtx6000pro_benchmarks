import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildRunPlan, loadConfiguration } from "../src/config.mjs";
import { buildRunManifest } from "../src/manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("builds a provenance manifest without inventing unavailable runtime values", async () => {
  const configuration = await loadConfiguration(root);
  const run = buildRunPlan(configuration)[0];
  const manifest = await buildRunManifest({ root, run, runRoot: "synthetic-run", piPath: null, piArgs: ["--version"] });
  assert.match(manifest.repository.commit, /^[0-9a-f]{40}$/);
  assert.equal(manifest.repository.baselineCommit, "c76ecd8");
  assert.equal(manifest.seed, 6000);
  assert.equal(manifest.suiteId, configuration.suite.suiteId);
  assert.match(manifest.provenance.taskSpecSha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.provenance.evaluatorSha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.model.revision, configuration.models.models[0].revision);
  assert.equal(manifest.host.imageDigest, null);
  assert.equal(manifest.pi.version, null);
  assert.equal(manifest.budgets.repairAttempts, null);
});
