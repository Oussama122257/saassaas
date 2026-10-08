import { apiHandler } from "@/lib/api/handler";

export const GET = apiHandler({ public: true, rateLimit: 0 }, async () => ({
  data: { pong: true, time: new Date().toISOString() },
}));
