import { draftMode } from "next/headers";
import { getWeb } from "@/lib/cms";
export const runtime = "nodejs";
export const maxDuration = 60;
async function handler(request: Request) {
  const response = await (await getWeb()).handler(request);
  if (new URL(request.url).pathname === "/cms/preview" && response.status === 303)
    (await draftMode()).disable();
  return response;
}
export { handler as GET, handler as POST, handler as HEAD, handler as OPTIONS };
