import { createClient as libsqlCreateClient } from "@libsql/client";
import { url } from "./drizzle.sqlite";
import { createClient } from "./src/client/index";
import { createHandler } from "./src/nextjs/index";
import {
  loadPlaygroundScenario,
  type PlaygroundRemote,
  type PlaygroundScenarioName,
} from "./src/tests/scenarios/index";

// Use latest VS Code web build to avoid protocol mismatches between
// workbench and extension host internals.
const vscodeWebVersion = "latest";
process.env.WILDWOOD_VSCODE_WEB_VERSION = vscodeWebVersion;

const libsqlClient = libsqlCreateClient({
  // url: ":memory:",
  url,
});

const remote: PlaygroundRemote = "native";
const scenarioName: PlaygroundScenarioName = "pr-ready-feature-branch";
const scenario = await loadPlaygroundScenario({
  remote,
  scenario: scenarioName,
});
const client = createClient({
  config: scenario.config,
  database: libsqlClient,
});

await client._.db.reset();
if (scenario.pendingFiles && Object.keys(scenario.pendingFiles).length > 0) {
  await client._.git.add({
    ref: scenario.metadata.ref,
    files: scenario.pendingFiles,
  });
}
console.log({
  playgroundScenario: scenario.scenario,
  remote: scenario.remote,
  vscodeWebVersion,
  repo: `${scenario.metadata.org}/${scenario.metadata.repo}`,
  ref: scenario.metadata.ref,
  githubRepoUrl: `https://github.com/${scenario.metadata.org}/${scenario.metadata.repo}`,
  githubBranchUrl: `https://github.com/${scenario.metadata.org}/${scenario.metadata.repo}/tree/${encodeURIComponent(scenario.metadata.ref)}`,
});

let cleanedUp = false;
const cleanup = async () => {
  if (cleanedUp) return;
  cleanedUp = true;
  await scenario.cleanup();
};

for (const signal of ["SIGINT", "SIGTERM", "SIGQUIT"] as const) {
  process.once(signal, () => {
    void (async () => {
      await cleanup();
      process.exit(0);
    })();
  });
}

process.once("beforeExit", () => {
  void cleanup();
});

process.once("uncaughtException", (error) => {
  console.error("Uncaught exception in playground:", error);
  void (async () => {
    await cleanup();
    process.exit(1);
  })();
});

process.once("unhandledRejection", (reason) => {
  console.error("Unhandled rejection in playground:", reason);
  void (async () => {
    await cleanup();
    process.exit(1);
  })();
});

export default createHandler(client, {
  currentRef: scenario.metadata.ref,
});
