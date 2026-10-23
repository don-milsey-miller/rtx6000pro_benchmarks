import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfiguration } from "../src/config.mjs";
import { copyTree, manifestDigest, treeManifest, writeJson } from "../src/fs.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { suite } = await loadConfiguration(root);
const manifest = { schemaVersion: 1, suiteId: suite.suiteId, generatedAt: new Date().toISOString(), tasks: [] };
for (const task of suite.tasks) {
  const destination = resolve(root, "dist/bundles", task.id);
  await rm(destination, { recursive: true, force: true });
  await mkdir(resolve(root, "dist/bundles"), { recursive: true });
  await copyTree(resolve(root, task.seedDirectory), destination);
  const files = await treeManifest(destination);
  manifest.tasks.push({ id: task.id, files, sha256: manifestDigest(files) });
}
await writeJson(resolve(root, "dist/bundles/manifest.json"), manifest);
console.log(`built ${manifest.tasks.length} agent bundles`);

