import type { PlaygroundScenarioDefinition } from "@/tests/scenarios/types";
import { z } from "@/index";

export const featureBranchWithChangesSinceMainScenario: PlaygroundScenarioDefinition =
  {
    name: "feature-branch-with-changes-since-main",
    description:
      "Main plus two feature branches with committed differences against main, plus uncommitted added files on the active feature branch.",
  config: {
    org: "jeffsee55",
    repo: "tr33-mono",
    ref: "main",
    currentRef: "feature/update-a",
  },
  pendingFiles: {
      "content/docs/new-uncommitted-1.md":
        "---\ntitle: uncommitted one\nauthor: ../authors/jeff.json\n---\n\n# new one",
      "content/docs/new-uncommitted-2.md":
        "---\ntitle: uncommitted two\nauthor: ../authors/jeff.json\n---\n\n# new two",
      "content/unrelated/new-uncommitted.json":
        "{\"status\":\"added-but-uncommitted\"}",
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
        ref: "main",
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
      await helper.createBranch("feature/add-d");
      await helper.addFilesAndCommit(
        {
          "content/docs/d.md":
            "---\ntitle: hello from d\nauthor: ../authors/jeff.json\n---\n\n# d",
        },
        "Add d",
      );
      await helper.switchBranch("main");
      await helper.createBranch("feature/update-a");
      await helper.addFilesAndCommit(
        {
          "content/docs/a.md":
            "---\ntitle: hello from a updated\nauthor: ../authors/jeff.json\n---\n\n# a updated",
        },
        "Update a",
      );
    },
  };
