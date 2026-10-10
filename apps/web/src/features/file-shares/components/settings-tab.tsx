import { Link, useNavigate } from "@tanstack/react-router";
import { KeyRound, ShieldAlert, TriangleAlert } from "lucide-react";
import * as React from "react";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { Field, messageId } from "@/components/forms/field";
import { ConfirmDialog, CopyButton, StatusBadge } from "@/components/kit";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { setMemberOverrides } from "@/features/backup-jobs/api";
import { ApiError } from "@/lib/api";
import { isRecentSignInRequired } from "@/lib/recent-sign-in";
import { useSession } from "@/lib/session";

import {
  FILE_SHARE_PROBLEMS,
  type FileShareDetail,
  LIMITS,
  NFS_VERSIONS,
  SMB_VERSIONS,
  type UpdateShareInput,
} from "../api.js";
import {
  type ShareFormat,
  usePurgeShare,
  useReactivateShare,
  useRetireShare,
  useRevealRepositoryPassword,
  useSetApproval,
  useSetQuota,
  useShareFormat,
  useUpdateShare,
} from "../hooks.js";
import { fileSharesTo } from "../paths.js";
import {
  type ConnectionDraft,
  checkConnection,
  cleanSubfolder,
  problemType,
  shareErrorKey,
} from "../presenters.js";
import { FolderPicker } from "./folder-picker.js";

export interface SettingsTabProps {
  share: FileShareDetail;
}

/**
 * The settings of a share (docs/FILESHARES.md 12.3): the connection with the password field
 * ("leave empty to keep"), the permissions options and "Allow restore to this share", the
 * private-network approval, the job and its folders, the storage budget, the copy jobs that read
 * from or write to it, the repository password for a restore without the server, and the danger
 * zone (retire, delete the backups).
 */
export function SettingsTab({ share }: SettingsTabProps) {
  const format = useShareFormat();
  return (
    <div className="grid gap-4" data-slot="share-settings">
      <ConnectionCard share={share} format={format} />
      <OptionsCard share={share} format={format} />
      <ApprovalCard share={share} format={format} />
      <JobCard share={share} format={format} />
      <BudgetCard share={share} format={format} />
      <CopyJobsCard share={share} format={format} />
      <RepositoryCard share={share} format={format} />
      <DangerZone share={share} format={format} />
    </div>
  );
}

function draftOf(share: FileShareDetail): ConnectionDraft {
  return {
    protocol: share.protocol,
    server: share.server,
    share: share.shareName ?? "",
    export: share.exportPath ?? "",
    subfolder: share.subfolder,
    account: share.username ?? "",
    domain: share.domain ?? "",
    password: "",
    smbVersion: share.smbVersion ?? "3.1.1",
    seal: share.seal,
    nfsVersion: share.nfsVersion ?? "4.1",
  };
}

/** The fields that differ from the share; the password only when one was typed. */
export function connectionPatch(share: FileShareDetail, draft: ConnectionDraft): UpdateShareInput {
  const patch: UpdateShareInput = {};
  if (draft.server.trim() !== share.server) patch.server = draft.server.trim();
  const subfolder = cleanSubfolder(draft.subfolder);
  if (subfolder !== share.subfolder) patch.subfolder = subfolder;
  if (share.protocol === "smb") {
    if (draft.share.trim() !== (share.shareName ?? "")) patch.share = draft.share.trim();
    if (draft.account.trim() !== (share.username ?? "")) patch.account = draft.account.trim();
    if (draft.domain.trim() !== (share.domain ?? "")) patch.domain = draft.domain.trim() || null;
    if (draft.password !== "") patch.password = draft.password;
    if (draft.smbVersion !== share.smbVersion) patch.smbVersion = draft.smbVersion;
    const seal = draft.smbVersion === "2.1" ? false : draft.seal;
    if (seal !== share.seal) patch.seal = seal;
  } else {
    if (draft.export.trim() !== (share.exportPath ?? "")) patch.export = draft.export.trim();
    if (draft.nfsVersion !== share.nfsVersion) patch.nfsVersion = draft.nfsVersion;
  }
  return patch;
}

function ConnectionCard({ share, format }: { share: FileShareDetail; format: ShareFormat }) {
  const { t } = format;
  const update = useUpdateShare(share.id);
  const [draft, setDraft] = React.useState<ConnectionDraft>(() => draftOf(share));
  const [attempted, setAttempted] = React.useState(false);
  const [confirmMove, setConfirmMove] = React.useState(false);
  const problems = checkConnection(draft, { passwordRequired: false });
  const shown = attempted ? problems : {};
  const patch = connectionPatch(share, draft);
  const changed = Object.keys(patch).length > 0;
  const edit = (next: Partial<ConnectionDraft>) => setDraft((current) => ({ ...current, ...next }));

  const save = (confirmNewLocation = false) => {
    setAttempted(true);
    if (Object.keys(problems).length > 0 || !changed) return;
    update.mutate(confirmNewLocation ? { ...patch, confirmNewLocation: true } : patch, {
      onSuccess: () => {
        toast.success(t("settings.saved"));
        setDraft((current) => ({ ...current, password: "" }));
        setAttempted(false);
      },
      onError: (error) => {
        if (problemType(error) === FILE_SHARE_PROBLEMS.locationChange) {
          setConfirmMove(true);
        }
      },
    });
  };
  const id = (name: string) => `share-settings-${name}`;
  const error =
    update.error && problemType(update.error) !== FILE_SHARE_PROBLEMS.locationChange
      ? update.error
      : null;

  return (
    <Card data-slot="connection-settings">
      <CardHeader>
        <CardTitle className="text-base">{t("settings.connection.title")}</CardTitle>
        <CardDescription>{t("settings.connection.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              id={id("server")}
              label={t("add.fields.server")}
              error={shown.server ? t(`add.errors.${shown.server}`) : undefined}
            >
              <Input
                id={id("server")}
                value={draft.server}
                onChange={(event) => edit({ server: event.target.value })}
                aria-describedby={messageId(id("server"))}
              />
            </Field>
            {share.protocol === "smb" ? (
              <Field
                id={id("share")}
                label={t("add.fields.share")}
                error={shown.share ? t(`add.errors.${shown.share}`) : undefined}
              >
                <Input
                  id={id("share")}
                  value={draft.share}
                  onChange={(event) => edit({ share: event.target.value })}
                  aria-describedby={messageId(id("share"))}
                />
              </Field>
            ) : (
              <Field
                id={id("export")}
                label={t("add.fields.export")}
                error={shown.export ? t(`add.errors.${shown.export}`) : undefined}
              >
                <Input
                  id={id("export")}
                  value={draft.export}
                  onChange={(event) => edit({ export: event.target.value })}
                  aria-describedby={messageId(id("export"))}
                />
              </Field>
            )}
          </div>
          <Field
            id={id("subfolder")}
            label={t("add.fields.subfolder")}
            hint={t("settings.connection.subfolderHint")}
            error={shown.subfolder ? t(`add.errors.${shown.subfolder}`) : undefined}
          >
            <Input
              id={id("subfolder")}
              value={draft.subfolder}
              onChange={(event) => edit({ subfolder: event.target.value })}
              aria-describedby={messageId(id("subfolder"))}
            />
          </Field>
          {share.protocol === "smb" ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  id={id("account")}
                  label={t("add.fields.account")}
                  error={shown.account ? t(`add.errors.${shown.account}`) : undefined}
                >
                  <Input
                    id={id("account")}
                    value={draft.account}
                    onChange={(event) => edit({ account: event.target.value })}
                    aria-describedby={messageId(id("account"))}
                  />
                </Field>
                <Field
                  id={id("domain")}
                  label={t("add.fields.domain")}
                  error={shown.domain ? t(`add.errors.${shown.domain}`) : undefined}
                >
                  <Input
                    id={id("domain")}
                    value={draft.domain}
                    onChange={(event) => edit({ domain: event.target.value })}
                    aria-describedby={messageId(id("domain"))}
                  />
                </Field>
              </div>
              <Field
                id={id("password")}
                label={t("settings.connection.password")}
                hint={t("settings.connection.passwordHint")}
                error={shown.password ? t(`add.errors.${shown.password}`) : undefined}
              >
                <Input
                  id={id("password")}
                  type="password"
                  value={draft.password}
                  autoComplete="new-password"
                  onChange={(event) => edit({ password: event.target.value })}
                  aria-describedby={messageId(id("password"))}
                />
              </Field>
              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium">{t("add.fields.smbVersion")}</legend>
                <RadioGroup
                  value={draft.smbVersion}
                  onValueChange={(value) =>
                    edit({ smbVersion: value as ConnectionDraft["smbVersion"] })
                  }
                  className="flex flex-wrap gap-4"
                >
                  {SMB_VERSIONS.map((version) => (
                    <Label
                      key={version}
                      htmlFor={id(`smb-${version}`)}
                      className="flex items-center gap-2 font-normal"
                    >
                      <RadioGroupItem id={id(`smb-${version}`)} value={version} />
                      {t(`add.smbVersions.${version.replace(/\./g, "_")}`)}
                    </Label>
                  ))}
                </RadioGroup>
              </fieldset>
              <div className="flex items-center gap-3">
                <Switch
                  id={id("seal")}
                  checked={draft.seal}
                  disabled={draft.smbVersion === "2.1"}
                  onCheckedChange={(checked) => edit({ seal: checked === true })}
                />
                <Label htmlFor={id("seal")}>{t("add.fields.seal")}</Label>
              </div>
            </>
          ) : (
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">{t("add.fields.nfsVersion")}</legend>
              <RadioGroup
                value={draft.nfsVersion}
                onValueChange={(value) =>
                  edit({ nfsVersion: value as ConnectionDraft["nfsVersion"] })
                }
                className="flex flex-wrap gap-4"
              >
                {NFS_VERSIONS.map((version) => (
                  <Label
                    key={version}
                    htmlFor={id(`nfs-${version}`)}
                    className="flex items-center gap-2 font-normal"
                  >
                    <RadioGroupItem id={id(`nfs-${version}`)} value={version} />
                    {t("add.nfsVersion", { version })}
                  </Label>
                ))}
              </RadioGroup>
            </fieldset>
          )}
          {error ? (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden="true" />
              <AlertDescription>{t(shareErrorKey(error))}</AlertDescription>
            </Alert>
          ) : null}
          <div>
            <Button
              type="submit"
              disabled={!changed}
              loading={update.isPending}
              data-action="save-connection"
            >
              {t("settings.save")}
            </Button>
          </div>
        </form>
      </CardContent>
      <ConfirmDialog
        open={confirmMove}
        onOpenChange={setConfirmMove}
        title={t("settings.connection.moveTitle")}
        description={<p>{t("settings.connection.moveDescription")}</p>}
        confirmLabel={t("settings.connection.moveConfirm")}
        cancelLabel={t("settings.cancel")}
        onConfirm={() => {
          setConfirmMove(false);
          save(true);
        }}
      />
    </Card>
  );
}

function OptionsCard({ share, format }: { share: FileShareDetail; format: ShareFormat }) {
  const { t } = format;
  const update = useUpdateShare(share.id);
  const set = (patch: UpdateShareInput) =>
    update.mutate(patch, {
      onSuccess: () => toast.success(t("settings.saved")),
      onError: (error) => toast.error(t(shareErrorKey(error))),
    });
  return (
    <Card data-slot="options-settings">
      <CardHeader>
        <CardTitle className="text-base">{t("settings.options.title")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex items-start gap-3">
          <Switch
            id="share-permissions"
            checked={share.permissionsMode === "auto"}
            disabled={update.isPending}
            onCheckedChange={(checked) =>
              set({ permissionsMode: checked === true ? "auto" : "off" })
            }
          />
          <div className="grid gap-0.5">
            <Label htmlFor="share-permissions">{t("add.fields.permissions")}</Label>
            <p className="text-xs text-muted-foreground">{t("add.hints.permissions")}</p>
          </div>
        </div>
        <div className="flex items-start gap-3">
          <Switch
            id="share-reread"
            checked={share.rereadPermissions}
            disabled={update.isPending || share.permissionsMode === "off"}
            onCheckedChange={(checked) => set({ rereadPermissions: checked === true })}
          />
          <div className="grid gap-0.5">
            <Label htmlFor="share-reread">{t("settings.options.reread")}</Label>
            <p className="text-xs text-muted-foreground">{t("settings.options.rereadHint")}</p>
          </div>
        </div>
        <div className="flex items-start gap-3">
          <Switch
            id="share-allow-restore"
            checked={share.allowRestore}
            disabled={update.isPending}
            onCheckedChange={(checked) => set({ allowRestore: checked === true })}
            data-action="allow-restore"
          />
          <div className="grid gap-0.5">
            <Label htmlFor="share-allow-restore">{t("add.fields.allowRestore")}</Label>
            <p className="text-xs text-muted-foreground">{t("add.hints.allowRestore")}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ApprovalCard({ share, format }: { share: FileShareDetail; format: ShareFormat }) {
  const { t } = format;
  const { isProviderAdmin } = useSession();
  const approve = useSetApproval(share.id);
  const approval = share.privateNetworkApproval;
  if (!approval && !isProviderAdmin) {
    return null;
  }
  return (
    <Card data-slot="approval-settings">
      <CardHeader>
        <CardTitle className="text-base">{t("settings.approval.title")}</CardTitle>
        <CardDescription>{t("settings.approval.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        {approval ? (
          <StatusBadge tone="info" icon={ShieldAlert}>
            {t("settings.approval.approved", {
              range: approval.range,
              by: approval.by,
              time: format.dateTime(approval.at) ?? "",
            })}
          </StatusBadge>
        ) : (
          <span className="text-sm text-muted-foreground">{t("settings.approval.none")}</span>
        )}
        {isProviderAdmin ? (
          <Button
            variant="outline"
            size="sm"
            loading={approve.isPending}
            onClick={() =>
              approve.mutate(!approval, {
                onError: (error) => toast.error(t(shareErrorKey(error))),
              })
            }
            data-action={approval ? "withdraw-approval" : "approve"}
          >
            {approval ? t("settings.approval.withdraw") : t("settings.approval.approve")}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function JobCard({ share, format }: { share: FileShareDetail; format: ShareFormat }) {
  const { t } = format;
  const [editing, setEditing] = React.useState(false);
  const [includes, setIncludes] = React.useState<string[]>(share.includes);
  const [saving, setSaving] = React.useState(false);
  const save = async () => {
    if (!share.job) return;
    setSaving(true);
    try {
      await setMemberOverrides(share.job.id, share.id, includes.length > 0 ? { includes } : {});
      toast.success(t("settings.saved"));
      setEditing(false);
    } catch (error) {
      toast.error(t(shareErrorKey(error)));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card data-slot="job-settings">
      <CardHeader>
        <CardTitle className="text-base">{t("settings.job.title")}</CardTitle>
        <CardDescription>{t("settings.job.description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {share.job ? (
          <>
            <p className="text-sm">
              <Link
                to={`/jobs/definitions/${encodeURIComponent(share.job.id)}` as never}
                search={{ type: "share" } as never}
                className="font-medium hover:underline"
              >
                {share.job.name}
              </Link>
              {share.job.enabled ? null : (
                <Badge variant="outline" className="ml-2">
                  {t("settings.job.paused")}
                </Badge>
              )}
            </p>
            <p className="text-sm">
              {t("settings.job.folders")}:{" "}
              {share.includes.length > 0
                ? share.includes.join(", ")
                : t("overview.protection.everything")}
            </p>
            {editing ? (
              <div className="grid gap-2">
                <FolderPicker
                  shareId={share.id}
                  mode="many"
                  value={includes}
                  onChange={setIncludes}
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => void save()}
                    loading={saving}
                    data-action="save-folders"
                  >
                    {t("settings.save")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                    {t("settings.cancel")}
                  </Button>
                </div>
              </div>
            ) : (
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setEditing(true)}
                  data-action="pick-folders"
                >
                  {t("settings.job.pickFolders")}
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">{t("settings.job.none")}</span>
            <Button size="sm" variant="outline" asChild>
              <Link
                to={"/jobs" as never}
                search={{ type: "share", new: 1, select: share.id } as never}
              >
                {t("settings.job.newJob")}
              </Link>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BudgetCard({ share, format }: { share: FileShareDetail; format: ShareFormat }) {
  const { t } = format;
  const { isProviderAdmin, providerRole } = useSession();
  const mayEdit = isProviderAdmin && providerRole !== "technician" && providerRole !== "read_only";
  const quota = useSetQuota(share.id);
  const [limited, setLimited] = React.useState(share.quotaGib !== null);
  const [value, setValue] = React.useState(share.quotaGib ? String(share.quotaGib) : "");
  const parsed = /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
  const invalid = limited && (parsed === null || parsed < 1 || parsed > LIMITS.quotaGibMax);
  return (
    <Card data-slot="budget-settings">
      <CardHeader>
        <CardTitle className="text-base">{t("settings.budget.title")}</CardTitle>
        <CardDescription>{t("settings.budget.description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-sm" data-slot="budget-use">
          {share.quota.usedBytes === null
            ? t("overview.repository.notMeasured")
            : share.quota.quotaGib
              ? t("overview.repository.usedOf", {
                  used: format.bytes(share.quota.usedBytes),
                  budget: format.bytes(share.quota.quotaGib * 1024 ** 3),
                })
              : t("settings.budget.noLimitUsed", { used: format.bytes(share.quota.usedBytes) })}
        </p>
        {mayEdit ? (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (invalid) return;
              quota.mutate(limited ? parsed : null, {
                onSuccess: () => toast.success(t("settings.saved")),
                onError: (error) => toast.error(t(shareErrorKey(error))),
              });
            }}
          >
            <div className="flex items-center gap-2">
              <Switch
                id="share-budget-on"
                checked={limited}
                onCheckedChange={(checked) => setLimited(checked === true)}
              />
              <Label htmlFor="share-budget-on">{t("settings.budget.limit")}</Label>
            </div>
            {limited ? (
              <Field
                id="share-budget"
                label={t("settings.budget.gib")}
                error={invalid && value ? t("settings.budget.invalid") : undefined}
              >
                <Input
                  id="share-budget"
                  inputMode="numeric"
                  className="w-32"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  aria-describedby={messageId("share-budget")}
                />
              </Field>
            ) : null}
            <Button
              type="submit"
              size="sm"
              loading={quota.isPending}
              disabled={invalid}
              data-action="save-budget"
            >
              {t("settings.save")}
            </Button>
          </form>
        ) : (
          <p className="text-xs text-muted-foreground">{t("settings.budget.providerOnly")}</p>
        )}
      </CardContent>
    </Card>
  );
}

function CopyJobsCard({ share, format }: { share: FileShareDetail; format: ShareFormat }) {
  const { t } = format;
  return (
    <Card data-slot="copy-jobs">
      <CardHeader>
        <CardTitle className="text-base">{t("settings.copies.title")}</CardTitle>
        <CardDescription>{t("copy.notBackup")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {share.copyJobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("settings.copies.none")}</p>
        ) : (
          <ul className="divide-y rounded-md border text-sm">
            {share.copyJobs.map((job) => (
              <li
                key={job.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <Link
                  to={`/jobs/definitions/${encodeURIComponent(job.id)}` as never}
                  search={{ type: "copy" } as never}
                  className="font-medium hover:underline"
                >
                  {job.name}
                </Link>
                <span className="text-xs text-muted-foreground">
                  {t(`settings.copies.${job.role}`)} · {t(`copy.modes.${job.mode}`)}
                  {job.targetFolder ? ` · ${job.targetFolder}` : ""}
                  {job.enabled ? "" : ` · ${t("settings.job.paused")}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div>
          <Button size="sm" variant="outline" asChild>
            <Link
              to={"/jobs" as never}
              search={{ type: "copy", new: 1, source: share.id } as never}
            >
              {t("settings.copies.new")}
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RepositoryCard({ share, format }: { share: FileShareDetail; format: ShareFormat }) {
  const { t } = format;
  const reveal = useRevealRepositoryPassword(share.id);
  const identity = useConfirmIdentity();
  const [open, setOpen] = React.useState(false);
  const show = () =>
    reveal.mutate(undefined, {
      onError: (error) => {
        if (isRecentSignInRequired(error)) {
          identity.ask(show);
        }
      },
    });
  return (
    <Card data-slot="repository-key">
      <CardHeader>
        <CardTitle className="text-base">{t("settings.repository.title")}</CardTitle>
        <CardDescription>{t("settings.repository.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          variant="outline"
          size="sm"
          disabled={!share.repository.readyAt}
          onClick={() => {
            reveal.reset();
            setOpen(true);
          }}
          data-action="show-repository-password"
        >
          <KeyRound aria-hidden="true" />
          {t("settings.repository.show")}
        </Button>
        {!share.repository.readyAt ? (
          <p className="mt-2 text-xs text-muted-foreground">{t("settings.repository.notYet")}</p>
        ) : null}
      </CardContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-w-xl"
          onInteractOutside={(event) => reveal.data && event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>{t("settings.repository.dialogTitle")}</DialogTitle>
            <DialogDescription>{t("settings.repository.dialogDescription")}</DialogDescription>
          </DialogHeader>
          {reveal.data ? (
            <div className="grid gap-3" data-slot="repository-password">
              <div className="flex items-start gap-2 rounded-md border bg-muted/50 p-3">
                <code className="min-w-0 flex-1 font-mono text-xs [overflow-wrap:anywhere]">
                  {reveal.data.password}
                </code>
                <CopyButton value={reveal.data.password} label={t("settings.repository.copy")} />
              </div>
              <p className="text-xs text-muted-foreground">
                {t("settings.repository.prefix", { prefix: reveal.data.storagePrefix })}
              </p>
            </div>
          ) : (
            <Alert variant="warning">
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>{t("settings.repository.warningTitle")}</AlertTitle>
              <AlertDescription>{t("settings.repository.warning")}</AlertDescription>
            </Alert>
          )}
          {reveal.isError && !isRecentSignInRequired(reveal.error) ? (
            <Alert variant="destructive">
              <AlertDescription>{t(shareErrorKey(reveal.error))}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {reveal.data ? t("settings.repository.hide") : t("settings.cancel")}
            </Button>
            {reveal.data ? null : (
              <Button onClick={show} loading={reveal.isPending} data-action="confirm-show-password">
                {t("settings.repository.confirm")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {identity.dialog}
    </Card>
  );
}

function DangerZone({ share, format }: { share: FileShareDetail; format: ShareFormat }) {
  const { t } = format;
  const navigate = useNavigate();
  const retire = useRetireShare(share.id);
  const reactivate = useReactivateShare(share.id);
  const purge = usePurgeShare(share.id);
  const identity = useConfirmIdentity();
  const [deleting, setDeleting] = React.useState(false);
  const [typed, setTyped] = React.useState("");
  const retired = share.retiredAt !== null;
  const doPurge = () =>
    purge.mutate(typed, {
      onSuccess: () => {
        toast.success(t("settings.danger.purged", { name: share.name }));
        setDeleting(false);
        void navigate({ ...(fileSharesTo() as { to: never }) });
      },
      onError: (error) => {
        if (isRecentSignInRequired(error)) {
          identity.ask(doPurge);
        }
      },
    });
  return (
    <Card className="border-destructive/40" data-slot="danger-zone">
      <CardHeader>
        <CardTitle className="text-base">{t("settings.danger.title")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm">
            {retired ? t("settings.danger.retiredNote") : t("settings.danger.retireNote")}
          </p>
          {retired ? (
            <Button
              variant="outline"
              onClick={() => reactivate.mutate()}
              loading={reactivate.isPending}
              data-action="reactivate"
            >
              {t("settings.danger.reactivate")}
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => retire.mutate()}
              loading={retire.isPending}
              data-action="retire"
            >
              {t("settings.danger.retire")}
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm">{t("settings.danger.deleteNote")}</p>
          <Button
            variant="destructive"
            onClick={() => {
              setTyped("");
              purge.reset();
              setDeleting(true);
            }}
            data-action="delete-backups"
          >
            {t("settings.danger.delete")}
          </Button>
        </div>
      </CardContent>
      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("settings.danger.deleteTitle", { name: share.name })}</DialogTitle>
            <DialogDescription>{t("settings.danger.deleteDescription")}</DialogDescription>
          </DialogHeader>
          <Field
            id="share-confirm-name"
            label={t("settings.danger.typeName", { name: share.name })}
          >
            <Input
              id="share-confirm-name"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
            />
          </Field>
          {purge.isError && !isRecentSignInRequired(purge.error) ? (
            <Alert variant="destructive">
              <AlertDescription>
                {purge.error instanceof ApiError
                  ? t(shareErrorKey(purge.error))
                  : t("errors.generic")}
              </AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(false)}>
              {t("settings.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={typed.trim() !== share.name}
              loading={purge.isPending}
              onClick={doPurge}
              data-action="confirm-delete"
            >
              {t("settings.danger.deleteConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {identity.dialog}
    </Card>
  );
}
