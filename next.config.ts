import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // SVAR's package exports map points "require" at a file that doesn't ship
  // (./dist/index.cjs.js). Transpiling forces Next to use the ESM entry.
  transpilePackages: ["@svar-ui/react-gantt"],
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default nextConfig;
