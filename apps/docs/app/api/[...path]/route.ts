import { createTr33Route } from "tr33/nextjs/route";
import { tr33 } from "@/lib/tr33";

export const { GET, POST, HEAD, OPTIONS, PUT, PATCH, DELETE } = createTr33Route(
  () => tr33,
  { revalidateTagName: "docs-content" },
);
