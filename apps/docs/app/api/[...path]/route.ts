import { handle } from "tr33/nextjs";

import { getDocsTr33 } from "@/lib/tr33";

const tr33Api = handle(getDocsTr33(), {
  revalidateTagOnDraftExit: "docs-content",
});

export const GET = tr33Api;
export const HEAD = tr33Api;
export const OPTIONS = tr33Api;
export const POST = tr33Api;
