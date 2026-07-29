import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The editor runs entirely in the browser, so it can be exported as static
  // files and published by GitHub Pages without a server.
  output: "export",
  trailingSlash: true,
};

export default nextConfig;
