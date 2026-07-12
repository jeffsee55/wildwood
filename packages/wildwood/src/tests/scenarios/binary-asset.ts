import type { PlaygroundScenarioDefinition } from "@/tests/scenarios/types";
import { z } from "@/index";

// 1x1 red PNG (68 bytes)
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

export const binaryAssetScenario: PlaygroundScenarioDefinition = {
  name: "binary-asset",
  description:
    "A branch with both tracked markdown/json content and an untracked binary image file (PNG). Verifies that binary assets survive the add/commit/push pipeline.",
  config: {
    org: "jeffsee55",
    repo: "tr33-mono",
    ref: "main",
    currentRef: "feature/assets",
  },
  createConfigInput: ({ org, repo, localPath }) => {
    const page = z.collection({
      name: "page",
      schema: z.markdown({
        title: z.filter(z.string()),
      }),
      match: "content/docs/**/*.md",
    });
    const author = z.collection({
      name: "author",
      schema: z.json({
        name: z.filter(z.string()),
      }),
      match: "content/authors/**/*.json",
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
    await helper.addFilesAndCommit(
      {
        "content/authors/jeff.json": JSON.stringify({ name: "Jeff" }),
        "content/docs/hello.md":
          "---\ntitle: Hello\n---\n\n# Hello\n\nWelcome.",
        "package.json": '{"name":"tr33-mono"}',
        "README.md": "# README",
      },
      "Initial commit",
    );
    await helper.createBranch("feature/assets");
    await helper.addFilesAndCommit(
      {
        "content/docs/hello.md":
          "---\ntitle: Hello\n---\n\n# Hello\n\nWelcome. Updated with an image below.",
        "assets/logo.png": PNG_BYTES,
      },
      "Add logo asset and update doc",
    );
    if (helper.createPr) {
      await helper.createPr("feature/assets", "main");
    }

    // Another branch with an existing PR for testing Pull from remote.
    await helper.switchBranch("main");
    await helper.createBranch("feature/review");
    await helper.addFilesAndCommit(
      {
        "content/docs/review.md":
          "---\ntitle: Review Notes\n---\n\n# Review Notes\n\nDocs for review workflow.",
      },
      "Add review notes",
    );
    if (helper.createPr) {
      await helper.createPr("feature/review", "main");
    }
  },
};
