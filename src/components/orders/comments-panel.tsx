"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn, formatDateTime } from "@/lib/utils";
import { commentAction } from "@/app/[locale]/(app)/queue/actions";

const TAGS = ["NRP", "SMS_ENVOYE", "COULEUR_TAILLE", "LIVREUR", "SUIVI", "ADRESSE", "PRIX", "RAPPEL"] as const;
const QUICK: Array<{ key: "nrpMsg" | "smsSent" | "livreur"; tags: string[] }> = [
  { key: "nrpMsg", tags: ["NRP", "SMS_ENVOYE"] },
  { key: "smsSent", tags: ["SMS_ENVOYE"] },
  { key: "livreur", tags: ["LIVREUR"] },
];

export interface CommentDto {
  id: string;
  body: string;
  tags: string[];
  stage: string;
  createdAt: Date | string;
  author: { name: string };
}

/** Structured comments (section 19c.6): tags + free text + one-click Darija quick comments. */
export function CommentsPanel({ orderId, comments, locale, timezone, readOnly = false }: { orderId: string; comments: CommentDto[]; locale: string; timezone: string; readOnly?: boolean }) {
  const t = useTranslations("call");
  const tt = useTranslations("comments");
  const router = useRouter();
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = (b: string, tg: string[]) =>
    start(async () => {
      const r = await commentAction({ orderId, body: b, tags: tg });
      if (!r.ok) setError(r.message);
      else {
        setBody("");
        setTags([]);
        setError(null);
        router.refresh();
      }
    });

  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">{t("comments")}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {!readOnly ? (
          <div className="space-y-2" data-testid="comment-form">
            <div className="flex flex-wrap gap-1.5">
              {QUICK.map((q) => (
                <Button key={q.key} type="button" size="sm" variant="secondary" disabled={pending} onClick={() => submit(tt(`quick.${q.key}`), q.tags)}>{tt(`quick.${q.key}`)}</Button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {TAGS.map((tag) => (
                <button key={tag} type="button" onClick={() => setTags((x) => (x.includes(tag) ? x.filter((y) => y !== tag) : [...x, tag]))} className={cn("rounded-full border px-2 py-0.5 text-xs", tags.includes(tag) ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent")} aria-pressed={tags.includes(tag)}>
                  {tt(`tags.${tag}`)}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <Textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder={t("commentPlaceholder")} />
              <Button type="button" disabled={pending || (!body.trim() && tags.length === 0)} onClick={() => submit(body, tags)}>{t("addComment")}</Button>
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
        ) : null}
        <ul className="space-y-2 text-sm">
          {comments.map((c) => (
            <li key={c.id} className="rounded-md border p-2">
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{c.author.name}</span> · {formatDateTime(c.createdAt, locale, timezone)}
                {c.tags.map((tag) => <Badge key={tag} variant="outline" className="text-[10px]">{tt.has(`tags.${tag}`) ? tt(`tags.${tag}`) : tag}</Badge>)}
              </div>
              <p className="mt-1 whitespace-pre-line">{c.body}</p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
