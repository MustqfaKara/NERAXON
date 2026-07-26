import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["node:sqlite"],
  devIndicators: {
    position: "bottom-right",
  },
};

export default nextConfig;
