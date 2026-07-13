import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["wildwood", "wildwood-kit", "wildwood-shared", "wildwood-store"],
};

export default nextConfig;
