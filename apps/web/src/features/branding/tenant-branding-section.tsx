import { Palette } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { FeatureLocked } from "@/features/installation/feature-locked";
import "@/features/settings/i18n";
import { errorMessageKey } from "@/lib/api";
import type { TenantSectionProps } from "@/lib/extensions";

import type { MailSenderFacts, PreviewKind } from "./api";
import { BrandingEditor } from "./branding-editor";
import { useProviderBranding, useSaveBranding, useTenantBranding } from "./hooks";

/** What the page assumes about the transport while the provider's view cannot be read. */
const UNKNOWN_MAIL: MailSenderFacts = {
  transport: null,
  fromLocked: false,
  defaultFrom: null,
  allowedSenders: [],
};

/**
 * The tenant page's Branding (0.5.0, provider administrators only): the tenant's own logo,
 * sender, accent colour and footer instead of the provider's, on this tenant's mails, chat
 * messages and customer reports (edition Service Provider, gate `branding.tenant`). By default a
 * tenant uses the provider's branding; switching that off starts its own.
 */
export function TenantBrandingSection({ tenant, readOnly }: TenantSectionProps) {
  const { t } = useTranslation("tenantpage");
  const { t: tc } = useTranslation();
  const query = useTenantBranding(tenant.id);
  const provider = useProviderBranding();
  const save = useSaveBranding({ kind: "tenant", tenantId: tenant.id });
  const [ownWanted, setOwnWanted] = React.useState(false);

  if (query.isPending) {
    return <Skeleton className="h-96 w-full" />;
  }
  if (query.isError || !query.data) {
    return (
      <ErrorState
        title={t("branding.loadError")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  const view = query.data;
  if (!view.available) {
    return (
      <Card data-slot="tenant-branding-locked">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Palette aria-hidden="true" className="size-4 text-muted-foreground" />
            {t("branding.locked.title")}
          </CardTitle>
          <CardDescription>{t("branding.locked.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <FeatureLocked feature="branding.tenant" />
        </CardContent>
      </Card>
    );
  }

  const own = !view.inherits || ownWanted;
  const productName = provider.data?.productName ?? "";

  function chooseProvider(on: boolean) {
    if (!on) {
      setOwnWanted(true);
      return;
    }
    setOwnWanted(false);
    if (view.inherits) return;
    save.mutate(
      { inherit: true },
      {
        onSuccess: () => toast.success(t("branding.inherited")),
        onError: (error) => toast.error(tc(errorMessageKey(error))),
      },
    );
  }

  const kinds: PreviewKind[] = provider.data?.available.customerReport
    ? ["alert", "digest", "summary", "customer"]
    : ["alert", "digest", "summary"];

  return (
    <div className="space-y-6" data-slot="tenant-branding">
      <Card>
        <CardContent className="flex items-start gap-3 pt-6">
          <Switch
            id="tenant-branding-inherit"
            checked={!own}
            disabled={readOnly || save.isPending}
            onCheckedChange={(checked) => chooseProvider(checked)}
          />
          <div className="space-y-0.5">
            <Label htmlFor="tenant-branding-inherit">{t("branding.inherit")}</Label>
            <p className="text-xs text-muted-foreground">
              {own
                ? t("branding.ownHint", { tenant: tenant.name })
                : t("branding.inheritHint", { tenant: tenant.name })}
            </p>
          </div>
        </CardContent>
      </Card>
      {own ? (
        <BrandingEditor
          scope={{ kind: "tenant", tenantId: tenant.id }}
          branding={
            view.override ?? {
              senderName: null,
              fromAddress: null,
              replyTo: null,
              accentColor: null,
              onAccent: null,
              footerText: null,
              logo: null,
              updatedAt: null,
            }
          }
          mail={provider.data?.mail ?? UNKNOWN_MAIL}
          productName={productName}
          publicUrlHttps={provider.data?.publicUrlHttps ?? true}
          readOnly={readOnly}
          canTest={!readOnly}
          previewKinds={kinds}
        />
      ) : (
        <Alert variant="info" data-slot="tenant-branding-inherits">
          <Palette />
          <AlertDescription>
            {view.effective.senderName
              ? t("branding.inheritsNamed", { name: view.effective.senderName })
              : t("branding.inheritsProduct", { appName: productName })}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
