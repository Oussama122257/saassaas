import { execSync } from "node:child_process";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres@localhost:5432/codcc_test?schema=public";

/** Runs once per `vitest run --project integration`: migrate the dedicated test database. */
export default function setup() {
  execSync("pnpm prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL } });
}
