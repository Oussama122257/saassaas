import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import { verifyTotp } from "@/lib/auth/totp";

/**
 * Auth.js v5 — credentials (email + password, optional TOTP second factor), JWT sessions.
 * 2FA: users with totpEnabledAt must supply a valid code; the login form asks for it when
 * checkCredentials() reports needsTotp (see src/lib/auth/actions.ts).
 */
const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totp: z.string().optional(),
});

export class TotpRequiredError extends CredentialsSignin {
  code = "totp_required";
}
export class InvalidTotpError extends CredentialsSignin {
  code = "totp_invalid";
}
export class InvalidCredentialsError extends CredentialsSignin {
  code = "invalid_credentials";
}

/** Claims we add to the JWT. Typed locally because module augmentation of next-auth/jwt does not merge under pnpm. */
interface AppClaims {
  uid?: string;
  locale?: string;
  isPlatformAdmin?: boolean;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt", maxAge: 12 * 60 * 60 },
  pages: { signIn: "/fr/login" },
  providers: [
    Credentials({
      credentials: { email: {}, password: {}, totp: {} },
      authorize: async (raw) => {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) throw new InvalidCredentialsError();
        const { email, password, totp } = parsed.data;
        const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
        if (!user || !user.active || !verifyPassword(password, user.passwordHash)) throw new InvalidCredentialsError();
        if (user.totpEnabledAt && user.totpSecret) {
          if (!totp) throw new TotpRequiredError();
          if (!verifyTotp(user.totpSecret, totp)) throw new InvalidTotpError();
        }
        return { id: user.id, email: user.email, name: user.name, locale: user.locale, isPlatformAdmin: user.isPlatformAdmin };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      const t = token as typeof token & AppClaims;
      if (user) {
        t.uid = user.id;
        t.locale = user.locale ?? "fr";
        t.isPlatformAdmin = user.isPlatformAdmin ?? false;
      }
      return t;
    },
    session({ session, token }) {
      const t = token as typeof token & AppClaims;
      if (t.uid) {
        session.user.id = t.uid;
        session.user.locale = t.locale ?? "fr";
        session.user.isPlatformAdmin = t.isPlatformAdmin ?? false;
      }
      return session;
    },
  },
});
