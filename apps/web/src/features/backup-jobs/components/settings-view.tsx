import { Pencil } from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Fact, Facts } from "@/features/endpoints/components/facts";
import { formatDateTime } from "@/lib/format";

import type { BackupJob } from "../api.js";
import { EXCLUSION_PRESETS, ownPatterns, presetIsOn } from "../exclusions.js";
import { MASKED_HOOK } from "../form.js";
import {
  describeJobSchedule,
  repositoryLabel,
  retentionLabel,
  scheduleUsesZone,
} from "../presenters.js";
import { type JobsAccess, closedProps } from "./access-note.js";
import { useWindowSummary } from "./bandwidth-windows-field.js";

function Section({
  title,
  description,
  children,
}: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-xs break-all">{children}</span>;
}

function HookText({ value }: { value: string | undefined }) {
  const { t } = useTranslation("backupjobs");
  if (!value) {
    return <span className="text-muted-foreground">{t("settings.none")}</span>;
  }
  if (value === MASKED_HOOK) {
    return <span className="text-muted-foreground">{t("settings.hooksHidden")}</span>;
  }
  return (
    <pre className="rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">{value}</pre>
  );
}

/**
 * Everything the job says, read only, with the one button that edits it. The
 * editor is the same sheet as for a new job.
 */
export function SettingsView({
  job,
  access,
  onEdit,
}: {
  job: BackupJob;
  access: JobsAccess;
  onEdit: () => void;
}) {
  const { t, i18n } = useTranslation("backupjobs");
  const { t: tSchedules } = useTranslation("schedules");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const ctx = { t, tSchedules, language };
  const settings = job.settings;
  const excludes = settings.excludes ?? [];
  const presetsOn = EXCLUSION_PRESETS.filter((preset) => presetIsOn(excludes, preset));
  const own = ownPatterns(excludes);
  const windows = settings.bandwidthWindows ?? [];
  const windowSummary = useWindowSummary();

  return (
    <div className="space-y-4" data-slot="job-settings">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-prose text-sm text-muted-foreground">{t("settings.intro")}</p>
        <Button
          variant="outline"
          size="sm"
          disabled={access.closed}
          onClick={onEdit}
          {...closedProps(access)}
        >
          <Pencil aria-hidden="true" />
          {t("actions.edit")}
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={t("settings.general")}>
          <Facts>
            <Fact label={t("settings.facts.name")}>{job.name}</Fact>
            <Fact label={t("settings.facts.kind")}>{t(`settings.kinds.${job.kind}`)}</Fact>
            <Fact label={t("settings.facts.scope")}>
              {t(`settings.scopeMode.${job.scopeMode}`)}
            </Fact>
            <Fact label={t("settings.facts.created")}>
              {formatDateTime(job.createdAt, language) ?? job.createdAt}
            </Fact>
            <Fact label={t("settings.facts.updated")}>
              {formatDateTime(job.updatedAt, language) ?? job.updatedAt}
            </Fact>
          </Facts>
        </Section>

        <Section title={t("settings.schedule")}>
          <Facts>
            <Fact label={t("settings.facts.schedule")}>
              {describeJobSchedule(job.schedule, ctx)}
              {scheduleUsesZone(job.schedule) && job.schedule ? (
                <span className="block text-xs text-muted-foreground">{job.schedule.timeZone}</span>
              ) : null}
            </Fact>
            {job.kind === "mail" ? (
              <Fact label={t("settings.facts.restoreCheck")}>
                {job.verifySchedule ? (
                  <>
                    {describeJobSchedule(job.verifySchedule, ctx)}
                    {scheduleUsesZone(job.verifySchedule) ? (
                      <span className="block text-xs text-muted-foreground">
                        {job.verifySchedule.timeZone}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-muted-foreground">{t("settings.restoreCheckOff")}</span>
                )}
              </Fact>
            ) : null}
          </Facts>
        </Section>

        {job.kind === "copy" ? (
          <CopySettings job={job} />
        ) : (
          <Section title={t("settings.repositoryAndRetention")}>
            <Facts>
              <Fact label={t("settings.facts.repository")}>
                {job.kind === "share"
                  ? t("settings.shareRepository")
                  : repositoryLabel(job.repository, t)}
              </Fact>
              <Fact label={t("settings.facts.retention")}>{retentionLabel(job, t)}</Fact>
            </Facts>
            {job.kind === "share" ? null : (
              <p className="mt-3 text-xs text-muted-foreground">
                {t("editor.repository.sentence")}
              </p>
            )}
          </Section>
        )}

        {job.kind === "share" ? <ShareSettings job={job} /> : null}

        {job.kind === "endpoint" ? (
          <>
            <Section title={t("settings.folders")}>
              {settings.paths && settings.paths.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5">
                  {settings.paths.map((path) => (
                    <li key={path} className="rounded-md border bg-muted/40 px-2 py-0.5">
                      <Mono>{path}</Mono>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{t("settings.foldersNone")}</p>
              )}
            </Section>

            <Section title={t("settings.exclusions")}>
              <Facts>
                <Fact label={t("settings.facts.fileTypes")}>
                  {presetsOn.length > 0 ? (
                    presetsOn.map((preset) => t(`exclusions.presets.${preset.id}`)).join(", ")
                  ) : (
                    <span className="text-muted-foreground">{t("settings.none")}</span>
                  )}
                </Fact>
                <Fact label={t("settings.facts.ownPatterns")}>
                  {own.length > 0 ? (
                    <ul className="flex flex-wrap gap-1.5">
                      {own.map((pattern) => (
                        <li key={pattern} className="rounded-md border bg-muted/40 px-2 py-0.5">
                          <Mono>{pattern}</Mono>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-muted-foreground">{t("settings.none")}</span>
                  )}
                </Fact>
                <Fact label={t("settings.facts.larger")}>
                  {typeof settings.excludeLargerThanGib === "number" ? (
                    t("settings.largerValue", { size: settings.excludeLargerThanGib })
                  ) : (
                    <span className="text-muted-foreground">{t("settings.noLimit")}</span>
                  )}
                </Fact>
              </Facts>
            </Section>

            <Section title={t("settings.bandwidth")}>
              <Facts>
                <Fact label={t("settings.facts.bandwidth")}>
                  {typeof settings.bandwidthKbps === "number" ? (
                    t("settings.bandwidthValue", { kbps: settings.bandwidthKbps })
                  ) : (
                    <span className="text-muted-foreground">{t("settings.unlimited")}</span>
                  )}
                </Fact>
                <Fact label={t("settings.facts.windows")}>
                  {windows.length > 0 ? (
                    <>
                      <ul className="space-y-1" data-slot="job-windows">
                        {windows.map((window) => (
                          <li key={`${window.days.join("")}-${window.from}-${window.to}`}>
                            {windowSummary(window)}
                          </li>
                        ))}
                      </ul>
                      {job.schedule ? (
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {t("settings.windowsZone", { zone: job.schedule.timeZone })}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-muted-foreground">{t("settings.windowsNone")}</span>
                  )}
                </Fact>
              </Facts>
            </Section>

            <Section title={t("settings.hooks")}>
              <Facts>
                <Fact label={t("hooks.pre")}>
                  <HookText value={settings.hooks?.pre} />
                </Fact>
                <Fact label={t("hooks.post")}>
                  <HookText value={settings.hooks?.post} />
                </Fact>
              </Facts>
            </Section>
          </>
        ) : null}
      </div>
    </div>
  );
}

function List({ items }: { items: readonly string[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <li key={item} className="rounded-md border bg-muted/40 px-2 py-0.5">
          <Mono>{item}</Mono>
        </li>
      ))}
    </ul>
  );
}

/** What a file share job leaves out and how it reads (docs/FILESHARES.md 7.5). */
function ShareSettings({ job }: { job: BackupJob }) {
  const { t } = useTranslation("backupjobs");
  const settings = job.settings;
  const none = <span className="text-muted-foreground">{t("settings.none")}</span>;
  const types = settings.fileTypes?.exclude ?? [];
  return (
    <>
      <Section title={t("settings.exclusions")}>
        <Facts>
          <Fact label={t("shareEditor.exclusions.preset")}>
            {settings.presets?.systemFiles === false ? t("settings.off") : t("settings.on")}
          </Fact>
          <Fact label={t("settings.facts.fileTypes")}>
            {types.length > 0 ? <List items={types.map((ext) => `.${ext}`)} /> : none}
          </Fact>
          <Fact label={t("settings.facts.ownPatterns")}>
            {(settings.excludes ?? []).length > 0 ? <List items={settings.excludes ?? []} /> : none}
          </Fact>
          <Fact label={t("settings.facts.larger")}>
            {typeof settings.excludeLargerThanGib === "number" ? (
              t("settings.largerValue", { size: settings.excludeLargerThanGib })
            ) : (
              <span className="text-muted-foreground">{t("settings.noLimit")}</span>
            )}
          </Fact>
        </Facts>
      </Section>
      <Section title={t("shareEditor.transfer.title")}>
        <Facts>
          <Fact label={t("settings.facts.bandwidth")}>
            {typeof settings.bandwidthKbps === "number" ? (
              t("settings.bandwidthValue", { kbps: settings.bandwidthKbps })
            ) : (
              <span className="text-muted-foreground">{t("settings.unlimited")}</span>
            )}
          </Fact>
          <Fact label={t("shareEditor.transfer.concurrency")}>
            {typeof settings.readConcurrency === "number"
              ? String(settings.readConcurrency)
              : t("settings.automatic")}
          </Fact>
          <Fact label={t("shareEditor.exclusions.offline")}>
            {settings.skipOffline === false ? t("settings.on") : t("settings.off")}
          </Fact>
        </Facts>
      </Section>
    </>
  );
}

/** Where a copy job writes and how (docs/FILESHARES.md 4.10, 12.6). */
function CopySettings({ job }: { job: BackupJob }) {
  const { t } = useTranslation("backupjobs");
  const settings = job.settings;
  const mode = job.copy?.mode ?? settings.mode ?? "overwrite";
  return (
    <Section title={t("copyEditor.where.title")}>
      <Facts>
        <Fact label={t("copyEditor.where.source")}>{job.copy?.source.name ?? "-"}</Fact>
        <Fact label={t("copyEditor.where.target")}>{job.copy?.target.name ?? "-"}</Fact>
        <Fact label={t("copyEditor.where.folder")}>
          <Mono>/{job.copy?.targetFolder ?? settings.targetFolder ?? ""}</Mono>
        </Fact>
        <Fact label={t("copyEditor.mode.title")}>{t(`copyEditor.mode.${mode}.label`)}</Fact>
        <Fact label={t("copyEditor.permissions")}>
          {settings.restorePermissions === true ? t("settings.on") : t("settings.off")}
        </Fact>
        <Fact label={t("copyEditor.verify")}>
          {settings.verify === true
            ? t("settings.on")
            : settings.verify === false
              ? t("settings.off")
              : t("settings.automatic")}
        </Fact>
      </Facts>
      <p className="mt-3 text-xs text-muted-foreground">{t("copyEditor.latestOnly")}</p>
    </Section>
  );
}
