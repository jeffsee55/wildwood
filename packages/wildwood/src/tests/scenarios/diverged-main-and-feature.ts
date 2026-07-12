import type { PlaygroundScenarioDefinition } from "@/tests/scenarios/types";
import { z } from "@/index";

export const divergedMainAndFeatureScenario: PlaygroundScenarioDefinition = {
  name: "diverged-main-and-feature",
  description: "Main and feature diverge with independent commits on each side.",
  config: {
    org: "jeffsee55",
    repo: "tr33-mono",
    ref: "feature/diverged",
  },
  createConfigInput: ({ org, repo, localPath }) => {
    const page = z.collection({
      name: "page",
      schema: z.markdown({
        title: z.filter(z.string()),
        author: z.lazy(() => z.connect(author)).optional(),
      }),
      match: "content/docs/**/*.md",
    });
    const author = z.collection({
      name: "author",
      schema: z.markdown({
        name: z.filter(z.string()),
      }),
      match: "content/authors/**/*.md",
    });
    return {
      org,
      repo,
      ref: "feature/diverged",
      localPath,
      collections: { page, author },
    };
  },
  apply: async (helper) => {
    const initialFiles = {
      "content/authors/jeff.json": JSON.stringify({ name: "Jeff" }),
      "content/docs/a.md":
        "---\ntitle: hello from a\nauthor: ../authors/jeff.json\n---\n\n# a",
      "content/docs/b.md":
        "---\ntitle: hello from b\nauthor: ../authors/jeff.json\n---\n\n# b",
      "content/unrelated/c.json": "{}",
      "package.json": "{\"name\":\"tr33-mono\"}",
      "README.md": "# README",
    };
    await helper.addFilesAndCommit(initialFiles, "Initial commit");
    await helper.createBranch("feature/diverged");
    await helper.addFilesAndCommit(
      {
        "content/docs/feature-only.md":
          "---\ntitle: Feature Only\n---\n\n# Feature Only",
      },
      "Add feature-only page",
    );
    await helper.switchBranch("main");
    await helper.addFilesAndCommit(
      {
        "content/docs/main-only.md":
          "---\ntitle: Main Only\n---\n\n# Main Only",
      },
      "Add main-only page",
    );
    await helper.switchBranch("feature/diverged");
  },
};
