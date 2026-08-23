import { describe, expect, it } from "vitest";
import { renderCmsApprovalPage } from "@/nextjs/cms-approval-page";

describe("CMS approval page", () => {
  it("renders immutable merge scope without injecting request data into markup", () => {
    const html = renderCmsApprovalPage({
      endpoint: "/api/wildwood/access/approvals/approval-1",
      project: { org: "wildwood", repo: "docs" },
      actor: { name: "Owner" },
      approval: {
        id: "approval-1",
        requestedBy: "agent-1",
        permission: "merge.execute",
        sourceRef: "users/agent-1/change",
        targetRef: "main",
        sourceCommit: "abc123",
        reason: "</script><script>throw new Error('injected')</script>",
        status: "pending",
        createdAt: "2026-08-15T20:00:00.000Z",
        expiresAt: "2026-08-15T20:15:00.000Z",
      },
    });

    expect(html).toContain("Approve once");
    expect(html).toContain("This exact commit only");
    expect(html).toContain("One merge attempt");
    expect(html).toContain('\\u003c/script\\u003e\\u003cscript\\u003e');
    expect(html).not.toContain("</script><script>throw");
  });
});
