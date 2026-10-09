import { prisma, withSystemContext } from "@/lib/db";
import { randomToken, sha256Hex } from "@/lib/crypto";

/** Android companion pairing tokens (one per device; the secret is shown once). */
export async function createDeviceToken(userId: string, orgId: string, name: string): Promise<string> {
  const token = `dev_${randomToken(24)}`;
  await prisma.deviceToken.create({ data: { userId, orgId, name: name.slice(0, 60) || "Android", tokenHash: sha256Hex(token) } });
  return token;
}

export async function authenticateDevice(header: string | null): Promise<{ userId: string; orgId: string; deviceId: string } | null> {
  const m = header?.match(/^Device\s+(\S+)$/i);
  if (!m) return null;
  return withSystemContext("device-auth", async () => {
    const d = await prisma.deviceToken.findUnique({ where: { tokenHash: sha256Hex(m[1]!) } });
    if (!d || d.revokedAt) return null;
    await prisma.deviceToken.update({ where: { id: d.id }, data: { lastSeenAt: new Date() } });
    return { userId: d.userId, orgId: d.orgId, deviceId: d.id };
  });
}
