import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  serverExternalPackages: ["dd-trace", "@anthropic-ai/sdk"],

  outputFileTracingIncludes: {
    "/*": ["./prompts/**/*"],
  },
};

export default nextConfig;
