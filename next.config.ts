import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  serverExternalPackages: ["dd-trace"],

  outputFileTracingIncludes: {
    "/*": ["./prompts/**/*"],
  },
};

export default nextConfig;
