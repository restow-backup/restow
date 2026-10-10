import { Link } from "@tanstack/react-router";
import { CircleCheck, File, Folder, Info, ShieldAlert, TriangleAlert } from "lucide-react";
import * as React from "react";

import { Field, messageId } from "@/components/forms/field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { addJobMembers, backupJobKeys } from "@/features/backup-jobs/api";
import { useBackupJobs } from "@/features/backup-jobs/hooks";
import { FailureExplanation } from "@/features/failures";
import { useSession } from "@/lib/session";
import { useQueryClient } from "@tanstack/react-query";

import {
  type FileShareDetail,
  NFS_VERSIONS,
  SMB_VERSIONS,
  type ShareProtocol,
  type ShareTestResult,
  fileShareKeys,
} from "../api.js";
import {
  useCreateShare,
  useShareFormat,
  useShareSettings,
  useTenantScope,
  useTestConnection,
} from "../hooks.js";
import { fileShareTo, linkTo } from "../paths.js";
import {
  type ConnectionDraft,
  checkConnection,
  connectionInputOf,
  locationOfDraft,
  looksPrivate,
  newConnectionDraft,
  permissionLevel,
  problemField,
  shareErrorKey,
  suggestedName,
} from "../presenters.js";
import { FolderPicker } from "./folder-picker.js";

type Step = "protocol" | "connection" | "test" | "options" | "job";
const STEPS: readonly Step[] = ["protocol", "connection", "test", "options"];

export interface AddShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The share was saved (the page may go to it). */
  onAdded?: (share: FileShareDetail) => void;
}

/**
 * Adding a file share (docs/FILESHARES.md 12.2), in four steps, everything checked live:
 * the protocol, the connection (a private address shows who has to approve it), the connection
 * test through a runner (the top level of the share, whether permissions can be read and
 * through which level, or the classified error with its first step; a folder of the top level
 * can be taken as the subfolder), and the options (name, permissions, "Allow restore to this
 * share"). After saving, the share can join a backup job with the folders picked from the live
 * share. Saving without a successful test is possible (a server that is down tonight) but asks
 * once.
 */
export function AddShareDialog({ open, onOpenChange, onAdded }: AddShareDialogProps) {
  const { t } = useShareFormat();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-slot="add-share-dialog">
        <DialogHeader>
          <DialogTitle>{t("add.title")}</DialogTitle>
          <DialogDescription>{t("add.description")}</DialogDescription>
        </DialogHeader>
        {open ? <AddShareWizard onClose={() => onOpenChange(false)} onAdded={onAdded} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function AddShareWizard({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded?: (share: FileShareDetail) => void;
}) {
  const format = useShareFormat();
  const { t } = format;
  const { isProviderAdmin } = useSession();
  const settings = useShareSettings();
  const [step, setStep] = React.useState<Step>("protocol");
  const [draft, setDraft] = React.useState<ConnectionDraft>(() => newConnectionDraft("smb"));
  const [attempted, setAttempted] = React.useState(false);
  const [name, setName] = React.useState("");
  const [permissions, setPermissions] = React.useState(true);
  const [allowRestore, setAllowRestore] = React.useState(false);
  const [untestedConfirmed, setUntestedConfirmed] = React.useState(false);
  const [saved, setSaved] = React.useState<FileShareDetail | null>(null);
  const test = useTestConnection();
  const create = useCreateShare();
  const formId = React.useId();
  const ids = (key: string) => `${formId}-${key}`;

  const problems = checkConnection(draft);
  const shown = attempted ? problems : {};
  const privateNotice = looksPrivate(draft.server) && draft.server.trim() !== "";
  const privateBlocked =
    privateNotice &&
    !isProviderAdmin &&
    settings.data?.tenantsMayUsePrivateNetworks !== true &&
    /^[\d.]+$|:/.test(draft.server.trim());
  const tested: ShareTestResult | undefined = test.data;
  const testedOk = tested?.ok === true;

  const edit = (patch: Partial<ConnectionDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    // A change of the connection makes the last test say nothing about it.
    test.reset();
    setUntestedConfirmed(false);
  };

  const runTest = () => {
    setAttempted(true);
    if (Object.keys(problems).length > 0) {
      return;
    }
    test.mutate(connectionInputOf(draft));
  };

  const save = () => {
    const input = connectionInputOf(draft);
    create.mutate(
      {
        ...input,
        name: name.trim() || suggestedName(draft),
        allowRestore,
        permissionsMode: permissions ? "auto" : "off",
      },
      {
        onSuccess: (share) => {
          toast.success(t("add.saved", { name: share.name }));
          setSaved(share);
          setStep("job");
          onAdded?.(share);
        },
      },
    );
  };

  const index = STEPS.indexOf(step);
  const serverError = create.error;
  const serverField = problemField(serverError);

  return (
    <div className="grid gap-4" data-step={step}>
      {step !== "job" ? (
        <ol className="flex flex-wrap gap-2 text-xs" aria-label={t("add.steps.label")}>
          {STEPS.map((item, position) => (
            <li
              key={item}
              aria-current={item === step ? "step" : undefined}
              className={
                item === step
                  ? "rounded-full bg-primary px-2 py-0.5 text-primary-foreground"
                  : position < index
                    ? "rounded-full bg-muted px-2 py-0.5"
                    : "rounded-full border px-2 py-0.5 text-muted-foreground"
              }
            >
              {position + 1}. {t(`add.steps.${item}`)}
            </li>
          ))}
        </ol>
      ) : null}

      {step === "protocol" ? (
        <RadioGroup
          value={draft.protocol}
          onValueChange={(value) => edit({ protocol: value as ShareProtocol })}
          aria-label={t("add.protocol.label")}
          className="grid gap-3 sm:grid-cols-2"
        >
          {(["smb", "nfs"] as const).map((protocol) => (
            <Label
              key={protocol}
              htmlFor={ids(`protocol-${protocol}`)}
              className="flex cursor-pointer items-start gap-3 rounded-md border p-4 has-[[data-state=checked]]:border-primary"
            >
              <RadioGroupItem id={ids(`protocol-${protocol}`)} value={protocol} />
              <span className="grid gap-1">
                <span className="font-medium">{t(`add.protocol.${protocol}.title`)}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {t(`add.protocol.${protocol}.description`)}
                </span>
              </span>
            </Label>
          ))}
        </RadioGroup>
      ) : null}

      {step === "connection" ? (
        <div className="grid gap-3">
          <Field
            id={ids("server")}
            label={t("add.fields.server")}
            hint={t("add.hints.server")}
            error={shown.server ? t(`add.errors.${shown.server}`) : undefined}
          >
            <Input
              id={ids("server")}
              value={draft.server}
              onChange={(event) => edit({ server: event.target.value })}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={Boolean(shown.server)}
              aria-describedby={messageId(ids("server"))}
            />
          </Field>
          {draft.protocol === "smb" ? (
            <Field
              id={ids("share")}
              label={t("add.fields.share")}
              hint={t("add.hints.share")}
              error={shown.share ? t(`add.errors.${shown.share}`) : undefined}
            >
              <Input
                id={ids("share")}
                value={draft.share}
                onChange={(event) => edit({ share: event.target.value })}
                autoComplete="off"
                aria-invalid={Boolean(shown.share)}
                aria-describedby={messageId(ids("share"))}
              />
            </Field>
          ) : (
            <Field
              id={ids("export")}
              label={t("add.fields.export")}
              hint={t("add.hints.export")}
              error={shown.export ? t(`add.errors.${shown.export}`) : undefined}
            >
              <Input
                id={ids("export")}
                value={draft.export}
                onChange={(event) => edit({ export: event.target.value })}
                autoComplete="off"
                className="font-mono"
                aria-invalid={Boolean(shown.export)}
                aria-describedby={messageId(ids("export"))}
              />
            </Field>
          )}
          <Field
            id={ids("subfolder")}
            label={t("add.fields.subfolder")}
            hint={t("add.hints.subfolder")}
            error={shown.subfolder ? t(`add.errors.${shown.subfolder}`) : undefined}
          >
            <Input
              id={ids("subfolder")}
              value={draft.subfolder}
              onChange={(event) => edit({ subfolder: event.target.value })}
              autoComplete="off"
              aria-invalid={Boolean(shown.subfolder)}
              aria-describedby={messageId(ids("subfolder"))}
            />
          </Field>
          {draft.protocol === "smb" ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  id={ids("account")}
                  label={t("add.fields.account")}
                  hint={t("add.hints.account")}
                  error={shown.account ? t(`add.errors.${shown.account}`) : undefined}
                >
                  <Input
                    id={ids("account")}
                    value={draft.account}
                    onChange={(event) => edit({ account: event.target.value })}
                    autoComplete="off"
                    aria-invalid={Boolean(shown.account)}
                    aria-describedby={messageId(ids("account"))}
                  />
                </Field>
                <Field
                  id={ids("domain")}
                  label={t("add.fields.domain")}
                  hint={t("add.hints.domain")}
                  error={shown.domain ? t(`add.errors.${shown.domain}`) : undefined}
                >
                  <Input
                    id={ids("domain")}
                    value={draft.domain}
                    onChange={(event) => edit({ domain: event.target.value })}
                    autoComplete="off"
                    aria-describedby={messageId(ids("domain"))}
                  />
                </Field>
              </div>
              <Field
                id={ids("password")}
                label={t("add.fields.password")}
                error={shown.password ? t(`add.errors.${shown.password}`) : undefined}
              >
                <Input
                  id={ids("password")}
                  type="password"
                  value={draft.password}
                  onChange={(event) => edit({ password: event.target.value })}
                  autoComplete="new-password"
                  aria-invalid={Boolean(shown.password)}
                  aria-describedby={messageId(ids("password"))}
                />
              </Field>
              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium">{t("add.fields.smbVersion")}</legend>
                <RadioGroup
                  value={draft.smbVersion}
                  onValueChange={(value) =>
                    edit({
                      smbVersion: value as ConnectionDraft["smbVersion"],
                      ...(value === "2.1" ? { seal: false } : {}),
                    })
                  }
                  className="flex flex-wrap gap-4"
                >
                  {SMB_VERSIONS.map((version) => (
                    <Label
                      key={version}
                      htmlFor={ids(`smb-${version}`)}
                      className="flex items-center gap-2 font-normal"
                    >
                      <RadioGroupItem id={ids(`smb-${version}`)} value={version} />
                      {t(`add.smbVersions.${version.replace(/\./g, "_")}`)}
                    </Label>
                  ))}
                </RadioGroup>
              </fieldset>
              <div className="flex items-start gap-3">
                <Switch
                  id={ids("seal")}
                  checked={draft.seal}
                  disabled={draft.smbVersion === "2.1"}
                  onCheckedChange={(checked) => edit({ seal: checked === true })}
                />
                <div className="grid gap-0.5">
                  <Label htmlFor={ids("seal")}>{t("add.fields.seal")}</Label>
                  <p className="text-xs text-muted-foreground">{t("add.hints.seal")}</p>
                </div>
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
                    htmlFor={ids(`nfs-${version}`)}
                    className="flex items-center gap-2 font-normal"
                  >
                    <RadioGroupItem id={ids(`nfs-${version}`)} value={version} />
                    {t("add.nfsVersion", { version })}
                  </Label>
                ))}
              </RadioGroup>
            </fieldset>
          )}
          {privateNotice ? (
            <Alert variant={privateBlocked ? "warning" : "info"} data-slot="private-network-notice">
              <ShieldAlert aria-hidden="true" />
              <AlertTitle>{t("add.private.title")}</AlertTitle>
              <AlertDescription>
                <p>
                  {isProviderAdmin
                    ? t("add.private.provider")
                    : settings.data?.tenantsMayUsePrivateNetworks
                      ? t("add.private.allowed")
                      : t("add.private.tenant")}
                </p>
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      ) : null}

      {step === "test" ? (
        <TestStep
          location={locationOfDraft(draft)}
          result={tested}
          pending={test.isPending}
          error={test.error}
          onTest={runTest}
          subfolder={draft.subfolder}
          onPickFolder={(folder) => {
            setDraft((current) => ({
              ...current,
              subfolder: current.subfolder
                ? `${current.subfolder.replace(/\/+$/, "")}/${folder}`
                : folder,
            }));
            test.reset();
          }}
        />
      ) : null}

      {step === "options" ? (
        <div className="grid gap-4">
          <Field
            id={ids("name")}
            label={t("add.fields.name")}
            hint={t("add.hints.name")}
            error={serverField === "name" ? t(shareErrorKey(serverError)) : undefined}
          >
            <Input
              id={ids("name")}
              value={name}
              placeholder={suggestedName(draft)}
              onChange={(event) => setName(event.target.value)}
              aria-describedby={messageId(ids("name"))}
            />
          </Field>
          <div className="flex items-start gap-3">
            <Switch
              id={ids("permissions")}
              checked={permissions}
              onCheckedChange={(checked) => setPermissions(checked === true)}
            />
            <div className="grid gap-0.5">
              <Label htmlFor={ids("permissions")}>{t("add.fields.permissions")}</Label>
              <p className="text-xs text-muted-foreground">{t("add.hints.permissions")}</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Switch
              id={ids("allowRestore")}
              checked={allowRestore}
              onCheckedChange={(checked) => setAllowRestore(checked === true)}
            />
            <div className="grid gap-0.5">
              <Label htmlFor={ids("allowRestore")}>{t("add.fields.allowRestore")}</Label>
              <p className="text-xs text-muted-foreground">{t("add.hints.allowRestore")}</p>
            </div>
          </div>
          {!testedOk ? (
            <Alert variant="warning" data-slot="untested-notice">
              <TriangleAlert aria-hidden="true" />
              <AlertDescription className="space-y-2">
                <p>{t("add.untested.description")}</p>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={untestedConfirmed}
                    onChange={(event) => setUntestedConfirmed(event.target.checked)}
                    data-action="confirm-untested"
                  />
                  {t("add.untested.confirm")}
                </label>
              </AlertDescription>
            </Alert>
          ) : null}
          {create.isError && serverField !== "name" ? (
            <Alert variant="destructive" data-slot="save-error">
              <TriangleAlert aria-hidden="true" />
              <AlertDescription>{t(shareErrorKey(create.error))}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      ) : null}

      {step === "job" && saved ? <JobStep share={saved} onDone={onClose} /> : null}

      {step !== "job" ? (
        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={() => (index <= 0 ? onClose() : setStep(STEPS[index - 1] as Step))}
          >
            {index <= 0 ? t("add.cancel") : t("add.back")}
          </Button>
          {step === "options" ? (
            <Button
              type="button"
              onClick={save}
              loading={create.isPending}
              disabled={!testedOk && !untestedConfirmed}
              data-action="save-share"
            >
              {t("add.save")}
            </Button>
          ) : (
            <Button
              type="button"
              data-action="next"
              disabled={step === "connection" && privateBlocked}
              onClick={() => {
                if (step === "connection") {
                  setAttempted(true);
                  if (Object.keys(problems).length > 0) {
                    return;
                  }
                  setStep("test");
                  if (!test.data && !test.isPending) {
                    test.mutate(connectionInputOf(draft));
                  }
                  return;
                }
                if (step === "test" && !name) {
                  setName(suggestedName(draft));
                }
                setStep(STEPS[index + 1] as Step);
              }}
            >
              {t("add.next")}
            </Button>
          )}
        </DialogFooter>
      ) : null}
    </div>
  );
}

function TestStep({
  location,
  result,
  pending,
  error,
  onTest,
  subfolder,
  onPickFolder,
}: {
  location: string;
  result: ShareTestResult | undefined;
  pending: boolean;
  error: unknown;
  onTest: () => void;
  subfolder: string;
  onPickFolder: (folder: string) => void;
}) {
  const format = useShareFormat();
  const { t } = format;
  const level = permissionLevel(result?.permissions);
  return (
    <div className="grid gap-3" data-slot="test-step">
      <p className="text-sm">
        {t("add.test.location")} <code className="font-mono">{location}</code>
      </p>
      <div>
        <Button
          type="button"
          variant="outline"
          onClick={onTest}
          loading={pending}
          data-action="test"
        >
          {t("add.test.run")}
        </Button>
      </div>
      {error ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>{t(shareErrorKey(error))}</AlertDescription>
        </Alert>
      ) : null}
      {result && !result.ok ? (
        <FailureExplanation
          failure={result.failure}
          message={result.detail}
          subject={{ kind: "none" }}
          skipTargets={["file_share"]}
        />
      ) : null}
      {result?.ok ? (
        <div className="grid gap-3" data-slot="test-result">
          <Alert variant="info">
            <CircleCheck aria-hidden="true" />
            <AlertTitle>{t("add.test.ok", { address: result.address ?? "" })}</AlertTitle>
            <AlertDescription>
              <p data-permissions={level}>{t(`add.test.permissions.${level}`)}</p>
            </AlertDescription>
          </Alert>
          <div>
            <p className="mb-1 text-sm font-medium">
              {subfolder ? t("add.test.topLevelOf", { folder: subfolder }) : t("add.test.topLevel")}
            </p>
            <ul
              className="max-h-48 divide-y overflow-y-auto rounded-md border text-sm"
              data-slot="test-entries"
            >
              {result.entries.length === 0 ? (
                <li className="px-3 py-2 text-muted-foreground">{t("add.test.empty")}</li>
              ) : (
                result.entries.slice(0, 200).map((entry) => (
                  <li
                    key={entry.name}
                    className="flex items-center justify-between gap-2 px-3 py-1.5"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {entry.type === "dir" ? (
                        <Folder className="size-4 shrink-0 text-primary" aria-hidden="true" />
                      ) : (
                        <File
                          className="size-4 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                      )}
                      <span className="truncate">{entry.name}</span>
                    </span>
                    {entry.type === "dir" && !entry.invalidName ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => onPickFolder(entry.name)}
                      >
                        {t("add.test.useFolder")}
                      </Button>
                    ) : null}
                  </li>
                ))
              )}
            </ul>
            {result.truncated ? (
              <p className="mt-1 text-xs text-muted-foreground">{t("add.test.truncated")}</p>
            ) : null}
          </div>
        </div>
      ) : null}
      {!result && !pending ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Info className="size-3.5" aria-hidden="true" />
          {t("add.test.hint")}
        </p>
      ) : null}
    </div>
  );
}

/** After saving: put the share into a backup job, with the folders picked from the live share. */
function JobStep({ share, onDone }: { share: FileShareDetail; onDone: () => void }) {
  const { t } = useShareFormat();
  const { tenantId } = useTenantScope();
  const queryClient = useQueryClient();
  const jobs = useBackupJobs("share");
  const [jobId, setJobId] = React.useState<string>("");
  const [includes, setIncludes] = React.useState<string[]>([]);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const items = jobs.data?.items ?? [];
  const chosen = jobId || items[0]?.id || "";

  const add = async () => {
    if (!chosen) return;
    setPending(true);
    setError(null);
    try {
      await addJobMembers(chosen, {
        members: [{ id: share.id, ...(includes.length > 0 ? { overrides: { includes } } : {}) }],
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: backupJobKeys.all(tenantId) }),
        queryClient.invalidateQueries({ queryKey: fileShareKeys.all(tenantId) }),
      ]);
      toast.success(t("add.job.added", { name: share.name }));
      onDone();
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="grid gap-4" data-slot="job-step">
      <Alert variant="info">
        <CircleCheck aria-hidden="true" />
        <AlertTitle>{t("add.job.title", { name: share.name })}</AlertTitle>
        <AlertDescription>{t("add.job.description")}</AlertDescription>
      </Alert>
      {items.length > 0 ? (
        <>
          <RadioGroup value={chosen} onValueChange={setJobId} aria-label={t("add.job.choose")}>
            {items.map((job) => (
              <Label
                key={job.id}
                htmlFor={`job-${job.id}`}
                className="flex items-center gap-2 font-normal"
              >
                <RadioGroupItem id={`job-${job.id}`} value={job.id} />
                {job.name}
              </Label>
            ))}
          </RadioGroup>
          <div className="grid gap-1">
            <p className="text-sm font-medium">{t("add.job.folders")}</p>
            <p className="text-xs text-muted-foreground">{t("add.job.foldersHint")}</p>
            <FolderPicker shareId={share.id} mode="many" value={includes} onChange={setIncludes} />
          </div>
        </>
      ) : jobs.isPending ? null : (
        <p className="text-sm text-muted-foreground">{t("add.job.none")}</p>
      )}
      {error ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>{t(shareErrorKey(error))}</AlertDescription>
        </Alert>
      ) : null}
      <DialogFooter className="gap-2 sm:justify-between">
        <Button type="button" variant="outline" asChild>
          <Link {...linkTo(fileShareTo(share.id))} onClick={onDone}>
            {t("add.job.later")}
          </Link>
        </Button>
        <div className="flex gap-2">
          <Button type="button" variant="outline" asChild>
            <Link
              to={"/jobs" as never}
              search={{ type: "share", new: 1, select: share.id } as never}
              onClick={onDone}
            >
              {t("add.job.newJob")}
            </Link>
          </Button>
          {items.length > 0 ? (
            <Button
              type="button"
              onClick={() => void add()}
              loading={pending}
              data-action="add-to-job"
            >
              {t("add.job.add")}
            </Button>
          ) : null}
        </div>
      </DialogFooter>
    </div>
  );
}
