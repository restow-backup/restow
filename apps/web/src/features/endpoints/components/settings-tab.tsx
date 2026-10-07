import { Link } from "@tanstack/react-router";
import { ListChecks, Plus, ShieldAlert, Trash2, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { Field, messageId } from "@/components/forms/field";
import { ConfirmDialog } from "@/components/kit/confirm-dialog";
import { ReadOnlyGroup } from "@/components/kit/read-only-group";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  BandwidthWindowsField,
  windowCheckOf,
} from "@/features/backup-jobs/components/bandwidth-windows-field";
import { jobDefinitionTo, linkProps } from "@/features/backup-jobs/paths";
import { TimezonePicker } from "@/features/schedules/components/timezone-picker";
import { browserTimeZone } from "@/features/schedules/presenters";
import { isRecentSignInRequired } from "@/lib/recent-sign-in";
import { cn } from "@/lib/utils";

import { type EndpointDetail, LIMITS, type Retention, type ScheduleKind } from "../api.js";
import { useEndpointFormat, useUpdateEndpoint } from "../hooks.js";
import { endpointErrorKey, endpointName, isWithoutBackup } from "../presenters.js";
import {
  DEFAULTS,
  type DraftField,
  type DraftProblems,
  type SettingsDraft,
  buildPatch,
  changedSections,
  checkDraft,
  draftFromDetail,
  hasProblems,
  stricterRetention,
} from "../settings-form.js";
import { AssignmentField } from "./assign-dialog.js";
import { DangerZone } from "./danger-zone.js";
import { RepositoryKeyCard } from "./repository-key-card.js";
import { WithoutBackupNotice } from "./without-backup.js";

const SCHEDULE_KINDS: readonly ScheduleKind[] = ["daily", "interval", "on_connect"];

function useProblemText() {
  const { t } = useTranslation("endpoints");
  return (problems: DraftProblems, field: DraftField): string | undefined => {
    const problem = problems[field];
    return problem ? t(`settings.errors.${problem.code}`, problem.values) : undefined;
  };
}

/**
 * The draft of the form, kept in step with the server: while the admin has
 * no unsaved edits, a newer version from the server (their own save, or
 * another admin's) replaces the fields; their unsaved edits are never overwritten.
 */
export function useSettingsDraft(detail: EndpointDetail) {
  // A poll that changes nothing the form shows yields the same key, so the fields stay as they are.
  const server = draftFromDetail(detail, browserTimeZone());
  const serverKey = JSON.stringify(server);
  const serverRef = React.useRef(server);
  serverRef.current = server;
  const [draft, setDraft] = React.useState<SettingsDraft>(server);
  const draftRef = React.useRef(draft);
  draftRef.current = draft;
  const lastServer = React.useRef(serverKey);
  React.useEffect(() => {
    if (serverKey === lastServer.current) {
      return;
    }
    if (JSON.stringify(draftRef.current) === lastServer.current) {
      setDraft(serverRef.current);
    }
    lastServer.current = serverKey;
  }, [serverKey]);
  return [draft, setDraft] as const;
}

/**
 * The cards of the tab, in page order, for the column of jump links beside
 * them. Each card carries the matching `id` (prefixed, so it cannot collide
 * with a form field's id).
 */
const SETTINGS_ANCHORS = [
  { id: "general", labelKey: "settings.general.title" },
  { id: "files", labelKey: "settings.files.title" },
  { id: "schedule", labelKey: "settings.schedule.title" },
  { id: "limits", labelKey: "settings.limits.title" },
  { id: "hooks", labelKey: "settings.hooks.title" },
  { id: "retention", labelKey: "settings.retention.title" },
  { id: "alerts", labelKey: "settings.alerts.title" },
  { id: "quota", labelKey: "settings.quota.title" },
  { id: "repository-key", labelKey: "repositoryKey.title" },
  { id: "danger", labelKey: "danger.title" },
] as const;

function anchorId(id: string): string {
  return `endpoint-settings-${id}`;
}

/**
 * Jump links to the cards, from the large breakpoint on: a sticky column
 * beside the content, styled like the section navigation of the installation
 * and tenant pages. Below it the cards simply follow each other.
 */
function SettingsAnchors() {
  const { t } = useTranslation("endpoints");
  return (
    <nav
      aria-label={t("settings.anchors")}
      className="hidden lg:block"
      data-slot="settings-anchors"
    >
      <ul className="sticky top-20 space-y-0.5">
        {SETTINGS_ANCHORS.map((anchor) => (
          <li key={anchor.id}>
            <a
              href={`#${anchorId(anchor.id)}`}
              onClick={(event) => {
                const target = document.getElementById(anchorId(anchor.id));
                if (target) {
                  // Scroll without touching the URL: the tab lives in the search params.
                  event.preventDefault();
                  target.scrollIntoView({ behavior: "smooth", block: "start" });
                }
              }}
              className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm text-muted-foreground outline-none transition-colors hover:bg-sidebar-hover hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {t(anchor.labelKey)}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** A card with an anchor for {@link SettingsAnchors}. */
function Anchored({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <div id={anchorId(id)} className="min-w-0 scroll-mt-20">
      {children}
    </div>
  );
}

function Section({
  id,
  title,
  description,
  className,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card id={anchorId(id)} className={cn("min-w-0 scroll-mt-20", className)}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="grid gap-4">{children}</CardContent>
    </Card>
  );
}

function NumberInput({
  id,
  value,
  onChange,
  disabled,
  describedBy,
  invalid,
  placeholder,
  className,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  describedBy: string;
  invalid: boolean;
  placeholder?: string;
  className?: string;
}) {
  return (
    <Input
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      inputMode="numeric"
      autoComplete="off"
      disabled={disabled}
      placeholder={placeholder}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      className={className}
    />
  );
}

function PathsEditor({
  paths,
  onChange,
  disabled,
  error,
}: {
  paths: string[];
  onChange: (paths: string[]) => void;
  disabled: boolean;
  error: string | undefined;
}) {
  const { t } = useTranslation("endpoints");
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">{t("settings.paths.label")}</legend>
      <ul className="grid gap-2">
        {paths.map((path, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity besides their place
          <li key={index} className="flex items-center gap-2">
            <Input
              value={path}
              onChange={(event) =>
                onChange(paths.map((item, at) => (at === index ? event.target.value : item)))
              }
              placeholder={t("settings.paths.placeholder")}
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              className="font-mono text-sm"
              aria-label={t("settings.paths.row", { index: index + 1 })}
              aria-invalid={error ? true : undefined}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled}
              onClick={() => onChange(paths.filter((_, at) => at !== index))}
              aria-label={t("settings.paths.remove", { path: path || String(index + 1) })}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || paths.length >= LIMITS.backupPaths}
          onClick={() => onChange([...paths, ""])}
        >
          <Plus aria-hidden="true" />
          {t("settings.paths.add")}
        </Button>
      </div>
      <p
        role={error ? "alert" : undefined}
        className={error ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
      >
        {error ?? t("settings.paths.hint")}
      </p>
    </fieldset>
  );
}

interface HooksSectionProps {
  detail: EndpointDetail;
  draft: SettingsDraft;
  set: <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => void;
  disabled: boolean;
  problems: DraftProblems;
  problemText: (problems: DraftProblems, field: DraftField) => string | undefined;
}

/**
 * Commands before and after the backup. They run as root on the machine, so
 * the machine decides whether it runs them at all (its hook policy, set there
 * by an administrator): off, only its own named scripts, or any command. The
 * fields follow that; the texts are only shown to who may change them.
 */
function HooksSection({ detail, draft, set, disabled, problems, problemText }: HooksSectionProps) {
  const { t } = useTranslation("endpoints");
  const hooks = detail.hooks;
  const policy = hooks?.policy ?? null;
  const visible = hooks?.visible ?? true;
  const allowed = policy === "scripts" || policy === "any";
  const configured = Boolean(detail.config.hooks.pre || detail.config.hooks.post);
  const locked = disabled || !allowed || !visible;
  const scripts = hooks?.scripts ?? [];
  const field = (kind: "pre" | "post") => {
    const id = `settings-${kind}-hook`;
    const key = kind === "pre" ? "preHook" : "postHook";
    const summary = hooks?.[kind];
    if (!visible) {
      return (
        <Field id={id} label={t(`settings.hooks.${kind}`)}>
          <p className="text-sm text-muted-foreground" data-slot={`${kind}-hook-hidden`}>
            {summary?.set
              ? t("settings.hooks.hidden.set", { fingerprint: summary.fingerprint ?? "" })
              : t("settings.hooks.hidden.none")}
          </p>
        </Field>
      );
    }
    return (
      <Field
        id={id}
        label={t(`settings.hooks.${kind}`)}
        hint={
          policy === "scripts"
            ? t("settings.hooks.scriptHint")
            : t(kind === "pre" ? "settings.hooks.preHint" : "settings.hooks.postHint")
        }
        error={problemText(problems, key)}
      >
        {policy === "scripts" ? (
          <Input
            id={id}
            value={draft[key]}
            onChange={(event) => set(key, event.target.value)}
            disabled={locked}
            spellCheck={false}
            list={scripts.length > 0 ? "settings-hook-scripts" : undefined}
            placeholder={scripts[0] ?? t("settings.hooks.scriptPlaceholder")}
            className="font-mono text-sm"
            aria-describedby={messageId(id)}
          />
        ) : (
          <Textarea
            id={id}
            value={draft[key]}
            onChange={(event) => set(key, event.target.value)}
            rows={4}
            disabled={locked}
            spellCheck={false}
            placeholder={kind === "pre" ? t("settings.hooks.prePlaceholder") : undefined}
            className="font-mono text-sm"
            aria-describedby={messageId(id)}
          />
        )}
      </Field>
    );
  };

  return (
    <Section
      id="hooks"
      title={t("settings.hooks.title")}
      description={t("settings.hooks.description")}
      className="xl:col-span-2"
    >
      <Alert variant={policy === "any" ? "warning" : "default"} data-slot="hooks-policy">
        <ShieldAlert />
        <AlertTitle>{t(`settings.hooks.policy.${policy ?? "unknown"}.title`)}</AlertTitle>
        <AlertDescription>
          <p>{t(`settings.hooks.policy.${policy ?? "unknown"}.description`)}</p>
          {policy === "off"
            ? hookCommands(detail).map((command) => (
                <code key={command} className="mt-1 block font-mono text-xs">
                  {command}
                </code>
              ))
            : null}
          {policy === "scripts" ? (
            <p>
              {scripts.length > 0
                ? t("settings.hooks.policy.scripts.available", { scripts: scripts.join(", ") })
                : t("settings.hooks.policy.scripts.none")}
            </p>
          ) : null}
        </AlertDescription>
      </Alert>
      {policy === "any" ? (
        <Alert variant="warning" data-slot="hooks-warning">
          <ShieldAlert />
          <AlertTitle>{t("settings.hooks.warningTitle")}</AlertTitle>
          <AlertDescription>
            <p>{t("settings.hooks.warningRoot")}</p>
            <p>{t("settings.hooks.warningFailure")}</p>
            <p>{t("settings.hooks.warningAudit")}</p>
          </AlertDescription>
        </Alert>
      ) : null}
      {configured && !allowed && visible ? (
        <Alert variant="warning" data-slot="hooks-ignored">
          <TriangleAlert />
          <AlertTitle>{t("settings.hooks.ignored.title")}</AlertTitle>
          <AlertDescription>
            <p>{t("settings.hooks.ignored.description")}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-1"
              disabled={disabled || (draft.preHook === "" && draft.postHook === "")}
              onClick={() => {
                set("preHook", "");
                set("postHook", "");
              }}
            >
              {t("settings.hooks.ignored.clear")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {scripts.length > 0 ? (
        <datalist id="settings-hook-scripts">
          {scripts.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      ) : null}
      {field("pre")}
      {field("post")}
      {allowed && visible ? (
        <p className="text-xs text-muted-foreground" data-slot="hooks-step-up">
          {t("settings.hooks.stepUp")}
        </p>
      ) : null}
    </Section>
  );
}

/** What an administrator of the machine runs to allow hooks (commands, not translated). */
function hookCommands(detail: EndpointDetail): string[] {
  if (detail.commands) {
    return [detail.commands.hooksScripts, detail.commands.hooksAny];
  }
  return ["sudo restow-agent hooks scripts", "sudo restow-agent hooks any"];
}

/**
 * What is backed up, when, with which limits, and how long it is kept, as a
 * form. Saving sends only what changed; the machine applies it with its next
 * contact. Below: the ways to take a machine out of Restow.
 */
export function SettingsTab({ detail }: { detail: EndpointDetail }) {
  const { t } = useTranslation("endpoints");
  const format = useEndpointFormat();
  const [draft, setDraft] = useSettingsDraft(detail);
  const update = useUpdateEndpoint(detail.id);
  const identity = useConfirmIdentity();
  const problemText = useProblemText();
  const [attempted, setAttempted] = React.useState(false);
  const [stricter, setStricter] = React.useState<{
    less: Retention;
    patch: NonNullable<ReturnType<typeof buildPatch>>;
  } | null>(null);
  const revoked = detail.status === "revoked";
  const disabled = revoked || update.isPending;
  const profile = detail.profile;
  // A machine in a backup job gets its schedule, folders, exclusions, hooks and bandwidth from the job.
  const managed = detail.job != null;
  // A machine in no job is not backed up; only a job gives it a schedule.
  const withoutBackup = isWithoutBackup(detail);

  const problems = checkDraft(draft, profile, detail.hooks?.policy ?? null);
  const patch = buildPatch(detail, draft);
  const dirty = patch !== null;
  const sections = changedSections(detail, draft);
  const shown = attempted ? problems : {};
  const set = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  // Setting or changing a hook needs a recent sign-in (apps/api lib/recent-sign-in.ts): once the
  // person confirmed it is them, the same change is sent again.
  const submit = (changes: NonNullable<typeof patch>) => {
    update.mutate(changes, {
      onSuccess: (result) => {
        setAttempted(false);
        if (result.changed.length === 0) {
          toast.info(t("settings.toast.unchanged"));
        } else {
          toast.success(t("settings.toast.saved"), {
            description: t("settings.toast.appliedLater"),
          });
        }
      },
      onError: (error) => {
        if (isRecentSignInRequired(error)) {
          identity.ask(() => submit(changes));
        }
      },
    });
  };

  const save = () => {
    setAttempted(true);
    if (!patch || hasProblems(problems)) {
      return;
    }
    // A stricter retention removes restore points for good: say how many, ask first.
    const less = stricterRetention(detail.settings.retention, patch.settings?.retention);
    if (less) {
      setStricter({ less, patch });
      return;
    }
    submit(patch);
  };

  const discard = () => {
    setDraft(draftFromDetail(detail, browserTimeZone()));
    setAttempted(false);
    update.reset();
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[12rem_minmax(0,1fr)]">
      <SettingsAnchors />
      <div className="grid min-w-0 gap-4">
        {revoked ? (
          <Alert variant="warning">
            <TriangleAlert />
            <AlertDescription>
              <p>{t("settings.revokedNote")}</p>
            </AlertDescription>
          </Alert>
        ) : null}

        {detail.job ? (
          <Alert variant="info" data-slot="managed-by-job">
            <ListChecks />
            <AlertTitle>{t("settings.managed.title", { job: detail.job.name })}</AlertTitle>
            <AlertDescription>
              <p>{t("settings.managed.description")}</p>
              <Link
                {...linkProps(jobDefinitionTo(detail.job.id, "endpoint", "settings"))}
                className={buttonVariants({
                  variant: "outline",
                  size: "sm",
                  className: "mt-2 w-fit",
                })}
              >
                {t("settings.managed.open")}
              </Link>
            </AlertDescription>
          </Alert>
        ) : null}

        <form
          className="grid items-start gap-4 xl:grid-cols-2"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <Section id="general" title={t("settings.general.title")}>
            <Field
              id="settings-name"
              label={t("settings.general.name")}
              hint={t("settings.general.nameHint", { hostname: detail.hostname })}
              error={problemText(shown, "displayName")}
            >
              <Input
                id="settings-name"
                value={draft.displayName}
                onChange={(event) => set("displayName", event.target.value)}
                maxLength={LIMITS.displayName + 50}
                disabled={disabled}
                autoComplete="off"
                aria-describedby={messageId("settings-name")}
              />
            </Field>
            {/* Saved on its own, at once: the dialog changes nothing else of the form. */}
            <div className="grid gap-1.5 text-sm" data-slot="settings-assignment">
              <p className="font-medium">{t("settings.general.assignedTo")}</p>
              <AssignmentField endpoint={detail} name={endpointName(detail)} />
              <p className="text-xs text-muted-foreground">{t("settings.general.assignedHint")}</p>
            </div>
          </Section>

          <ReadOnlyGroup
            closed={managed}
            className="grid items-start gap-4 xl:col-span-2 xl:grid-cols-2"
          >
            <Section
              id="files"
              title={t("settings.files.title")}
              description={t("settings.files.description")}
            >
              <PathsEditor
                paths={draft.paths}
                onChange={(paths) => set("paths", paths)}
                disabled={disabled}
                error={problemText(shown, "paths")}
              />
              <Field
                id="settings-excludes"
                label={t("settings.excludes.label")}
                hint={t("settings.excludes.hint")}
                error={problemText(shown, "excludes")}
              >
                <Textarea
                  id="settings-excludes"
                  value={draft.excludes}
                  onChange={(event) => set("excludes", event.target.value)}
                  rows={6}
                  disabled={disabled}
                  spellCheck={false}
                  className="font-mono text-sm"
                  aria-describedby={messageId("settings-excludes")}
                />
              </Field>
            </Section>

            <Section
              id="schedule"
              title={t("settings.schedule.title")}
              description={t(
                withoutBackup
                  ? "settings.schedule.noJobDescription"
                  : "settings.schedule.description",
              )}
            >
              {withoutBackup ? (
                // Backups run only in a backup job (release 0.2.1): the job sets the schedule.
                <WithoutBackupNotice endpoint={detail} />
              ) : (
                <>
                  <Field id="settings-schedule-kind" label={t("settings.schedule.kind")}>
                    <Select
                      value={draft.scheduleKind}
                      onValueChange={(value) => set("scheduleKind", value as ScheduleKind)}
                      disabled={disabled}
                    >
                      <SelectTrigger id="settings-schedule-kind" className="w-full sm:w-80">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SCHEDULE_KINDS.map((kind) => (
                          <SelectItem key={kind} value={kind}>
                            {t(`settings.schedule.kinds.${kind}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>

                  {draft.scheduleKind === "daily" ? (
                    <Field
                      id="settings-time"
                      label={t("settings.schedule.timeOfDay")}
                      error={problemText(shown, "timeOfDay")}
                      hint={t("settings.schedule.timeHint")}
                    >
                      <Input
                        id="settings-time"
                        type="time"
                        value={draft.timeOfDay}
                        onChange={(event) => set("timeOfDay", event.target.value)}
                        disabled={disabled}
                        className="w-40"
                        aria-describedby={messageId("settings-time")}
                      />
                    </Field>
                  ) : (
                    <Field
                      id="settings-interval"
                      label={t(`settings.schedule.minutes.${draft.scheduleKind}`)}
                      error={problemText(shown, "intervalMinutes")}
                      hint={t(`settings.schedule.minutesHint.${draft.scheduleKind}`, {
                        min: LIMITS.intervalMinMinutes,
                        default: DEFAULTS.clientSchedule.intervalMinutes,
                      })}
                    >
                      <NumberInput
                        id="settings-interval"
                        value={draft.intervalMinutes}
                        onChange={(value) => set("intervalMinutes", value)}
                        disabled={disabled}
                        describedBy={messageId("settings-interval")}
                        invalid={Boolean(shown.intervalMinutes)}
                        className="w-40"
                      />
                    </Field>
                  )}

                  <Field
                    id="settings-zone"
                    label={t("settings.schedule.timeZone")}
                    error={problemText(shown, "timeZone")}
                    hint={t("settings.schedule.timeZoneHint")}
                  >
                    <TimezonePicker
                      id="settings-zone"
                      value={draft.timeZone}
                      onChange={(zone) => set("timeZone", zone)}
                      disabled={disabled}
                      describedBy={messageId("settings-zone")}
                    />
                  </Field>
                  <p className="text-xs text-muted-foreground">{t("settings.schedule.defaults")}</p>
                </>
              )}
            </Section>

            <Section
              id="limits"
              title={t("settings.limits.title")}
              description={t("settings.limits.description")}
            >
              <Field
                id="settings-bandwidth"
                label={t("settings.limits.bandwidth")}
                hint={t("settings.limits.bandwidthHint")}
                error={problemText(shown, "bandwidthKbps")}
              >
                <NumberInput
                  id="settings-bandwidth"
                  value={draft.bandwidthKbps}
                  onChange={(value) => set("bandwidthKbps", value)}
                  disabled={disabled}
                  describedBy={messageId("settings-bandwidth")}
                  invalid={Boolean(shown.bandwidthKbps)}
                  placeholder={t("settings.limits.unlimited")}
                  className="w-56"
                />
              </Field>
              <BandwidthWindowsField
                idPrefix="settings-windows"
                rows={draft.bandwidthWindows}
                onChange={(rows) => set("bandwidthWindows", rows)}
                zone={draft.timeZone}
                check={windowCheckOf(draft.bandwidthWindows, attempted)}
                disabled={disabled}
              />
              <div className="flex items-start justify-between gap-4 rounded-md border p-3">
                <div className="space-y-0.5">
                  <label htmlFor="settings-ac" className="text-sm font-medium">
                    {t("settings.limits.acPower")}
                  </label>
                  <p className="text-xs text-muted-foreground">
                    {t("settings.limits.acPowerHint")}
                  </p>
                </div>
                <Switch
                  id="settings-ac"
                  checked={draft.onlyOnAcPower}
                  onCheckedChange={(checked) => set("onlyOnAcPower", checked)}
                  disabled={disabled}
                />
              </div>
            </Section>

            <HooksSection
              detail={detail}
              draft={draft}
              set={set}
              disabled={disabled}
              problems={shown}
              problemText={problemText}
            />
          </ReadOnlyGroup>

          <Section
            id="retention"
            title={t("settings.retention.title")}
            description={t("settings.retention.description")}
          >
            <div className="grid gap-4 sm:grid-cols-3">
              {(["keepDaily", "keepWeekly", "keepMonthly"] as const).map((field) => (
                <Field
                  key={field}
                  id={`settings-${field}`}
                  label={t(`settings.retention.${field}`)}
                  hint={t("settings.retention.default", { count: DEFAULTS.retention[field] })}
                  error={problemText(shown, field)}
                >
                  <NumberInput
                    id={`settings-${field}`}
                    value={draft[field]}
                    onChange={(value) => set(field, value)}
                    disabled={disabled}
                    describedBy={messageId(`settings-${field}`)}
                    invalid={Boolean(shown[field])}
                  />
                </Field>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t("settings.retention.note")}</p>
          </Section>

          <Section
            id="alerts"
            title={t("settings.alerts.title")}
            description={t("settings.alerts.description")}
          >
            {profile === "server" ? (
              <Field
                id="settings-stale-hours"
                label={t("settings.alerts.hours")}
                hint={t("settings.alerts.hoursHint", { count: DEFAULTS.staleAfterHours })}
                error={problemText(shown, "staleAfterHours")}
              >
                <NumberInput
                  id="settings-stale-hours"
                  value={draft.staleAfterHours}
                  onChange={(value) => set("staleAfterHours", value)}
                  disabled={disabled}
                  describedBy={messageId("settings-stale-hours")}
                  invalid={Boolean(shown.staleAfterHours)}
                  className="w-40"
                />
              </Field>
            ) : (
              <Field
                id="settings-stale-days"
                label={t("settings.alerts.days")}
                hint={t("settings.alerts.daysHint", { count: DEFAULTS.staleAfterDays })}
                error={problemText(shown, "staleAfterDays")}
              >
                <NumberInput
                  id="settings-stale-days"
                  value={draft.staleAfterDays}
                  onChange={(value) => set("staleAfterDays", value)}
                  disabled={disabled}
                  describedBy={messageId("settings-stale-days")}
                  invalid={Boolean(shown.staleAfterDays)}
                  className="w-40"
                />
              </Field>
            )}
          </Section>

          <Section
            id="quota"
            title={t("settings.quota.title")}
            description={t("settings.quota.description")}
          >
            <Field
              id="settings-quota"
              label={t("settings.quota.label")}
              hint={
                detail.storage.defaultBudgetBytes === null
                  ? t("settings.quota.hintUnlimited")
                  : t("settings.quota.hintDefault", {
                      size: format.bytes(detail.storage.defaultBudgetBytes),
                    })
              }
              error={problemText(shown, "quotaGib")}
            >
              <NumberInput
                id="settings-quota"
                value={draft.quotaGib}
                onChange={(value) => set("quotaGib", value)}
                disabled={disabled}
                describedBy={messageId("settings-quota")}
                invalid={Boolean(shown.quotaGib)}
                className="w-40"
              />
            </Field>
            {detail.storage.tenantBudgetBytes !== null ? (
              <p className="text-xs text-muted-foreground">
                {t("settings.quota.tenantNote", {
                  size: format.bytes(detail.storage.tenantBudgetBytes),
                })}
              </p>
            ) : null}
          </Section>

          <div
            data-slot="settings-save-bar"
            className="sticky bottom-3 z-10 flex flex-col xl:col-span-2 gap-3 rounded-lg border bg-card/95 p-3 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0 space-y-0.5 text-sm">
              {update.isError ? (
                <p role="alert" className="text-destructive-text">
                  {t(endpointErrorKey(update.error))}
                </p>
              ) : dirty ? (
                <>
                  <p className="font-medium">{t("settings.save.unsaved")}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {sections.map((section) => t(`settings.sections.${section}`)).join(", ")}
                  </p>
                </>
              ) : (
                <p className="text-muted-foreground">{t("settings.save.clean")}</p>
              )}
              {attempted && hasProblems(problems) ? (
                <p role="alert" className="text-xs text-destructive-text">
                  {t("settings.save.fix")}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={discard}
                disabled={!dirty || update.isPending}
              >
                {t("settings.save.discard")}
              </Button>
              <Button type="submit" loading={update.isPending} disabled={!dirty || revoked}>
                {t("settings.save.action")}
              </Button>
            </div>
          </div>
        </form>

        <div className="grid items-start gap-4 xl:grid-cols-2">
          <Anchored id="repository-key">
            <RepositoryKeyCard endpointId={detail.id} />
          </Anchored>
          <Anchored id="danger">
            <DangerZone detail={detail} />
          </Anchored>
        </div>
        <ConfirmDialog
          open={stricter !== null}
          onOpenChange={(next) => {
            if (!next) setStricter(null);
          }}
          title={t("settings.retention.stricter.title")}
          description={
            <>
              <p>{t("settings.retention.stricter.description")}</p>
              <ul className="list-disc pl-5" data-slot="stricter-list">
                {(["keepDaily", "keepWeekly", "keepMonthly"] as const)
                  .filter((field) => (stricter?.less[field] ?? 0) > 0)
                  .map((field) => (
                    <li key={field}>
                      {t(`settings.retention.stricter.${field}`, {
                        count: stricter?.less[field] ?? 0,
                      })}
                    </li>
                  ))}
              </ul>
            </>
          }
          confirmLabel={t("settings.retention.stricter.confirm")}
          destructive
          onConfirm={() => {
            const pending = stricter;
            setStricter(null);
            if (pending) submit(pending.patch);
          }}
        />
        {identity.dialog}
      </div>
    </div>
  );
}
