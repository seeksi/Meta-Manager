import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit .next/standalone/server.js so Electron can boot the server with plain Node.
  output: "standalone",
};

export default nextConfig;
