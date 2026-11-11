import { ShieldAlert, ShieldCheck } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { ErrorState } from "@/components/error-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/format";
import { isRecentSignInRequired } from "@/lib/recent-sign-in";

import { type AccessBlock, AccessNote, blockFor, useInstallationAccess } from "../access";
import {
  endFormReady,
  type RestoreModeView,
  restoreModeErrorKey,
  startFormReady,
  useCheckRestoreMode,
  useEndRestoreMode,
  useImportRestoreModeKeys,
  useRestoreMode,
  useStartRestoreMode,
} from "../restore-mode-api";

/**
 * Installation > Restore mode (docs/STORAGE.md, "Restore mode and progress markers"): after a
 * database dump was restored nothing is deleted until a provider owner has checked the restored
 * database. The page says how and when restore mode began, compares every tenant's storage
 * targets with the database, lists refused deletions, held jobs, key versions found in storage
 * and wrapped keys that differ, and offers the end form (what was checked, what happens to data
 * only storage knows, the typed confirmation, a recent sign-in). Every provider admin reads, an
 * administrator compares again; the owner switches it on, imports keys and ends it.
 */
export function RestoreModeSection() {
  const { t } = useTranslation("installation");
  const query = useRestoreMode();
  if (query.isPending) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (query.isError && !query.data) {
    return (
      <ErrorState
        title={t("restoreMode.loadError")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  return <RestoreModeContent view={query.data} />;
}

export function RestoreModeContent({ view }: { view: RestoreModeView }) {
  const { t, i18n } = useTranslation("installation");
  const access = useInstallationAccess();
  const ownerBlock = blockFor(access, "owner");
  const when = (value: string | null | undefined) => formatDateTime(value, i18n.language) ?? "";
  const active = view.active;
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {active ? (
              <ShieldAlert className="size-5 text-destructive" aria-hidden="true" />
            ) : (
              <ShieldCheck className="size-5 text-muted-foreground" aria-hidden="true" />
            )}
            {active ? t("restoreMode.state.on") : t("restoreMode.state.off")}
          </CardTitle>
          {active ? null : <CardDescription>{t("restoreMode.state.offText")}</CardDescription>}
        </CardHeader>
        {active ? (
          <CardContent className="space-y-1 text-sm">
            <p>{t("restoreMode.state.since", { when: when(active.activatedAt) })}</p>
            <p>{sourceText(t, active.source)}</p>
            <p>{t("restoreMode.state.by", { actor: active.activatedBy.label })}</p>
            {active.reason ? (
              <p>{t("restoreMode.state.reason", { reason: active.reason })}</p>
            ) : null}
            {active.detection ? (
              <p>
                {t("restoreMode.state.detection", {
                  target: active.detection.targetId,
                  tenant: active.detection.tenantId,
                  marker: active.detection.markerSeq ?? "-",
                  db: active.detection.dbSeq,
                })}
              </p>
            ) : null}
            <p className="text-muted-foreground">
              {t("restoreMode.state.holds", { when: when(active.holdJobsBefore) })}
            </p>
          </CardContent>
        ) : null}
      </Card>

      {active ? null : <StartForm block={ownerBlock} />}

      {active ? <ChecklistCard source={active.source} /> : null}

      <TargetsCard view={view} />

      {active ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t("restoreMode.refusals.title")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {view.refusals.length === 0 ? (
                <p className="text-muted-foreground">{t("restoreMode.refusals.empty")}</p>
              ) : (
                <ul className="space-y-1" data-testid="restore-mode-refusals">
                  {view.refusals.map((refusal) => (
                    <li key={`${refusal.pass}:${refusal.tenantId ?? ""}`}>
                      {t("restoreMode.refusals.row", {
                        pass: passText(t, refusal.pass),
                        count: refusal.count,
                        when: when(refusal.lastAt),
                      })}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("restoreMode.jobs.title")}</CardTitle>
              <CardDescription>{t("restoreMode.jobs.hint")}</CardDescription>
            </CardHeader>
            <CardContent className="text-sm">
              {t("restoreMode.jobs.text", {
                held: view.heldJobs.held,
                waiting: view.heldJobs.waiting,
              })}
            </CardContent>
          </Card>
        </>
      ) : null}

      <KeysCard view={view} ownerBlocked={ownerBlock !== null} />

      {active ? (
        ownerBlock ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("restoreMode.end.title")}</CardTitle>
              <CardDescription>{t("restoreMode.end.ownerOnly")}</CardDescription>
            </CardHeader>
            <CardContent>
              <AccessNote block={ownerBlock} level="owner" />
            </CardContent>
          </Card>
        ) : (
          <EndForm view={view} />
        )
      ) : null}

      {view.history.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("restoreMode.history.title")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {view.history.map((entry) => (
                <li key={entry.id}>
                  {t("restoreMode.history.row", {
                    from: when(entry.activatedAt),
                    to: when(entry.endedAt),
                    actor: entry.endedBy?.label ?? "",
                    checked: entry.checked ?? "",
                  })}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/**
 * What to check before ending restore mode, in the order it is worth doing it. A restore from a
 * dump in the setup wizard or with install.sh (source `setup`) brings the whole installation of
 * another server, so the users, the address and the mail settings are on the list as well.
 */
export function ChecklistCard({ source }: { source: string }) {
  const { t } = useTranslation("installation");
  const items = [
    "compare",
    "importKeys",
    "testRestore",
    ...(source === "setup" ? ["users", "address", "mail", "agents", "nodes"] : []),
    "end",
  ];
  return (
    <Card data-testid="restore-mode-checklist">
      <CardHeader>
        <CardTitle>{t("restoreMode.checklist.title")}</CardTitle>
        <CardDescription>{t("restoreMode.checklist.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          {items.map((item) => (
            <li key={item}>{t(`restoreMode.checklist.items.${item}`)}</li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

/**
 * Switching restore mode on by hand. Only the owner may (the API refuses the others); everyone
 * else sees the form closed, with the sentence that says so.
 */
function StartForm({ block }: { block: AccessBlock | null }) {
  const { t } = useTranslation("installation");
  const identity = useConfirmIdentity();
  const start = useStartRestoreMode();
  const [reason, setReason] = React.useState("");
  const submit = () =>
    start.mutate(
      { reason: reason.trim() },
      {
        onError: (error) => {
          if (isRecentSignInRequired(error)) {
            identity.ask(submit);
          }
        },
      },
    );
  const ready = block === null && startFormReady(reason) && !start.isPending;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("restoreMode.start.title")}</CardTitle>
        <CardDescription>{t("restoreMode.start.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <AccessNote block={block} level="owner" />
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) {
              submit();
            }
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="restore-mode-reason">{t("restoreMode.start.reason")}</Label>
            <Input
              id="restore-mode-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              autoComplete="off"
              disabled={block !== null}
            />
          </div>
          {start.isError && !isRecentSignInRequired(start.error) ? (
            <Alert variant="destructive">
              <AlertDescription>{t(restoreModeErrorKey(start.error))}</AlertDescription>
            </Alert>
          ) : null}
          <Button type="submit" variant="destructive" disabled={!ready}>
            {t("restoreMode.start.submit")}
          </Button>
        </form>
        {identity.dialog}
      </CardContent>
    </Card>
  );
}

function TargetsCard({ view }: { view: RestoreModeView }) {
  const { t, i18n } = useTranslation("installation");
  const access = useInstallationAccess();
  const compareBlocked = blockFor(access, "administrator") !== null;
  const check = useCheckRestoreMode();
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>{t("restoreMode.targets.title")}</CardTitle>
          <CardDescription>{t("restoreMode.targets.description")}</CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={compareBlocked || check.isPending}
          onClick={() => check.mutate()}
        >
          {t("restoreMode.targets.check")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {check.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{t(restoreModeErrorKey(check.error))}</AlertDescription>
          </Alert>
        ) : null}
        {view.targets.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("restoreMode.targets.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="restore-mode-targets">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-3 font-medium">{t("restoreMode.targets.tenant")}</th>
                  <th className="py-1 pr-3 font-medium">{t("restoreMode.targets.target")}</th>
                  <th className="py-1 pr-3 font-medium">{t("restoreMode.targets.outcome")}</th>
                  <th className="py-1 pr-3 font-medium">{t("restoreMode.targets.storage")}</th>
                  <th className="py-1 pr-3 font-medium">{t("restoreMode.targets.database")}</th>
                  <th className="py-1 font-medium">{t("restoreMode.targets.checked")}</th>
                </tr>
              </thead>
              <tbody>
                {view.targets.map((target) => (
                  <tr key={`${target.tenantId}:${target.targetId}`} className="border-t">
                    <td className="py-1 pr-3">{target.tenantName ?? target.tenantId}</td>
                    <td className="py-1 pr-3 [overflow-wrap:anywhere]">{target.targetId}</td>
                    <td className="py-1 pr-3">{outcomeText(t, target.outcome)}</td>
                    <td className="py-1 pr-3 tabular-nums">{target.storageMaxSeq ?? "-"}</td>
                    <td className="py-1 pr-3 tabular-nums">{target.dbSeq}</td>
                    <td className="py-1">{formatDateTime(target.checkedAt, i18n.language)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function sourceText(t: (key: string) => string, source: string): string {
  switch (source) {
    case "cli":
      return t("restoreMode.state.sources.cli");
    case "api":
      return t("restoreMode.state.sources.api");
    case "detected":
      return t("restoreMode.state.sources.detected");
    case "setup":
      return t("restoreMode.state.sources.setup");
    default:
      return t("restoreMode.state.sources.other");
  }
}

/** The deletion passes (@restow/core storage/deletion-guard.ts DELETION_PASSES). */
const PASSES = new Set([
  "orphan_sweep",
  "gc_repack",
  "superseded_release",
  "abandoned_checkpoint",
  "job_checkpoint_discard",
  "snapshot_retention",
  "mail_files_cleanup",
  "import_staging",
  "export_reset",
  "archive_retention",
  "file_share_purge",
  "file_share_retention",
  "endpoint_retention",
  "endpoint_removal",
  "pve_retention",
  "pve_reconcile_forget",
  "pve_repository_reset",
  "pve_chain_clear",
  "repository_repair_apply",
  "enrollment_cleanup",
  "progress_marker_prune",
  "repository_copy_retention",
  "storage_target_removal",
  "primary_replacement",
]);

function passText(t: (key: string) => string, pass: string): string {
  return PASSES.has(pass) ? t(`restoreMode.passes.${pass}`) : t("restoreMode.passes.other");
}

function outcomeText(t: (key: string) => string, outcome: string): string {
  switch (outcome) {
    case "ok":
      return t("restoreMode.targets.outcomes.ok");
    case "ahead":
      return t("restoreMode.targets.outcomes.ahead");
    case "unreachable":
      return t("restoreMode.targets.outcomes.unreachable");
    case "foreign":
      return t("restoreMode.targets.outcomes.foreign");
    default:
      return t("restoreMode.targets.outcomes.none");
  }
}

function KeysCard({ view, ownerBlocked }: { view: RestoreModeView; ownerBlocked: boolean }) {
  const { t } = useTranslation("installation");
  const identity = useConfirmIdentity();
  const importKeys = useImportRestoreModeKeys();
  const run = () =>
    importKeys.mutate(undefined, {
      onError: (error) => {
        if (isRecentSignInRequired(error)) {
          identity.ask(run);
        }
      },
    });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("restoreMode.keys.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {view.unknownKeyVersions.length === 0 ? (
          <p className="text-muted-foreground">{t("restoreMode.keys.none")}</p>
        ) : (
          <>
            <ul className="space-y-1">
              {view.unknownKeyVersions.map((entry) => (
                <li key={`${entry.tenantId}:${entry.targetId}`}>
                  {t("restoreMode.keys.unknown", {
                    tenant: entry.tenantId,
                    target: entry.targetId,
                    versions: entry.versions.join(", "),
                  })}
                </li>
              ))}
            </ul>
            <Button disabled={ownerBlocked || importKeys.isPending} onClick={run}>
              {t("restoreMode.keys.import")}
            </Button>
          </>
        )}
        {importKeys.isError && !isRecentSignInRequired(importKeys.error) ? (
          <Alert variant="destructive">
            <AlertDescription>{t(restoreModeErrorKey(importKeys.error))}</AlertDescription>
          </Alert>
        ) : null}
        {importKeys.data ? (
          <p role="status">
            {t("restoreMode.keys.imported", { count: importKeys.data.imported.length })}{" "}
            {importKeys.data.refused.length > 0
              ? t("restoreMode.keys.refused", { count: importKeys.data.refused.length })
              : null}
          </p>
        ) : null}
        {view.keyFindings.length > 0 ? (
          <Alert variant="destructive">
            <AlertTitle>{t("restoreMode.keys.conflicts")}</AlertTitle>
            <AlertDescription>
              <ul className="space-y-1">
                {view.keyFindings.map((finding) => (
                  <li
                    key={`${finding.tenantId}:${finding.targetId}:${finding.keyVersion}:${finding.objectKey ?? ""}`}
                  >
                    {finding.objectKey
                      ? t("restoreMode.keys.passwordConflict", {
                          tenant: finding.tenantId,
                          target: finding.targetId,
                          object: finding.objectKey,
                          kind: finding.kind,
                        })
                      : t("restoreMode.keys.conflict", {
                          tenant: finding.tenantId,
                          target: finding.targetId,
                          version: finding.keyVersion,
                          kind: finding.kind,
                        })}
                  </li>
                ))}
              </ul>
              <p className="mt-2">{t("restoreMode.keys.conflictHint")}</p>
            </AlertDescription>
          </Alert>
        ) : null}
        {identity.dialog}
      </CardContent>
    </Card>
  );
}

function EndForm({ view }: { view: RestoreModeView }) {
  const { t } = useTranslation("installation");
  const identity = useConfirmIdentity();
  const end = useEndRestoreMode();
  const [checked, setChecked] = React.useState("");
  const [confirmation, setConfirmation] = React.useState("");
  const [storageOnlyData, setStorageOnlyData] = React.useState<"keep" | "release">("keep");
  const [accepted, setAccepted] = React.useState<string[]>([]);
  const unreachable = view.targets
    .filter((target) => target.outcome === "unreachable")
    .map((target) => `${target.tenantId}/${target.targetId}`);
  const submit = () =>
    end.mutate(
      {
        checked: checked.trim(),
        confirmation: "END",
        storageOnlyData,
        ...(accepted.length > 0 ? { acceptUnreachable: accepted } : {}),
      },
      {
        onError: (error) => {
          if (isRecentSignInRequired(error)) {
            identity.ask(submit);
          }
        },
      },
    );
  const ready = endFormReady({ checked, confirmation }) && !end.isPending;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("restoreMode.end.title")}</CardTitle>
        <CardDescription>{t("restoreMode.end.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) {
              submit();
            }
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="restore-mode-checked">{t("restoreMode.end.checked")}</Label>
            <Textarea
              id="restore-mode-checked"
              value={checked}
              onChange={(event) => setChecked(event.target.value)}
              rows={3}
              maxLength={2000}
              aria-describedby="restore-mode-checked-hint"
            />
            <p id="restore-mode-checked-hint" className="text-xs text-muted-foreground">
              {t("restoreMode.end.checkedHint")}
            </p>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("restoreMode.end.storageOnly")}</legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="restore-mode-storage-only"
                className="mt-1"
                checked={storageOnlyData === "keep"}
                onChange={() => setStorageOnlyData("keep")}
              />
              <span>
                <span className="font-medium">{t("restoreMode.end.keep")}</span>
                <span className="block text-muted-foreground">{t("restoreMode.end.keepHint")}</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="restore-mode-storage-only"
                className="mt-1"
                checked={storageOnlyData === "release"}
                onChange={() => setStorageOnlyData("release")}
              />
              <span>
                <span className="font-medium">{t("restoreMode.end.release")}</span>
                <span className="block text-muted-foreground">
                  {t("restoreMode.end.releaseHint")}
                </span>
              </span>
            </label>
          </fieldset>
          {unreachable.length > 0 ? (
            <fieldset className="space-y-2">
              <legend className="text-sm">{t("restoreMode.end.unreachable")}</legend>
              {unreachable.map((name) => (
                <label key={name} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={accepted.includes(name)}
                    onChange={(event) =>
                      setAccepted((current) =>
                        event.target.checked
                          ? [...current, name]
                          : current.filter((entry) => entry !== name),
                      )
                    }
                  />
                  <span className="[overflow-wrap:anywhere]">
                    {t("restoreMode.end.accept")}: {name}
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="restore-mode-confirmation">{t("restoreMode.end.confirm")}</Label>
            <Input
              id="restore-mode-confirmation"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              className="max-w-40"
            />
          </div>
          {end.isError && !isRecentSignInRequired(end.error) ? (
            <Alert variant="destructive">
              <AlertDescription>{t(restoreModeErrorKey(end.error))}</AlertDescription>
            </Alert>
          ) : null}
          {end.isSuccess ? <p role="status">{t("restoreMode.end.done")}</p> : null}
          <Button type="submit" variant="destructive" disabled={!ready}>
            {t("restoreMode.end.submit")}
          </Button>
        </form>
        {identity.dialog}
      </CardContent>
    </Card>
  );
}
