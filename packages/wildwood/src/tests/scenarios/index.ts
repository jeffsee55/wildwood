import { GitHubTestHelper } from "@/tests/_github-test-helper";
import { GitTestHelper } from "@/tests/_git-test-helper";
import { defineConfig } from "@/index";
import { binaryAssetScenario } from "@/tests/scenarios/binary-asset";
import { divergedMainAndFeatureScenario } from "@/tests/scenarios/diverged-main-and-feature";
import { featureBranchWithChangesSinceMainScenario } from "@/tests/scenarios/feature-branch-with-changes-since-main";
import { prReadyFeatureBranchScenario } from "@/tests/scenarios/pr-ready-feature-branch";
import { sameLineEditConflictScenario } from "@/tests/scenarios/same-line-edit-conflict";
import type { PlaygroundScenarioDefinition } from "@/tests/scenarios/types";

export type PlaygroundRemote = "native" | "github";

const scenarios = [
  featureBranchWithChangesSinceMainScenario,
  prReadyFeatureBranchScenario,
  divergedMainAndFeatureScenario,
  sameLineEditConflictScenario,
  binaryAssetScenario,
] as const satisfies readonly PlaygroundScenarioDefinition[];

export type PlaygroundScenarioName = (typeof scenarios)[number]["name"];

export type LoadedPlaygroundScenario = {
  scenario: PlaygroundScenarioName;
  remote: PlaygroundRemote;
  config: ReturnType<typeof defineConfig>;
  pendingFiles?: Record<string, string>;
  metadata: {
    org: string;
    repo: string;
    ref: string;
  };
  cleanup: () => Promise<void>;
};

const scenarioByName = new Map(scenarios.map((scenario) => [scenario.name, scenario]));

export const getPlaygroundScenarioNames = (): PlaygroundScenarioName[] =>
  scenarios.map((scenario) => scenario.name);

export const loadPlaygroundScenario = async (args: {
  scenario: PlaygroundScenarioName;
  remote: PlaygroundRemote;
}): Promise<LoadedPlaygroundScenario> => {
  const scenario = scenarioByName.get(args.scenario);
  if (!scenario) {
    throw new Error(`Unknown scenario "${args.scenario}"`);
  }

  if (args.remote === "native") {
    const helper = new GitTestHelper(`playground-${args.scenario}`);
    await helper.resetRepo();
    await scenario.apply(helper);
    const org = scenario.config.org;
    const repo = scenario.config.repo;
    const ref = scenario.config.currentRef ?? scenario.config.ref;
    return {
      scenario: args.scenario,
      remote: "native",
      config: defineConfig(
        scenario.createConfigInput({
          org,
          repo,
          localPath: helper.getFullPath(),
        }),
      ),
      pendingFiles: scenario.pendingFiles,
      metadata: { org, repo, ref },
      cleanup: () => helper.cleanup(),
    };
  }

  const helper = new GitHubTestHelper(`tr33-playground-${args.scenario}`);
  await helper.createRepo();
  await scenario.apply(helper);
  const org = helper.getOwner();
  const repo = helper.getRepoName();
  const ref = scenario.config.currentRef ?? scenario.config.ref;
  return {
    scenario: args.scenario,
    remote: "github",
    config: defineConfig(
      scenario.createConfigInput({
        org,
        repo,
      }),
    ),
    pendingFiles: scenario.pendingFiles,
    metadata: { org, repo, ref },
    cleanup: () => helper.cleanup(),
  };
};

export const parsePlaygroundScenarioArgs = (argv: string[]): {
  remote: PlaygroundRemote;
  scenario: PlaygroundScenarioName;
} => {
  const keyValues = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const part = argv[i];
    if (!part.startsWith("--")) continue;
    const [key, value] = part.includes("=")
      ? part.slice(2).split("=", 2)
      : [part.slice(2), argv[i + 1]];
    if (key && value && !value.startsWith("--")) {
      keyValues.set(key, value);
      if (!part.includes("=")) i++;
    }
  }

  const remoteArg = keyValues.get("remote");
  if (remoteArg !== "native" && remoteArg !== "github") {
    const names = getPlaygroundScenarioNames().join(", ");
    throw new Error(
      `Missing required --remote argument ("native" or "github").\n` +
        `Example: pnpm playground --remote=native --scenario=feature-branch-with-changes-since-main\n` +
        `Available scenarios: ${names}`,
    );
  }

  const scenarioArg =
    keyValues.get("scenario") || "feature-branch-with-changes-since-main";
  const scenarioNames = getPlaygroundScenarioNames();
  if (!scenarioNames.includes(scenarioArg as PlaygroundScenarioName)) {
    throw new Error(
      `Unknown --scenario "${scenarioArg}". Available scenarios: ${scenarioNames.join(", ")}`,
    );
  }

  return {
    remote: remoteArg,
    scenario: scenarioArg as PlaygroundScenarioName,
  };
};
