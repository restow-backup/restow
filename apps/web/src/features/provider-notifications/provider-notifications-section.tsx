import { Info, Lock, Plus, Send, Trash2, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { HintTooltip, NativeSelect, ReadOnlyGroup } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { useInstallationAccess } from "@/features/installation/access";
import { FeatureLocked } from "@/features/installation/feature-locked";
import {
  groupedRows,
  LEVEL_VARIANT,
} from "@/features/integrations/notifications/matrix-presenters";
import "@/features/integrations/i18n";
import {
  DELIVERY_LEVELS,
  DELIVERY_MODES,
  type DeliveryMode,
  type ReportCadence,
} from "@/features/reports/api";
import { failureReasonKey } from "@/features/reports/presenters";
import "@/features/settings/i18n";
import { ApiError, errorMessageKey } from "@/lib/api";

import { type ProviderRecipientsView, SUMMARY_ENTRIES, type SummaryReport } from "./api";
import {
  useProviderRecipients,
  useSaveProviderRecipients,
  useSummaryReports,
  useTestProviderRecipient,
  useTestSummaryReport,
  useUpdateSummaryReport,
} from "./hooks";
import {
  draftsChanged,
  draftsFrom,
  isFloor,
  lockedEventsOf,
  newDraft,
  type RecipientDraft,
  receives,
  setDelivery,
  toggleEntry,
  toRecipientInputs,
  validateDrafts,
} from "./presenters";

/**
 * Installation › Notifications (0.5.0): who on the provider's side is told what, about every
 * tenant and about the installation itself. The owners of the provider team are always on the
 * list, cannot be removed and always get the critical events and failed deliveries; an owner
 * can make further recipients mandatory, so an alert never ends with nobody. Each recipient
 * chooses per severity whether mail comes at once or in an hourly or daily digest; critical
 * events always come at once. Below the list, the summary reports across tenants (Business).
 *
 * Administrators of the provider team keep the list; only owners mark recipients mandatory, and
 * only owners change the address of a mandatory recipient or remove it.
 */
export function ProviderNotificationsSection() {
  const { t } = useTranslation("settings");
  const query = useProviderRecipients();
  const access = useInstallationAccess();

  if (query.isPending) {
    return <Skeleton className="h-96 w-full" />;
  }
  if (query.isError || !query.data) {
    return (
      <ErrorState
        title={t("providerRecipients.loadError")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  const closed = access.operate !== null;
  return (
    <div className="space-y-6">
      {closed ? (
        <Alert variant="info" data-slot="access-note">
          <Info />
          <AlertDescription>
            {access.operate === "demo"
              ? t("installation:access.demo")
              : t("providerRecipients.readOnly")}
          </AlertDescription>
        </Alert>
      ) : null}
      <ReadOnlyGroup closed={closed} className="space-y-6">
        <RecipientsEditor key={viewStamp(query.data)} view={query.data} readOnly={closed} />
        <SummaryReportsCard readOnly={closed} />
      </ReadOnlyGroup>
    </div>
  );
}

function viewStamp(view: ProviderRecipientsView): string {
  return JSON.stringify(view.recipients.map(({ failure: _failure, ...rest }) => rest));
}

/** The words of a refusal of the list (problem `code`), else the generic sentence. */
function saveErrorText(error: unknown, t: (key: string) => string, tc: (key: string) => string) {
  if (error instanceof ApiError && error.problem) {
    const code = typeof error.problem.code === "string" ? error.problem.code : "";
    if (error.problem.type === "urn:restow:problem:owner-required") {
      return t("providerRecipients.errors.mandatoryOwner");
    }
    if (["owner-required", "duplicate", "invalid-email", "unknown-event"].includes(code)) {
      return t(`providerRecipients.errors.${code}`);
    }
  }
  return tc(errorMessageKey(error));
}

function RecipientsEditor({ view, readOnly }: { view: ProviderRecipientsView; readOnly: boolean }) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const save = useSaveProviderRecipients();
  const [drafts, setDrafts] = React.useState<RecipientDraft[]>(() => draftsFrom(view));
  const [showErrors, setShowErrors] = React.useState(false);
  const errors = validateDrafts(drafts);
  const dirty = draftsChanged(drafts, view);

  const update = (key: string, change: (draft: RecipientDraft) => RecipientDraft) =>
    setDrafts((current) => current.map((draft) => (draft.key === key ? change(draft) : draft)));

  async function onSave() {
    setShowErrors(true);
    if (Object.keys(errors).length > 0) return;
    try {
      await save.mutateAsync(toRecipientInputs(drafts, view.canEditMandatory));
      toast.success(t("providerRecipients.saved"));
    } catch (error) {
      toast.error(saveErrorText(error, t, tc));
    }
  }

  return (
    <>
      <Card data-slot="provider-recipients">
        <CardHeader>
          <CardTitle className="text-base">{t("providerRecipients.title")}</CardTitle>
          <CardDescription>{t("providerRecipients.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {drafts.map((draft, index) => (
            <RecipientRow
              key={draft.key}
              index={index}
              draft={draft}
              error={showErrors ? errors[draft.key] : undefined}
              canEditMandatory={view.canEditMandatory}
              saved={!dirty && draft.id !== null}
              readOnly={readOnly}
              onChange={(change) => update(draft.key, change)}
              onRemove={() =>
                setDrafts((current) => current.filter((candidate) => candidate.key !== draft.key))
              }
            />
          ))}
          <Button
            type="button"
            variant="outline"
            onClick={() => setDrafts((current) => [...current, newDraft()])}
          >
            <Plus aria-hidden="true" />
            {t("providerRecipients.add")}
          </Button>
        </CardContent>
      </Card>

      <ProviderMatrix
        view={view}
        drafts={drafts}
        onToggle={(key, entry, on) =>
          update(key, (draft) => toggleEntry(draft, entry, on, view.floorEvents))
        }
        onDelivery={(key, level, mode) => update(key, (draft) => setDelivery(draft, level, mode))}
      />

      {readOnly ? null : (
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
          {dirty ? (
            <p className="text-xs text-muted-foreground sm:mr-auto" role="status">
              {t("providerRecipients.unsaved")}
            </p>
          ) : null}
          <Button
            type="button"
            variant="outline"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setDrafts(draftsFrom(view));
              setShowErrors(false);
            }}
          >
            {t("providerRecipients.discard")}
          </Button>
          <Button
            type="button"
            disabled={!dirty}
            loading={save.isPending}
            onClick={() => void onSave()}
            data-slot="provider-recipients-save"
          >
            {t("providerRecipients.save")}
          </Button>
        </div>
      )}
    </>
  );
}

function FailureBadge({ failure }: { failure: NonNullable<RecipientDraft["failure"]> }) {
  const { t, i18n } = useTranslation("settings");
  const since = new Date(failure.since).toLocaleString(i18n.resolvedLanguage ?? i18n.language, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <HintTooltip content={t(failureReasonKey("email", failure.reason))}>
      <button
        type="button"
        className="inline-flex rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-slot="recipient-failure"
      >
        <Badge variant="destructive">
          <TriangleAlert aria-hidden="true" />
          {t("providerRecipients.failing", { since })}
        </Badge>
      </button>
    </HintTooltip>
  );
}

function RecipientRow({
  index,
  draft,
  error,
  canEditMandatory,
  saved,
  readOnly,
  onChange,
  onRemove,
}: {
  index: number;
  draft: RecipientDraft;
  error: string | undefined;
  canEditMandatory: boolean;
  /** The row is saved as shown: the test may go out. */
  saved: boolean;
  readOnly: boolean;
  onChange: (change: (draft: RecipientDraft) => RecipientDraft) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const test = useTestProviderRecipient();
  const owner = draft.kind === "owner";
  // A saved mandatory recipient keeps its address and its place unless an owner changes them.
  const lockedMandatory = !owner && draft.mandatory && !canEditMandatory;
  const id = `provider-recipient-${index}`;
  return (
    <div
      className="space-y-3 rounded-md border p-3"
      data-slot="provider-recipient"
      data-kind={draft.kind}
      data-mandatory={draft.mandatory}
    >
      <div className="flex flex-wrap items-center gap-2">
        {owner ? (
          <Badge variant="secondary" data-slot="badge-owner">
            {t("providerRecipients.owner")}
          </Badge>
        ) : null}
        {draft.mandatory && !owner ? (
          <Badge variant="secondary" data-slot="badge-mandatory">
            {t("providerRecipients.mandatory")}
          </Badge>
        ) : null}
        {draft.failure ? <FailureBadge failure={draft.failure} /> : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-email`}>{t("providerRecipients.email")}</Label>
          <Input
            id={`${id}-email`}
            type="email"
            autoComplete="off"
            spellCheck={false}
            value={draft.email}
            // The owners' addresses are their sign-in addresses (Installation › Team).
            disabled={owner || lockedMandatory}
            aria-invalid={error !== undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(event) => {
              const email = event.target.value;
              onChange((current) => ({ ...current, email }));
            }}
          />
          {error ? (
            <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
              {t(error)}
            </p>
          ) : owner ? (
            <p className="text-xs text-muted-foreground">{t("providerRecipients.ownerHint")}</p>
          ) : lockedMandatory ? (
            <p className="text-xs text-muted-foreground" data-slot="mandatory-locked-hint">
              {t("providerRecipients.mandatoryLockedHint")}
            </p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-name`}>{t("providerRecipients.name")}</Label>
          <Input
            id={`${id}-name`}
            value={draft.name}
            maxLength={200}
            onChange={(event) => {
              const name = event.target.value;
              onChange((current) => ({ ...current, name }));
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-language`}>{t("providerRecipients.language")}</Label>
          <NativeSelect
            id={`${id}-language`}
            value={draft.language ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              onChange((current) => ({
                ...current,
                language: value === "de" || value === "en" ? value : null,
              }));
            }}
          >
            <option value="">{t("providerRecipients.languageDefault")}</option>
            <option value="de">{tc("language.de")}</option>
            <option value="en">{tc("language.en")}</option>
          </NativeSelect>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {canEditMandatory && !owner ? (
          <div className="flex items-center gap-2">
            <Switch
              id={`${id}-mandatory`}
              checked={draft.mandatory}
              onCheckedChange={(checked) =>
                onChange((current) => ({ ...current, mandatory: checked }))
              }
              data-slot="mandatory-toggle"
            />
            <Label htmlFor={`${id}-mandatory`} className="font-normal">
              {t("providerRecipients.mandatoryToggle")}
            </Label>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">
            {isFloor(draft) ? t("providerRecipients.floorHint") : ""}
          </span>
        )}
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!saved || readOnly || !draft.id}
            loading={test.isPending}
            title={saved ? undefined : t("providerRecipients.testSaveFirst")}
            onClick={() =>
              draft.id &&
              test.mutate(draft.id, {
                onSuccess: (result) =>
                  toast.success(t("providerRecipients.testSent", { to: result.to })),
                onError: (failure) => toast.error(tc(errorMessageKey(failure))),
              })
            }
          >
            {test.isPending ? null : <Send aria-hidden="true" />}
            {t("providerRecipients.test")}
          </Button>
          {owner || lockedMandatory ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onRemove}
              aria-label={t("providerRecipients.remove", { email: draft.email || "" })}
              data-slot="recipient-remove"
            >
              <Trash2 aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// --- The matrix -----------------------------------------------------------------------------

function columnTitle(draft: RecipientDraft): string {
  return draft.name.trim() || draft.email.trim();
}

function ProviderMatrix({
  view,
  drafts,
  onToggle,
  onDelivery,
}: {
  view: ProviderRecipientsView;
  drafts: readonly RecipientDraft[];
  onToggle: (key: string, entry: string, on: boolean) => void;
  onDelivery: (key: string, level: (typeof DELIVERY_LEVELS)[number], mode: DeliveryMode) => void;
}) {
  const { t } = useTranslation("settings");
  const { t: ti } = useTranslation("integrations");
  const groups = groupedRows(view.events);
  if (drafts.length === 0) {
    return null;
  }
  return (
    <Card data-slot="provider-matrix">
      <CardHeader>
        <CardTitle className="text-base">{t("providerRecipients.matrix.title")}</CardTitle>
        <CardDescription>{t("providerRecipients.matrix.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground" data-slot="critical-note">
          {t("providerRecipients.matrix.criticalNote")}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">{t("providerRecipients.matrix.title")}</caption>
            <thead>
              <tr className="border-b">
                <th scope="col" className="py-2 pr-4 text-left align-bottom font-medium">
                  {ti("matrix.event")}
                </th>
                {drafts.map((draft) => (
                  <th
                    key={draft.key}
                    scope="col"
                    className="min-w-40 px-2 py-2 text-left align-bottom font-normal"
                    data-slot="provider-matrix-column"
                  >
                    <span className="block max-w-40 truncate font-medium" title={draft.email}>
                      {columnTitle(draft) || t("providerRecipients.unnamed")}
                    </span>
                    <span className="mt-1 grid gap-1">
                      {DELIVERY_LEVELS.map((level) => (
                        <span key={level} className="flex items-center gap-1 text-xs">
                          <label
                            htmlFor={`delivery-${draft.key}-${level}`}
                            className="w-16 shrink-0 text-muted-foreground"
                          >
                            {ti(`matrix.levels.${level}`)}
                          </label>
                          <NativeSelect
                            id={`delivery-${draft.key}-${level}`}
                            className="h-7 py-0 text-xs"
                            value={draft.delivery[level]}
                            aria-label={t("providerRecipients.matrix.deliveryFor", {
                              level: ti(`matrix.levels.${level}`),
                              recipient: columnTitle(draft),
                            })}
                            data-slot="delivery-select"
                            data-level={level}
                            onChange={(event) =>
                              onDelivery(draft.key, level, event.target.value as DeliveryMode)
                            }
                          >
                            {DELIVERY_MODES.map((mode) => (
                              <option key={mode} value={mode}>
                                {ti(`matrix.delivery.${mode}`)}
                              </option>
                            ))}
                          </NativeSelect>
                        </span>
                      ))}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            {groups.map(({ group, rows }) => (
              <tbody key={group}>
                <tr>
                  <th
                    scope="colgroup"
                    colSpan={drafts.length + 1}
                    className="pt-4 pb-1 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase"
                  >
                    {ti(`reports:eventGroups.${group}`)}
                  </th>
                </tr>
                {rows.map((row) => (
                  <tr key={row.name} className="border-b border-border/60">
                    <th scope="row" className="py-2 pr-4 text-left font-normal">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span title={ti(`reports:eventHints.${row.name}`)}>
                          {ti(`reports:events.${row.name}`)}
                        </span>
                        <Badge variant={LEVEL_VARIANT[row.level]}>
                          {ti(`matrix.levels.${row.level}`)}
                        </Badge>
                        {row.critical ? (
                          <Badge variant="outline">{ti("matrix.critical")}</Badge>
                        ) : null}
                      </span>
                    </th>
                    {drafts.map((draft) => (
                      <td key={draft.key} className="px-2 py-2">
                        <MatrixCell
                          label={ti("matrix.cell", {
                            event: ti(`reports:events.${row.name}`),
                            channel: columnTitle(draft),
                          })}
                          checked={receives(draft, row.name, view.floorEvents)}
                          locked={(lockedEventsOf(draft, view.floorEvents) as string[]).includes(
                            row.name,
                          )}
                          onChange={(on) => onToggle(draft.key, row.name, on)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            ))}
            <tbody data-slot="provider-matrix-reports">
              <tr>
                <th
                  scope="colgroup"
                  colSpan={drafts.length + 1}
                  className="pt-4 pb-1 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    {t("providerRecipients.matrix.reports")}
                    {view.summaryAvailable ? null : <FeatureLocked feature="reports.timed" />}
                  </span>
                </th>
              </tr>
              {SUMMARY_ENTRIES.map((entry) => {
                const cadence = entry.slice("report.".length);
                return (
                  <tr key={entry} className="border-b border-border/60">
                    <th scope="row" className="py-2 pr-4 text-left font-normal">
                      {ti(`matrix.reports.${cadence}`)}
                    </th>
                    {drafts.map((draft) => (
                      <td key={draft.key} className="px-2 py-2">
                        <Checkbox
                          checked={draft.events.includes(entry)}
                          disabled={!view.summaryAvailable}
                          aria-label={ti("matrix.cell", {
                            event: ti(`matrix.reports.${cadence}`),
                            channel: columnTitle(draft),
                          })}
                          data-slot="summary-cell"
                          onCheckedChange={(checked) =>
                            onToggle(draft.key, entry, checked === true)
                          }
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function MatrixCell({
  label,
  checked,
  locked,
  onChange,
}: {
  label: string;
  checked: boolean;
  locked: boolean;
  onChange: (on: boolean) => void;
}) {
  const { t } = useTranslation("settings");
  if (locked) {
    return (
      <HintTooltip content={t("providerRecipients.matrix.lockedHint")}>
        <span
          className="inline-flex items-center gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the reason has to be reachable by keyboard
          tabIndex={0}
          data-slot="locked-cell"
        >
          <Checkbox checked disabled aria-label={label} tabIndex={-1} />
          <Lock aria-hidden="true" className="size-3 text-muted-foreground" />
        </span>
      </HintTooltip>
    );
  }
  return (
    <Checkbox
      checked={checked}
      aria-label={label}
      onCheckedChange={(value) => onChange(value === true)}
    />
  );
}

// --- Summary reports ------------------------------------------------------------------------

const HOURS: readonly number[] = Array.from({ length: 24 }, (_, hour) => hour);

function SummaryReportsCard({ readOnly }: { readOnly: boolean }) {
  const { t } = useTranslation("settings");
  const query = useSummaryReports();
  return (
    <Card data-slot="summary-reports">
      <CardHeader>
        <CardTitle className="text-base">{t("summaryReports.title")}</CardTitle>
        <CardDescription>{t("summaryReports.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : query.isError || !query.data ? (
          <ErrorState
            title={t("summaryReports.loadError")}
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : !query.data.available ? (
          <FeatureLocked feature="reports.timed" />
        ) : (
          query.data.reports.map((report) => (
            <SummaryReportRow key={report.cadence} report={report} readOnly={readOnly} />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function SummaryReportRow({ report, readOnly }: { report: SummaryReport; readOnly: boolean }) {
  const { t, i18n } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const update = useUpdateSummaryReport();
  const test = useTestSummaryReport();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const id = `summary-${report.cadence}`;
  const change = (patch: Parameters<typeof update.mutate>[0]["patch"]) =>
    update.mutate(
      { cadence: report.cadence as ReportCadence, patch },
      {
        onSuccess: () => toast.success(t("summaryReports.saved")),
        onError: (error) => toast.error(tc(errorMessageKey(error))),
      },
    );
  const when = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(language, { dateStyle: "medium", timeStyle: "short" })
      : t("summaryReports.never");
  return (
    <div
      className="flex flex-col gap-3 rounded-md border p-3 lg:flex-row lg:items-center lg:justify-between"
      data-slot="summary-report"
      data-cadence={report.cadence}
    >
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Switch
            id={`${id}-enabled`}
            checked={report.enabled}
            disabled={readOnly || update.isPending}
            onCheckedChange={(enabled) => change({ enabled })}
          />
          <Label htmlFor={`${id}-enabled`}>{t(`summaryReports.cadences.${report.cadence}`)}</Label>
        </div>
        <p className="text-xs text-muted-foreground">
          {report.recipients.length > 0
            ? t("summaryReports.recipients", {
                count: report.recipients.length,
                list: report.recipients.join(", "),
              })
            : t("summaryReports.noRecipients")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("summaryReports.runs", { next: when(report.nextRunAt), last: when(report.lastRunAt) })}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Switch
            id={`${id}-pdf`}
            checked={report.attachPdf}
            disabled={readOnly || update.isPending}
            onCheckedChange={(attachPdf) => change({ attachPdf })}
          />
          <Label htmlFor={`${id}-pdf`} className="font-normal">
            {t("summaryReports.attachPdf")}
          </Label>
        </div>
        <span className="flex items-center gap-2 text-sm">
          <label htmlFor={`${id}-hour`}>{t("summaryReports.sendHour")}</label>
          <NativeSelect
            id={`${id}-hour`}
            className="h-8 w-24"
            value={String(report.sendHour)}
            disabled={readOnly || update.isPending}
            onChange={(event) => change({ sendHour: Number(event.target.value) })}
          >
            {HOURS.map((hour) => (
              <option key={hour} value={hour}>
                {`${String(hour).padStart(2, "0")}:00`}
              </option>
            ))}
          </NativeSelect>
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={readOnly}
          loading={test.isPending}
          onClick={() =>
            test.mutate(report.cadence as ReportCadence, {
              onSuccess: (result) => toast.success(t("summaryReports.testSent", { to: result.to })),
              onError: (error) => toast.error(tc(errorMessageKey(error))),
            })
          }
        >
          {test.isPending ? null : <Send aria-hidden="true" />}
          {t("summaryReports.test")}
        </Button>
      </div>
    </div>
  );
}
