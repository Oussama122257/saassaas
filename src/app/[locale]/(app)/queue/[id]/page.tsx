import { notFound } from "next/navigation";
import { requirePageRole } from "@/lib/auth/guards";
import { getCallScreenData } from "@/lib/calls/callScreen";
import { CallScreen } from "@/components/queue/call-screen";

export default async function CallScreenPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  const ctx = await requirePageRole(locale, ["CONFIRMATION_AGENT", "FOLLOWUP_AGENT", "SUPERVISOR", "ORG_OWNER"]);
  const data = await getCallScreenData(ctx, id);
  if (!data) notFound();
  return <CallScreen data={data} locale={locale} userId={ctx.userId} />;
}
