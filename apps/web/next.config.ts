import type { NextConfig } from "next";
import { loadEnvConfig } from "@next/env";
import path from "node:path";

// Single .env at the repo root, shared with the db/services CLIs.
loadEnvConfig(path.resolve(process.cwd(), "../.."));

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
];

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@taxops/core", "@taxops/db", "@taxops/services"],
  serverExternalPackages: ["pg"],
  async headers() {
    const baseline = securityHeaders.filter((h) => h.key !== "Content-Security-Policy");
    return [
      // Pages get their nonce-based Content-Security-Policy per request from src/proxy.ts.
      { source: "/((?!api/files/).*)", headers: baseline },
      // User-uploaded bytes: the route sets its own `default-src 'none'; sandbox` CSP, which a global rule must not override.
      { source: "/api/files/:id", headers: baseline },
    ];
  },
};

export default config;
