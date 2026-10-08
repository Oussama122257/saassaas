import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

/**
 * Locale routing only. Authentication is enforced in the (app)/(portal)/(admin) layouts and in
 * the API route handlers, so this proxy never needs a database connection.
 */
export default createMiddleware(routing);

export const config = {
  // Skip API routes, Next internals and static files
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
