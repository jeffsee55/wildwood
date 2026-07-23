import { withWildwood } from "wildwood/nextjs/config";

export default withWildwood({
  cacheComponents: true,
  // play bundles `wildwood` from source (workspace) rather than dist.
  transpilePackages: ["wildwood"],
});
