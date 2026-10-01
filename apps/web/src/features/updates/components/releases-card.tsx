import { ChevronDown, ExternalLink } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

import type { ReleaseView, UpdatesView } from "../api";
import { Markdown } from "../markdown";
import { formatReleaseDate, safeReleaseUrl } from "../presenters";

/** The newest release and the ones between it and the running version, with their notes. */
export function ReleasesCard({ view }: { view: UpdatesView }) {
  const { t } = useTranslation("updates");
  const releases = view.releases.length > 0 ? view.releases : view.latest ? [view.latest] : [];
  const newer = view.releases.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{newer ? t("releases.newer.title") : t("releases.latest.title")}</CardTitle>
        <CardDescription>
          {newer ? t("releases.newer.description") : t("releases.latest.description")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {releases.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-slot="releases-empty">
            {t(`releases.empty.${view.check.state}`)}
          </p>
        ) : (
          <ul className="space-y-3">
            {releases.map((release, index) => (
              <ReleaseItem
                key={release.tag}
                release={release}
                newest={newer && index === 0}
                current={release.version === view.running}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ReleaseItem({
  release,
  newest,
  current,
}: {
  release: ReleaseView;
  newest: boolean;
  /** This release is the version the installation runs. */
  current: boolean;
}) {
  const { t, i18n } = useTranslation("updates");
  const [open, setOpen] = React.useState(false);
  const language = i18n.resolvedLanguage ?? i18n.language;
  const date = formatReleaseDate(release.publishedAt, language);
  const url = safeReleaseUrl(release.url);
  const notes = release.notes?.trim() ?? "";

  return (
    <li
      className="space-y-3 rounded-lg border border-border p-4"
      data-slot="release"
      data-version={release.version}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-mono text-base font-semibold [overflow-wrap:anywhere]">
          {release.version}
        </span>
        <Badge variant="outline" className="font-mono">
          {release.tag}
        </Badge>
        {newest ? <Badge variant="info">{t("releases.newest")}</Badge> : null}
        {current ? <Badge variant="outline">{t("releases.installed")}</Badge> : null}
        {release.prerelease ? <Badge variant="warning">{t("releases.prerelease")}</Badge> : null}
        <span className="text-sm text-muted-foreground">
          {date ? t("releases.released", { date }) : t("releases.noDate")}
        </span>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-sm font-medium text-primary underline underline-offset-2 hover:no-underline"
          >
            {t("releases.page")}
            <ExternalLink className="size-3.5" aria-hidden="true" />
            <span className="sr-only">{t("releases.opensInNewTab")}</span>
          </a>
        ) : null}
      </div>

      {notes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("releases.noNotes")}</p>
      ) : (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="-ml-2.5">
              <ChevronDown
                className="transition-transform motion-reduce:transition-none data-[open=true]:rotate-180"
                data-open={open}
                aria-hidden="true"
              />
              {open ? t("releases.hideNotes") : t("releases.showNotes")}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <div className="rounded-md border border-border bg-muted/30 p-4">
              <Markdown source={notes} />
              {release.notesTruncated ? (
                <p
                  className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground"
                  data-slot="notes-truncated"
                >
                  {t("releases.truncated")}
                </p>
              ) : null}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </li>
  );
}
