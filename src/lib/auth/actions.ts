"use server";

import { AuthError, CredentialsSignin } from "next-auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { signIn, signOut } from "@/auth";
import { prisma } from "@/lib/db";
import { writeAuditLog } from "@/lib/audit";
import { isLocale } from "@/i18n/routing";
import { ACTIVE_ORG_COOKIE, getCurrentContext } from "./session";

export interface LoginState {
  error?: "invalid_credentials" | "totp_required" | "totp_invalid" | "unknown";
  email?: string;
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totp: z.string().optional(),
  locale: z.string().optional(),
});

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_credentials" };
  const { email, password, totp, locale } = parsed.data;
  const loc = isLocale(locale) ? locale : "fr";
  try {
    await signIn("credentials", { email, password, totp: totp?.trim() || undefined, redirectTo: `/${loc}/dashboard` });
    return {};
  } catch (err) {
    if (err instanceof CredentialsSignin) {
      const code = err.code as LoginState["error"];
      if (code === "totp_required" || code === "totp_invalid" || code === "invalid_credentials") return { error: code, email };
      return { error: "invalid_credentials", email };
    }
    if (err instanceof AuthError) return { error: "unknown", email };
    throw err; // NEXT_REDIRECT on success
  }
}

export async function logoutAction(formData: FormData) {
  const locale = String(formData.get("locale") ?? "fr");
  const ctx = await getCurrentContext();
  if (ctx) await writeAuditLog(ctx, { action: "LOGOUT" }).catch(() => undefined);
  await signOut({ redirectTo: `/${isLocale(locale) ? locale : "fr"}/login` });
}

export async function switchOrgAction(formData: FormData) {
  const orgId = String(formData.get("orgId") ?? "");
  const locale = String(formData.get("locale") ?? "fr");
  const ctx = await getCurrentContext();
  if (!ctx) redirect(`/${locale}/login`);
  if (!ctx.memberships.some((m) => m.orgId === orgId)) return;
  const jar = await cookies();
  jar.set(ACTIVE_ORG_COOKIE, orgId, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  revalidatePath("/", "layout");
  redirect(`/${isLocale(locale) ? locale : "fr"}/dashboard`);
}

/** Persist the user's preferred locale (the URL prefix is the source of truth for rendering). */
export async function setLocaleAction(locale: string) {
  if (!isLocale(locale)) return;
  const ctx = await getCurrentContext();
  if (!ctx) return;
  await prisma.user.update({ where: { id: ctx.userId }, data: { locale } });
}
