import type { PlaygroundScenarioDefinition } from "@/tests/scenarios/types";
import { z } from "@/index";

export const prReadyFeatureBranchScenario: PlaygroundScenarioDefinition = {
  name: "pr-ready-feature-branch",
  description: "Feature branch ahead of main and ready for create-PR workflow tests.",
  config: {
    org: "jeffsee55",
    repo: "tr33-mono",
    ref: "feature/pr-ready",
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
      ref: "feature/pr-ready",
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
    await helper.createBranch("feature/pr-ready");
    await helper.addFilesAndCommit(
      {
        "content/docs/pr-page.md":
          "---\ntitle: PR Page\n---\n\n# PR Page",
      },
      "Add PR page",
    );
    await helper.addFilesAndCommit(
      {
        "content/docs/pr-followup.md":
          "---\ntitle: PR Followup\n---\n\n# PR Followup",
      },
      "Add PR followup page",
    );
  },
};
