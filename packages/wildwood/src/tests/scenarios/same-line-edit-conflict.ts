import type { PlaygroundScenarioDefinition } from "@/tests/scenarios/types";
import { z } from "@/index";

const BASE_LINE = "The only line in the file.";
const FEATURE_LINE = "Edited on feature branch.";
const MAIN_LINE = "Edited on main.";
const UNCOMMITTED_LINE = "Uncommitted edit on same line.";

export const sameLineEditConflictScenario: PlaygroundScenarioDefinition = {
  name: "same-line-edit-conflict",
  description:
    "One file, one line. Main and feature each edit that line in separate commits sharing the same merge base. Merging produces a content conflict.",
  config: {
    org: "jeffsee55",
    repo: "tr33-mono",
    ref: "main",
    currentRef: "feature/conflict",
  },
  pendingFiles: {
    "content/docs/conflict.md":
      "---\ntitle: Conflict demo\nauthor: ../authors/jeff.json\n---\n\n" +
      UNCOMMITTED_LINE,
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
      "content/docs/conflict.md":
        `---\ntitle: Conflict demo\nauthor: ../authors/jeff.json\n---\n\n${BASE_LINE}`,
      "package.json": "{\"name\":\"tr33-mono\"}",
      "README.md": "# README",
    };
    await helper.addFilesAndCommit(initialFiles, "Initial commit");
    await helper.createBranch("feature/conflict");
    await helper.addFilesAndCommit(
      {
        "content/docs/conflict.md":
          `---\ntitle: Conflict demo\nauthor: ../authors/jeff.json\n---\n\n${FEATURE_LINE}`,
      },
      "Edit line on feature",
    );
    await helper.switchBranch("main");
    await helper.addFilesAndCommit(
      {
        "content/docs/conflict.md":
          `---\ntitle: Conflict demo\nauthor: ../authors/jeff.json\n---\n\n${MAIN_LINE}`,
      },
      "Edit same line on main",
    );
    await helper.switchBranch("feature/conflict");
  },
};
