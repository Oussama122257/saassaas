import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // Prisma and BullMQ are server-only native/Node packages; keep them out of the bundler.
  serverExternalPackages: ["@prisma/client", "prisma", "bullmq", "ioredis"],
};

export default withNextIntl(nextConfig);
