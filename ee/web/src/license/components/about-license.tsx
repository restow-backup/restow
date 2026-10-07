import { ExternalLink, Trash2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { CopyButton } from "@/components/kit";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { AccessNote, ReadOnlyGroup, useInstallationAccess } from "@/features/installation/access";
import type { InstallationSectionProps } from "@/lib/extensions";
import { formatDateTime } from "@/lib/format";

import { type LicensedEdition, editionAllows, requiredEditionOf, useEdition } from "../edition";
import {
  type EditionOrigin,
  editionOrigin,
  licenseRequestUrl,
  licenseTermsUrl,
} from "../presenters";
import type { LicenseState } from "../types";
import { useLicenseState } from "../use-license";
import { InstallKeyForm } from "./install-key-form";
import { RemoveKeyDialog } from "./remove-key-dialog";

const ORIGIN_BADGE: Record<Exclude<EditionOrigin, null>, BadgeProps["variant"]> = {
  key: "info",
  environment: "outline",
};

/**
 * Installation, License (a section of the installation page): the edition in
 * effect, the installed key (licensee, key ID, dates and the license terms it
 * was issued under), the installation ID a key must be issued for, the
 * verification key, and the form to install or remove a key. A link from a
 * locked feature (`?requires=`) first names the edition that unlocks it.
 */
export function AboutLicense({ requires }: InstallationSectionProps) {
  const { t } = useTranslation("license");
  const query = useLicenseState();
  const sessionEdition = useEdition();
  const edition = query.data?.edition ?? sessionEdition;
  const required = requiredEditionOf(requires);
  const access = useInstallationAccess();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("about.title")}</CardTitle>
        <CardDescription>{t("about.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Installing and removing a key is for the owner of the provider team. */}
        <AccessNote block={access.change} level="owner" />
        {required && !editionAllows(edition, required) ? (
          <RequiredEditionNotice edition={required} />
        ) : null}
        <GetKeyNotice />
        {query.isPending ? (
          <LicenseSkeleton />
        ) : query.isError ? (
          <ErrorState
            title={t("about.loadError")}
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : (
          <LicenseDetails state={query.data} closed={access.change !== null} />
        )}
      </CardContent>
    </Card>
  );
}

/** Names the edition a locked feature belongs to; plain text, no banner. */
function RequiredEditionNotice({ edition }: { edition: LicensedEdition }) {
  const { t } = useTranslation("license");
  return (
    <p
      className="rounded-md border border-primary/40 bg-primary/5 px-4 py-3 text-sm"
      data-required-edition={edition}
    >
      {t("about.requiredEdition", { edition: t(`edition.${edition}`) })}{" "}
      {t(`about.unlocks.${edition}`)}
    </p>
  );
}

/** Where a key comes from: the vendor's website compares the editions and takes the request. */
function GetKeyNotice() {
  const { t, i18n } = useTranslation("license");
  return (
    <p className="text-sm text-muted-foreground" data-slot="get-key">
      {t("about.getKey")}{" "}
      <a
        href={licenseRequestUrl(i18n.resolvedLanguage ?? i18n.language)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-2 hover:no-underline"
      >
        {t("about.getKeyLink")}
        <ExternalLink className="size-3.5" aria-hidden="true" />
        <span className="sr-only">{t("about.opensInNewTab")}</span>
      </a>
    </p>
  );
}

function LicenseDetails({ state, closed }: { state: LicenseState; closed: boolean }) {
  const { t, i18n } = useTranslation("license");
  const { t: tc } = useTranslation();
  const [confirming, setConfirming] = React.useState(false);
  const language = i18n.resolvedLanguage ?? i18n.language;
  const unknown = tc("time.unknown");
  const origin = editionOrigin(state);
  const { key, verification } = state;

  return (
    <>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-muted-foreground">{t("edition.label")}</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{t(`edition.${state.edition}`)}</span>
          {origin ? (
            <Badge variant={ORIGIN_BADGE[origin]}>{t(`edition.badge.${origin}`)}</Badge>
          ) : null}
        </dd>

        {key ? (
          <>
            <dt className="text-muted-foreground">{t("key.licensee")}</dt>
            <dd className="font-medium">{key.licensee ?? unknown}</dd>
            <dt className="text-muted-foreground">{t("key.keyId")}</dt>
            <dd className="font-mono text-xs leading-5">{key.keyId ?? unknown}</dd>
            <dt className="text-muted-foreground">{t("key.issuedAt")}</dt>
            <dd>{formatDateTime(key.issuedAt, language) ?? unknown}</dd>
            <dt className="text-muted-foreground">{t("key.installedAt")}</dt>
            <dd>{formatDateTime(key.installedAt, language) ?? unknown}</dd>
            <dt className="text-muted-foreground">{t("about.terms")}</dt>
            <dd>
              <a
                href={licenseTermsUrl(language)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-2 hover:no-underline"
              >
                {t("about.termsLink")}
                <ExternalLink className="size-3.5" aria-hidden="true" />
                <span className="sr-only">{t("about.opensInNewTab")}</span>
              </a>
            </dd>
          </>
        ) : (
          <>
            <dt className="text-muted-foreground">{t("key.title")}</dt>
            <dd className="text-muted-foreground">{t("key.none")}</dd>
          </>
        )}

        {state.installationId ? (
          <>
            <dt className="text-muted-foreground sm:pt-1.5">{t("key.installationId")}</dt>
            <dd className="min-w-0 space-y-1">
              <span className="inline-flex max-w-full items-center gap-1.5">
                <code className="min-w-0 break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {state.installationId}
                </code>
                <CopyButton value={state.installationId} label={t("key.copy")} />
              </span>
              <p className="text-xs text-muted-foreground">{t("key.installationIdHint")}</p>
            </dd>
          </>
        ) : null}

        {verification.status === "ready" && verification.fingerprint && verification.source ? (
          <>
            <dt className="text-muted-foreground">{t("key.verification")}</dt>
            <dd className="min-w-0 space-y-1">
              <code className="break-all font-mono text-xs">{verification.fingerprint}</code>
              <p className="text-xs text-muted-foreground">
                {t(`key.verificationSource.${verification.source}`)}
              </p>
            </dd>
          </>
        ) : null}
      </dl>

      <ReadOnlyGroup closed={closed} className="space-y-6">
        {key ? (
          <div>
            <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
              <Trash2 />
              {t("key.remove")}
            </Button>
            <RemoveKeyDialog
              open={confirming}
              onOpenChange={setConfirming}
              fallbackEdition={state.environmentEdition}
            />
          </div>
        ) : null}

        <Separator />
        <InstallKeyForm state={state} />
      </ReadOnlyGroup>
    </>
  );
}

function LicenseSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true">
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-4 w-64" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-9 w-48" />
    </div>
  );
}
