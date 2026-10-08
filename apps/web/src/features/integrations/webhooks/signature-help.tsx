import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const HEADERS = [
  { name: "X-Restow-Signature", key: "signature.signatureHeader" },
  { name: "X-Restow-Event", key: "signature.eventHeader" },
  { name: "X-Restow-Delivery", key: "signature.deliveryHeader" },
  { name: "X-Restow-Attempt", key: "signature.attemptHeader" },
] as const;

/** What a receiver gets with every request and how it proves the request came from Restow. */
export function SignatureHelp() {
  const { t } = useTranslation("integrations");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
          {t("signature.title")}
        </CardTitle>
        <CardDescription>{t("signature.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-6">
          {HEADERS.map((header) => (
            <div key={header.name} className="contents">
              <dt>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {header.name}
                </code>
              </dt>
              <dd className="text-muted-foreground">{t(header.key)}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">{t("signature.retries")}</p>
        <p className="text-xs text-muted-foreground">{t("signature.chat")}</p>
      </CardContent>
    </Card>
  );
}
