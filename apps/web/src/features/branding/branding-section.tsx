import { Palette } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AccessNote, useInstallationAccess } from "@/features/installation/access";
import { FeatureLocked } from "@/features/installation/feature-locked";
import "@/features/settings/i18n";

import type { PreviewKind } from "./api";
import { BrandingEditor } from "./branding-editor";
import { useProviderBranding } from "./hooks";

/**
 * Installation › Branding (0.5.0): the provider's logo, sender, accent colour and footer on
 * every mail and chat message of every tenant (edition Business, gate `branding.provider`).
 * Without the edition the messages carry the product name only, and the section says which
 * edition adds this. Everyone on the provider team sees it; the owner changes it, an
 * administrator may send the test mail.
 */
export function BrandingSection() {
  const { t } = useTranslation("settings");
  const access = useInstallationAccess();
  const query = useProviderBranding();

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
  if (!view.available.provider) {
    return (
      <Card data-slot="branding-locked">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Palette aria-hidden="true" className="size-4 text-muted-foreground" />
            {t("branding.locked.title")}
          </CardTitle>
          <CardDescription>
            {t("branding.locked.description", { appName: view.productName })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FeatureLocked feature="branding.provider" />
        </CardContent>
      </Card>
    );
  }
  const kinds: PreviewKind[] = view.available.customerReport
    ? ["alert", "digest", "summary", "customer"]
    : ["alert", "digest", "summary"];
  return (
    <div className="space-y-6">
      <AccessNote block={access.change} level="owner" />
      <BrandingEditor
        scope={{ kind: "provider" }}
        branding={view.provider}
        mail={view.mail}
        productName={view.productName}
        publicUrlHttps={view.publicUrlHttps}
        readOnly={access.change !== null}
        canTest={access.operate === null}
        previewKinds={kinds}
      />
    </div>
  );
}
