import { ExternalLink } from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ExtensionSlot } from "@/lib/extensions";
import { useSession } from "@/lib/session";

import { useSettingsSearch } from "../paths";
import { CORE_LICENSE_URL, LOCAL_THIRD_PARTY_NOTICES_PATH, aboutLinks } from "../presenters";

/**
 * Settings, About: what this installation runs (product name, version and
 * commit), the license of the core with a link to its text, the source code
 * of exactly this release and its third-party notices (served with the
 * interface, and on GitHub at the release). Whatever extensions
 * add follows in the `settings.about` slot; without one the facts stand alone.
 */
export function AboutSection() {
  const { t } = useTranslation("settings");
  const { version } = useSession();
  const { requires } = useSettingsSearch();
  const running = version?.running ?? null;
  const commit = version?.commit ?? null;
  const links = aboutLinks(running);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("about.title")}</CardTitle>
          <CardDescription>{t("about.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
            <dt className="text-muted-foreground">{t("about.product")}</dt>
            <dd className="font-medium">{t("common:app.name")}</dd>

            <dt className="text-muted-foreground">{t("about.version")}</dt>
            <dd className="tabular-nums">{running ?? t("about.developmentBuild")}</dd>

            <dt className="text-muted-foreground">{t("about.commit")}</dt>
            <dd>
              {commit ? (
                <code className="font-mono text-xs">{commit}</code>
              ) : (
                <span className="text-muted-foreground">{t("about.commitUnknown")}</span>
              )}
            </dd>

            <dt className="text-muted-foreground">{t("about.license")}</dt>
            <dd>
              <ExternalAnchor href={CORE_LICENSE_URL}>{t("about.licenseName")}</ExternalAnchor>
            </dd>

            <dt className="text-muted-foreground">{t("about.source")}</dt>
            <dd>
              <ExternalAnchor href={links.source}>
                {running
                  ? t("about.sourceRelease", { version: running })
                  : t("about.sourceRepository")}
              </ExternalAnchor>
            </dd>

            <dt className="text-muted-foreground">{t("about.thirdParty")}</dt>
            <dd className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <ExternalAnchor href={LOCAL_THIRD_PARTY_NOTICES_PATH}>
                {t("about.thirdPartyLink")}
              </ExternalAnchor>
              <ExternalAnchor href={links.thirdParty}>{t("about.thirdPartyGitHub")}</ExternalAnchor>
            </dd>
          </dl>
        </CardContent>
      </Card>

      <ExtensionSlot name="settings.about" props={{ requires: requires ?? null }} />
    </div>
  );
}

/** A link that opens outside the app, in a new tab, and says so to screen readers. */
function ExternalAnchor({ href, children }: { href: string; children: React.ReactNode }) {
  const { t } = useTranslation("settings");
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-2 hover:no-underline"
    >
      {children}
      <ExternalLink className="size-3.5" aria-hidden="true" />
      <span className="sr-only">{t("about.opensInNewTab")}</span>
    </a>
  );
}
