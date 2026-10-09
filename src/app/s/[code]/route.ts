import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";

/** Short links for SMS (section 19b.5). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!/^[A-Za-z0-9]{4,16}$/.test(code)) return new NextResponse("Not found", { status: 404 });
  const link = await prisma.shortLink.findUnique({ where: { code } });
  if (!link) return new NextResponse("Not found", { status: 404 });
  await prisma.shortLink.update({ where: { code }, data: { clicks: { increment: 1 } } });
  return NextResponse.redirect(link.url, 302);
}
