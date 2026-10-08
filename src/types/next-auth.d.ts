import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & {
      id: string;
      locale: string;
      isPlatformAdmin: boolean;
    };
  }
  interface User {
    locale?: string;
    isPlatformAdmin?: boolean;
  }
}
