import { beforeAll, afterAll } from "vitest";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres@localhost:5432/codcc_test?schema=public";
process.env.QUEUE_DISABLED = "1";
process.env.TENANT_GUARD = "1";
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "5GmrGO6Hqz6KpQ9m0e1wP2tY4uI7oA9sD1fG3hJ5kL8=";
process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-secret-test-secret-test-secret";
process.env.ALLOW_MANUAL_CALL_PROOF = "0";

beforeAll(async () => {
  const { prisma, withSystemContext } = await import("@/lib/db");
  await withSystemContext("test-reset", async () => {
    const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    if (tables.length > 0) {
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
    }
  });
});

afterAll(async () => {
  const { prisma } = await import("@/lib/db");
  await prisma.$disconnect();
});
