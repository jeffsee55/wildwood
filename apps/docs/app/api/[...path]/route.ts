import { handle } from "tr33/nextjs";

import { getDocsTr33 } from "@/lib/tr33";

const handlerOptions = {
  revalidateTagOnDraftExit: "docs-content",
} as const;

let tr33Api: ReturnType<typeof handle> | null = null;

function getTr33Api() {
  if (!tr33Api) {
    tr33Api = handle(getDocsTr33(), handlerOptions);
  }
  return tr33Api;
}

export const GET = (request: Request) => getTr33Api()(request);
export const HEAD = (request: Request) => getTr33Api()(request);
export const OPTIONS = (request: Request) => getTr33Api()(request);
export const POST = (request: Request) => getTr33Api()(request);
