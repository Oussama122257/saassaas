"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/utils";
import { createApiKeyAction, revokeApiKeyAction } from "./actions";

interface KeyRow {
  keyId: string;
  name: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function ApiKeysClient({ locale, timezone, scopes, keys }: { locale: string; timezone: string; scopes: string[]; keys: KeyRow[] }) {
  const t = useTranslations("settings.apiKeys");
  const tc = useTranslations("common");
  const router = useRouter();
  const [created, setCreated] = useState<{ keyId: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [copied, setCopied] = useState(false);

  return (
    <div className="space-y-6">
      {created ? (
        <Alert data-testid="new-key">
          <AlertTitle>{t("newKeyTitle")}</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{t("newKeyWarning")}</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="break-all rounded bg-muted px-2 py-1 font-mono text-xs" dir="ltr">{created.token}</code>
              <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(created.token).then(() => setCopied(true))}>
                {copied ? tc("copied") : tc("copy")}
              </Button>
            </div>
            <p className="font-mono text-xs text-muted-foreground" dir="ltr">{t("usage", { key: created.token })}</p>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader><CardTitle className="text-base">{t("create")}</CardTitle></CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            data-testid="create-key-form"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const name = String(fd.get("name") ?? "");
              const chosen = scopes.filter((s) => fd.get(`scope:${s}`));
              start(async () => {
                const res = await createApiKeyAction({ name, scopes: chosen });
                if (res.ok) {
                  setCreated({ keyId: res.keyId, token: res.token });
                  setError(null);
                  setCopied(false);
                  router.refresh();
                } else setError(res.message);
              });
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="key-name">{t("name")}</Label>
              <Input id="key-name" name="name" placeholder={t("namePlaceholder")} required minLength={2} />
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t("scopes")}</legend>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {scopes.map((s) => (
                  <label key={s} className="flex items-center gap-2 font-mono text-xs">
                    <Checkbox name={`scope:${s}`} value="1" defaultChecked={s === "orders:read"} /> {s}
                  </label>
                ))}
              </div>
            </fieldset>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" disabled={pending}>{t("create")}</Button>
          </form>
        </CardContent>
      </Card>

      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-start">{t("name")}</TableHead>
              <TableHead className="text-start">{t("keyId")}</TableHead>
              <TableHead className="text-start">{t("scopes")}</TableHead>
              <TableHead className="text-start">{t("created")}</TableHead>
              <TableHead className="text-start">{t("lastUsed")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="h-20 text-center text-muted-foreground">{t("empty")}</TableCell></TableRow>
            ) : (
              keys.map((k) => (
                <TableRow key={k.keyId} className={k.revokedAt ? "opacity-50" : ""}>
                  <TableCell className="font-medium">{k.name}</TableCell>
                  <TableCell className="font-mono text-xs" dir="ltr">{k.keyId}</TableCell>
                  <TableCell><div className="flex flex-wrap gap-1">{k.scopes.map((s) => <Badge key={s} variant="outline" className="font-mono text-[10px]">{s}</Badge>)}</div></TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(k.createdAt, locale, timezone)}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{k.lastUsedAt ? formatDateTime(k.lastUsedAt, locale, timezone) : t("never")}</TableCell>
                  <TableCell className="text-end">
                    {k.revokedAt ? (
                      <Badge variant="secondary">{t("revoked")}</Badge>
                    ) : (
                      <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => { await revokeApiKeyAction(k.keyId); router.refresh(); })}>
                        {t("revoke")}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
