import { runChecks } from "../../evaluators/lib.mjs";

await runChecks([
  ["completed check", async () => {}],
  ["never resolves", async () => new Promise(() => {})],
  ["must remain unverified", async () => { throw new Error("this check must not execute"); }],
], {
  cleanup: async () => {},
  diagnostics: async () => ({
    authorization: "Bearer synthetic-secret",
    activeResources: typeof process.getActiveResourcesInfo === "function" ? process.getActiveResourcesInfo() : [],
  }),
});
