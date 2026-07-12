// Server-only boundary: fetches data, then hands off to a pure client
// wrapper for `WildwoodJsonView`. The client wrapper file (`playground-json-client`)
// never imports anything Node-only, so Turbopack can emit a valid client chunk
// even though this server file imports `wildwood` (which has `node:module` deps).

import { PlaygroundDataError } from "@/components/playground-data-error";
import type { PlaygroundConfig } from "@/lib/playground-config";
import { logAndFormatPlaygroundError } from "@/lib/playground-error";
import { getPlaygroundViewData } from "@/lib/playground-data";
import { PlaygroundJsonClient } from "./playground-json-client";

export async function PlaygroundJsonSection(props: {
  config: PlaygroundConfig;
}) {
  let viewData: object;
  try {
    viewData = await getPlaygroundViewData(props.config.ref, props.config);
  } catch (err) {
    const message = logAndFormatPlaygroundError(err, {
      activeRef: props.config.ref,
      config: props.config,
    });
    return <PlaygroundDataError message={message} />;
  }
  return <PlaygroundJsonClient value={viewData} />;
}
