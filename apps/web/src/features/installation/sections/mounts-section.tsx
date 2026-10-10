import {
  CircleCheck,
  CircleDashed,
  CircleX,
  HardDrive,
  Info,
  LoaderCircle,
  Plus,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { ErrorState } from "@/components/error-state";
import { Field, messageId } from "@/components/forms/field";
import { ConfirmDialog } from "@/components/kit";
import { CopyButton } from "@/components/kit/copy-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { CommandBlock } from "@/features/updates/components/command-block";
import { ProgressBar } from "@/features/updates/progress-bar";
import { formatRelative } from "@/lib/format";
import { isRecentSignInRequired } from "@/lib/recent-sign-in";

import { AccessNote, ReadOnlyGroup, useInstallationAccess } from "../access";
import {
  type MOUNT_STEPS,
  type MountOperation,
  type MountSpec,
  type MountTestResult,
  type MountView,
  type MountsView,
  NFS_VERSIONS,
  type NfsVersion,
  type PendingMount,
  mountUsersOf,
  mountsErrorDetail,
  mountsErrorKey,
  useAddMount,
  useCancelPendingMount,
  useMounts,
  useRemoveMount,
  useTestMount,
  validExportPath,
  validMountName,
  validNfsServer,
} from "./mounts-api";

/**
 * Installation, Mounts: NFS shares as backup storage (docs/MOUNTS.md). The opt-in
 * mounter adds each share as a Docker volume and mounts it into the api and the
 * worker at /mnt/restow/<name>; a storage target of the kind "directory" then points
 * there. Without the mounter the section says how to start it. Adding and removing
 * restart the api and the worker, so the section follows the operation step by step
 * and keeps its last view while the api is away. Owner only; adding and removing ask
 * for a recent sign-in (the identity dialog repeats the action).
 */
export function MountsSection() {
  const { t } = useTranslation("installation");
  const query = useMounts();
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
        title={t("mounts.loadError")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  return <MountsContent view={query.data as MountsView} />;
}

export function MountsContent({ view }: { view: MountsView }) {
  const { t } = useTranslation("installation");
  const access = useInstallationAccess();
  const state = view.state;
  return (
    <div className="space-y-6" data-slot="mounts">
      <p className="text-sm text-muted-foreground">
        {t("mounts.intro", { path: `${view.mountRoot}/<name>` })}
      </p>
      {!view.available || !state ? (
        <UnavailableCard view={view} />
      ) : (
        <>
          <AccessNote block={access.change} level="owner" />
          {!state.capabilities.ready ? (
            <Alert variant="warning" data-slot="mounts-blockers">
              <TriangleAlert />
              <AlertTitle>{t("mounts.blockers.title")}</AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-1 pl-5">
                  {state.capabilities.blockers.map((blocker) => (
                    <li key={blocker.code}>{t(`mounts.blockers.${blocker.code}`)}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}
          {view.pending ? (
            <PendingCard pending={view.pending} closed={access.change !== null} />
          ) : null}
          {state.operation ? <OperationCard operation={state.operation} /> : null}
          <SharesCard
            mounts={state.mounts}
            closed={access.change !== null}
            busy={state.operation?.status === "running" || !state.capabilities.ready}
          />
        </>
      )}
    </div>
  );
}

export function UnavailableCard({ view }: { view: MountsView }) {
  const { t } = useTranslation("installation");
  const { t: tu } = useTranslation("updates");
  if (view.demo) {
    return (
      <Alert variant="info" data-slot="mounts-demo">
        <Info />
        <AlertDescription>{t("mounts.unavailable.demo")}</AlertDescription>
      </Alert>
    );
  }
  return (
    <Card data-slot="mounts-unavailable" data-reason={view.unavailableReason ?? ""}>
      <CardHeader>
        <CardTitle>{t("mounts.unavailable.title")}</CardTitle>
        <CardDescription>{t("mounts.unavailable.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <CommandBlock command={view.enableCommand} copyLabel={tu("commands.copy")} />
        {view.unavailableReason && view.unavailableReason !== "unreachable" ? (
          <p className="text-sm text-muted-foreground">
            {t(`mounts.unavailable.reason.${view.unavailableReason}`)}
          </p>
        ) : null}
        <Alert variant="warning">
          <ShieldAlert />
          <AlertDescription>{t("mounts.unavailable.security")}</AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}

/**
 * An add that waits until no job runs (asked for from the storage form while backups
 * ran), or one the mounter refused when it was its turn: the owner can withdraw it.
 */
export function PendingCard({
  pending,
  closed,
  onCancelled,
}: {
  pending: PendingMount;
  closed: boolean;
  onCancelled?: () => void;
}) {
  const { t, i18n } = useTranslation("installation");
  const { t: tc } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const cancel = useCancelPendingMount();
  const name = pending.mount.name;
  const failure = pending.failure;
  return (
    <Alert
      variant={failure ? "warning" : "info"}
      data-slot="mounts-pending"
      data-failed={failure ? "true" : "false"}
    >
      {failure ? <TriangleAlert /> : <LoaderCircle className="animate-spin" />}
      <AlertTitle>
        {failure ? t("mounts.pending.failedTitle", { name }) : t("mounts.pending.title", { name })}
      </AlertTitle>
      <AlertDescription>
        <div className="space-y-2">
          {failure ? (
            <>
              <p>
                {t(`mounts.errors.rejected.${failure.code ?? "generic"}`, {
                  defaultValue: t("mounts.errors.rejected.generic"),
                })}
              </p>
              {failure.detail ? (
                <p className="break-words font-mono text-xs">{failure.detail}</p>
              ) : null}
            </>
          ) : (
            <p>
              {t("mounts.pending.description", {
                who: pending.requestedBy.label,
                when: formatRelative(pending.requestedAt, language) ?? pending.requestedAt,
              })}
            </p>
          )}
          {cancel.isError ? <ErrorAlert error={cancel.error} /> : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={closed}
            loading={cancel.isPending}
            onClick={() => cancel.mutate(name, { onSuccess: () => onCancelled?.() })}
          >
            {failure ? t("mounts.pending.dismiss") : tc("actions.cancel")}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

function StepIcon({ status }: { status: MountOperation["steps"][number]["status"] }) {
  switch (status) {
    case "done":
      return <CircleCheck className="size-4 text-foreground" aria-hidden="true" />;
    case "running":
      return <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />;
    case "failed":
      return <CircleX className="size-4 text-destructive-text" aria-hidden="true" />;
    default:
      return <CircleDashed className="size-4 text-muted-foreground" aria-hidden="true" />;
  }
}

const STATUS_VARIANT: Record<
  MountOperation["status"],
  "info" | "outline" | "warning" | "destructive"
> = {
  running: "info",
  succeeded: "outline",
  failed: "warning",
  rolled_back: "warning",
  needs_attention: "destructive",
};

/** Share of the whole operation done, in percent (protocol.ts MOUNT_STEP_WEIGHTS). */
const STEP_WEIGHTS: Record<(typeof MOUNT_STEPS)[number], number> = {
  validate: 5,
  probe: 20,
  write: 10,
  apply: 25,
  health: 30,
  cleanup: 10,
};

export function operationPercent(operation: MountOperation): number {
  if (operation.status !== "running") {
    return 100;
  }
  let total = 0;
  for (const step of operation.steps) {
    if (step.status === "done" || step.status === "skipped" || step.status === "failed") {
      total += STEP_WEIGHTS[step.id];
    } else if (step.status === "running") {
      total += STEP_WEIGHTS[step.id] / 2;
    }
  }
  return Math.round(total);
}

export function OperationCard({ operation }: { operation: MountOperation }) {
  const { t, i18n } = useTranslation("installation");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const running = operation.status === "running";
  const restarting =
    running &&
    operation.steps.some(
      (step) => (step.id === "apply" || step.id === "health") && step.status === "running",
    );
  return (
    <Card data-slot="mounts-operation" data-status={operation.status}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {t(`mounts.operation.title.${operation.kind}`, { name: operation.name })}
          <Badge variant={STATUS_VARIANT[operation.status]}>
            {t(`mounts.operation.status.${operation.status}`)}
          </Badge>
        </CardTitle>
        <CardDescription>
          {t("mounts.operation.requestedBy", {
            who: operation.requestedBy.label,
            when: formatRelative(operation.startedAt, language) ?? operation.startedAt,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {running ? (
          <ProgressBar value={operationPercent(operation)} label={t("mounts.operation.progress")} />
        ) : null}
        <ol className="space-y-2 text-sm">
          {operation.steps.map((step) => (
            <li
              key={step.id}
              className="flex items-center gap-2"
              data-slot="mounts-step"
              data-step={step.id}
              data-status={step.status}
            >
              <StepIcon status={step.status} />
              <span className={step.status === "skipped" ? "text-muted-foreground" : undefined}>
                {t(`mounts.steps.${step.id}`)}
              </span>
              <span className="sr-only">{t(`mounts.stepStatus.${step.status}`)}</span>
            </li>
          ))}
        </ol>
        {restarting ? (
          <Alert variant="info">
            <Info />
            <AlertDescription>{t("mounts.operation.restart")}</AlertDescription>
          </Alert>
        ) : null}
        {operation.failure ? (
          <Alert
            variant={operation.status === "needs_attention" ? "destructive" : "warning"}
            data-slot="mounts-failure"
            data-code={operation.failure.code}
          >
            <TriangleAlert />
            <AlertTitle>{t(`mounts.failures.${operation.failure.code}`)}</AlertTitle>
            <AlertDescription>
              <p className="break-words font-mono text-xs">{operation.failure.detail}</p>
              {operation.status === "needs_attention" ? (
                <p className="mt-2">{t("mounts.operation.needsAttention")}</p>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
        {operation.warnings.length > 0 ? (
          <div className="space-y-1 text-sm" data-slot="mounts-warnings">
            <p className="font-medium">{t("mounts.operation.warnings")}</p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              {operation.warnings.map((warning) => (
                <li key={warning} className="break-words">
                  {warning}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {!running ? (
          <p className="text-xs text-muted-foreground">{t("mounts.operation.dismissHint")}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SharesCard({
  mounts,
  closed,
  busy,
}: {
  mounts: MountView[];
  closed: boolean;
  busy: boolean;
}) {
  const { t } = useTranslation("installation");
  const [adding, setAdding] = React.useState(false);
  const [removing, setRemoving] = React.useState<MountView | null>(null);
  return (
    <Card data-slot="mounts-list">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>{t("mounts.list.title")}</CardTitle>
          <CardDescription>{t("mounts.list.description")}</CardDescription>
        </div>
        <Button onClick={() => setAdding(true)} disabled={closed || busy}>
          <Plus aria-hidden="true" />
          {t("mounts.list.add")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {mounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("mounts.list.empty")}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {mounts.map((entry) => (
              <ShareRow
                key={entry.mount.name}
                entry={entry}
                closed={closed}
                busy={busy}
                onRemove={() => setRemoving(entry)}
              />
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">{t("mounts.list.storageHint")}</p>
      </CardContent>
      {adding ? <AddShareDialog open={adding} onOpenChange={setAdding} /> : null}
      {removing ? <RemoveShareDialog entry={removing} onClose={() => setRemoving(null)} /> : null}
    </Card>
  );
}

function ShareRow({
  entry,
  closed,
  busy,
  onRemove,
}: {
  entry: MountView;
  closed: boolean;
  busy: boolean;
  onRemove: () => void;
}) {
  const { t } = useTranslation("installation");
  const test = useTestMount();
  const { mount } = entry;
  return (
    <li className="space-y-3 p-4" data-slot="mounts-share" data-name={mount.name}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            <HardDrive className="size-4 text-muted-foreground" aria-hidden="true" />
            {mount.name}
            <Badge variant="muted">NFS {mount.nfsVersion}</Badge>
            {mount.readOnly ? <Badge variant="outline">{t("mounts.list.readOnly")}</Badge> : null}
          </p>
          <p className="break-all font-mono text-xs text-muted-foreground">
            {mount.server.includes(":") ? `[${mount.server}]` : mount.server}:{mount.export}
          </p>
          <div className="flex items-center gap-1">
            <code className="break-all font-mono text-xs">{entry.path}</code>
            <CopyButton value={entry.path} label={t("mounts.list.copyPath")} />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            loading={test.isPending}
            disabled={closed}
            onClick={() => test.mutate({ name: mount.name })}
          >
            {t("mounts.list.test")}
          </Button>
          <Button variant="outline" size="sm" disabled={closed || busy} onClick={onRemove}>
            {t("mounts.list.remove")}
          </Button>
        </div>
      </div>
      {test.data ? <TestOutcome result={test.data} /> : null}
      {test.isError ? <ErrorAlert error={test.error} /> : null}
    </li>
  );
}

export function TestOutcome({ result }: { result: MountTestResult }) {
  const { t } = useTranslation("installation");
  if (result.ok) {
    return (
      <Alert variant="info" data-slot="mounts-test" data-ok="true">
        <CircleCheck />
        <AlertDescription>
          {t(result.wrote ? "mounts.test.ok" : "mounts.test.okReadOnly")}
        </AlertDescription>
      </Alert>
    );
  }
  const code = result.code ?? "probe.failed";
  return (
    <Alert variant="destructive" data-slot="mounts-test" data-ok="false" data-code={code}>
      <CircleX />
      <AlertTitle>
        {t(`mounts.failures.${code}`, { defaultValue: t("mounts.test.failed") })}
      </AlertTitle>
      {result.detail ? (
        <AlertDescription>
          <p className="break-words font-mono text-xs">
            {t("mounts.test.detail", { detail: result.detail })}
          </p>
        </AlertDescription>
      ) : null}
    </Alert>
  );
}

export function ErrorAlert({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const detail = mountsErrorDetail(error);
  return (
    <Alert variant="destructive" data-slot="mounts-error">
      <TriangleAlert />
      <AlertDescription>
        <p>{t(mountsErrorKey(error))}</p>
        {detail ? <p className="break-words font-mono text-xs">{detail}</p> : null}
      </AlertDescription>
    </Alert>
  );
}

interface FormState {
  name: string;
  server: string;
  export: string;
  nfsVersion: NfsVersion;
  readOnly: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  server: "",
  export: "",
  nfsVersion: "4.1",
  readOnly: false,
};

function specOf(form: FormState): MountSpec {
  return {
    protocol: "nfs",
    name: form.name.trim(),
    server: form.server.trim(),
    export: form.export.trim(),
    nfsVersion: form.nfsVersion,
    readOnly: form.readOnly,
  };
}

function AddShareDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("installation");
  const { t: tc } = useTranslation();
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM);
  const [touched, setTouched] = React.useState(false);
  const add = useAddMount();
  const test = useTestMount();
  const identity = useConfirmIdentity();

  const invalid = {
    name: !validMountName(form.name),
    server: !validNfsServer(form.server),
    export: !validExportPath(form.export),
  };
  const valid = !invalid.name && !invalid.server && !invalid.export;
  const update = (patch: Partial<FormState>) => {
    setForm((current) => ({ ...current, ...patch }));
    test.reset();
  };

  const submit = () => {
    setTouched(true);
    if (!valid || add.isPending) {
      return;
    }
    add.mutate(specOf(form), {
      onSuccess: () => {
        onOpenChange(false);
        toast.success(t("mounts.toast.adding"));
      },
      onError: (error) => {
        if (isRecentSignInRequired(error)) {
          identity.ask(submit);
        }
      },
    });
  };

  const message = (field: keyof typeof invalid) =>
    touched && invalid[field] ? t(`mounts.dialog.invalid.${field}`) : undefined;
  const pending = add.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) {
          return;
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg" data-slot="mounts-add-dialog">
        <DialogHeader>
          <DialogTitle>{t("mounts.dialog.title")}</DialogTitle>
          <DialogDescription>{t("mounts.dialog.description")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field
            id="mount-name"
            label={t("mounts.dialog.name")}
            error={message("name")}
            hint={t("mounts.dialog.nameHint", {
              path: `/mnt/restow/${form.name.trim() || "<name>"}`,
            })}
          >
            <Input
              id="mount-name"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              value={form.name}
              maxLength={32}
              aria-invalid={message("name") !== undefined}
              aria-describedby={messageId("mount-name")}
              onChange={(event) => update({ name: event.target.value.toLowerCase() })}
            />
          </Field>
          <Field
            id="mount-server"
            label={t("mounts.dialog.server")}
            error={message("server")}
            hint={t("mounts.dialog.serverHint")}
          >
            <Input
              id="mount-server"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              placeholder={t("mounts.dialog.serverPlaceholder")}
              value={form.server}
              aria-invalid={message("server") !== undefined}
              aria-describedby={messageId("mount-server")}
              onChange={(event) => update({ server: event.target.value })}
            />
          </Field>
          <Field
            id="mount-export"
            label={t("mounts.dialog.export")}
            error={message("export")}
            hint={t("mounts.dialog.exportHint")}
          >
            <Input
              id="mount-export"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              placeholder={t("mounts.dialog.exportPlaceholder")}
              value={form.export}
              aria-invalid={message("export") !== undefined}
              aria-describedby={messageId("mount-export")}
              onChange={(event) => update({ export: event.target.value })}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="mount-version">{t("mounts.dialog.version")}</Label>
              <Select
                value={form.nfsVersion}
                onValueChange={(value) => update({ nfsVersion: value as NfsVersion })}
              >
                <SelectTrigger id="mount-version" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NFS_VERSIONS.map((version) => (
                    <SelectItem key={version} value={version}>
                      NFS {version}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mount-readonly">{t("mounts.dialog.readOnly")}</Label>
              <div className="flex min-h-9 items-center">
                <Switch
                  id="mount-readonly"
                  checked={form.readOnly}
                  onCheckedChange={(checked) => update({ readOnly: checked })}
                  aria-describedby="mount-readonly-hint"
                />
              </div>
            </div>
          </div>
          <p id="mount-readonly-hint" className="text-xs text-muted-foreground">
            {t("mounts.dialog.readOnlyHint")}
          </p>
          {test.data ? <TestOutcome result={test.data} /> : null}
          {test.isError ? <ErrorAlert error={test.error} /> : null}
          {add.isError && !isRecentSignInRequired(add.error) ? (
            <ErrorAlert error={add.error} />
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              {tc("actions.cancel")}
            </Button>
            <Button
              type="button"
              variant="outline"
              loading={test.isPending}
              disabled={pending}
              onClick={() => {
                setTouched(true);
                if (valid) {
                  test.mutate({ mount: specOf(form) });
                }
              }}
            >
              {test.isPending ? t("mounts.dialog.testing") : t("mounts.dialog.test")}
            </Button>
            <Button type="submit" loading={pending} disabled={test.isPending}>
              {t("mounts.dialog.add")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
      {identity.dialog}
    </Dialog>
  );
}

function RemoveShareDialog({ entry, onClose }: { entry: MountView; onClose: () => void }) {
  const { t } = useTranslation("installation");
  const remove = useRemoveMount();
  const identity = useConfirmIdentity();
  const name = entry.mount.name;

  const run = () => {
    remove.mutate(name, {
      onSuccess: () => {
        onClose();
        toast.success(t("mounts.toast.removing"));
      },
      onError: (error) => {
        if (isRecentSignInRequired(error)) {
          identity.ask(run);
        }
      },
    });
  };

  const users = remove.isError ? mountUsersOf(remove.error) : null;
  const error =
    remove.isError && !isRecentSignInRequired(remove.error) ? (
      <div className="space-y-2">
        <ErrorAlert error={remove.error} />
        {users && users.length > 0 ? (
          <div className="text-sm" data-slot="mounts-users">
            <p>{t("mounts.remove.inUse")}</p>
            <ul className="list-disc pl-5">
              {users.map((user) => (
                <li key={`${user.tenantId ?? ""}:${user.path}`}>
                  {user.kind === "installation_default"
                    ? t("mounts.remove.installationDefault")
                    : `${user.tenantName ?? ""}: ${user.name ?? ""}`}{" "}
                  <code className="font-mono text-xs">{user.path}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    ) : undefined;

  return (
    <>
      <ConfirmDialog
        open
        onOpenChange={(next) => {
          if (!next) {
            onClose();
          }
        }}
        title={t("mounts.remove.title", { name })}
        description={t("mounts.remove.description")}
        confirmLabel={t("mounts.remove.confirm")}
        destructive
        pending={remove.isPending}
        error={error}
        onConfirm={run}
      />
      {identity.dialog}
    </>
  );
}
