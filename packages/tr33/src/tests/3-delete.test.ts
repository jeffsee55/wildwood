import { afterEach, beforeEach, describe, it } from "vitest";
import { createTestSetup } from "@/tests/setup";

describe("git", () => {
  let t: ReturnType<typeof createTestSetup>;

  beforeEach(async () => {
    t = createTestSetup({ useMemoryDb: true });
    await t.db.reset();
    await t.helper.resetRepo();
  });

  afterEach(async () => {
    await t.helper.cleanup();
  });

  describe("delete", () => {
    it.skip("delete a variant (git.delete not implemented)", async () => {
      await t.git.switch({ ref: "main" });
    });

    it.skip("delete a default variant throw an error when sub-variants exist", async () => {
      await t.git.switch({ ref: "main" });
    });
  });
});
