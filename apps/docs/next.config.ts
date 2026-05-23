import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /** tr33 is consumed from prebuilt `dist/` (see turbo `^build`); native addons stay external. */
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
