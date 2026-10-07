import { CircleAlert, FolderInput, HardDriveUpload, Info } from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { ArchiveRetention } from "@/features/archive/api";
import { Fact, Facts } from "@/features/restore/components/facts";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ImportedMailbox } from "../presenters";
import type { ImportConfig } from "../types";
import type { UploadItem } from "../upload/types";
import {
  type FolderSelection,
  type ImportOrigin,
  NAME_MAX_LENGTH,
  type TargetMode,
  type WizardState,
  validateName,
} from "./wizard-state";

// --- Step 1: where the files come from --------------------------------------------------------

interface SourceStepProps {
  config: ImportConfig;
  origin: ImportOrigin | null;
  onChange: (origin: ImportOrigin) => void;
}

export function SourceStep({ config, origin, onChange }: SourceStepProps) {
  const { t } = useTranslation("imports");
  const folderEnabled = config.folder.enabled;
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t("source.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("source.description")}</p>
      </div>

      <RadioGroup
        value={origin ?? ""}
        onValueChange={(value) => onChange(value as ImportOrigin)}
        aria-label={t("source.title")}
        className="grid gap-3 md:grid-cols-2"
      >
        <OriginOption
          value="upload"
          checked={origin === "upload"}
          disabled={!config.uploadEnabled}
          icon={HardDriveUpload}
          title={t("source.upload.title")}
          description={t("source.upload.description")}
        >
          {config.uploadEnabled ? null : (
            <p className="text-xs text-warning-text">{t("source.upload.disabled")}</p>
          )}
        </OriginOption>
        <OriginOption
          value="folder"
          checked={origin === "folder"}
          disabled={!folderEnabled}
          icon={FolderInput}
          title={t("source.folder.title")}
          description={t("source.folder.description", { path: config.folder.path })}
        >
          {folderEnabled ? null : (
            <div className="space-y-2 text-xs">
              <p className="font-medium text-warning-text">{t("source.folder.disabled.title")}</p>
              <p className="text-muted-foreground">
                {t("source.folder.disabled.description", { path: config.folder.path })}
              </p>
              <pre className="overflow-x-auto rounded-md bg-muted px-2.5 py-2 font-mono text-[11px] text-foreground">
                {t("source.folder.mountExample", { path: config.folder.path })}
              </pre>
            </div>
          )}
        </OriginOption>
      </RadioGroup>

      <FormatsInfo />
    </div>
  );
}

function OriginOption({
  value,
  checked,
  disabled,
  icon: Icon,
  title,
  description,
  children,
}: {
  value: ImportOrigin;
  checked: boolean;
  disabled: boolean;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  const id = `origin-${value}`;
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border border-border p-4 transition-colors",
        checked && "border-primary bg-primary/5",
        disabled && "bg-muted/40",
        !disabled && !checked && "hover:bg-muted/40",
      )}
    >
      <RadioGroupItem value={value} id={id} disabled={disabled} className="mt-1" />
      <div className="min-w-0 flex-1 space-y-2">
        <Label
          htmlFor={id}
          className={cn("items-start gap-3", disabled ? "cursor-not-allowed" : "cursor-pointer")}
        >
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
          >
            <Icon className="size-4" />
          </span>
          <span className="min-w-0 space-y-0.5">
            <span className="block text-sm font-medium">{title}</span>
            <span className="block text-sm font-normal text-muted-foreground">{description}</span>
          </span>
        </Label>
        {children}
      </div>
    </div>
  );
}

const FORMAT_POINTS = ["supported", "mailstore", "pst", "calendar", "msg"] as const;

/** What can and cannot be imported, said plainly before anything is chosen. */
export function FormatsInfo() {
  const { t } = useTranslation("imports");
  return (
    <Alert variant="info" data-testid="formats-info">
      <Info />
      <AlertTitle>{t("source.info.title")}</AlertTitle>
      <AlertDescription>
        <ul className="mt-1 list-disc space-y-1.5 pl-4">
          {FORMAT_POINTS.map((point) => (
            <li key={point}>{t(`source.info.${point}`)}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

// --- Step 3: the target ----------------------------------------------------------------------------

interface TargetStepProps {
  state: Pick<WizardState, "targetMode" | "name" | "objectId" | "archive">;
  mailboxes: readonly ImportedMailbox[] | undefined;
  mailboxesLoading: boolean;
  onMode: (mode: TargetMode) => void;
  onName: (name: string) => void;
  onObject: (objectId: string | null) => void;
  onArchive: (archive: boolean) => void;
  /** The person tried to continue: show what is missing. */
  showErrors: boolean;
  /** The archive's retention in this tenant, to name the period archived mail cannot be deleted in. */
  archiveRetention?: ArchiveRetention | null;
}

/** The retention line under the archive option, or null while the retention is unknown. */
export function archiveRetentionMessage(
  retention: ArchiveRetention | null | undefined,
): { key: string; values?: { count: number } } | null {
  if (!retention) {
    return null;
  }
  if (retention.years === null) {
    return { key: "target.archive.retention.unlimited" };
  }
  return {
    key:
      retention.mode === "end_of_year"
        ? "target.archive.retention.endOfYear"
        : "target.archive.retention.years",
    values: { count: retention.years },
  };
}

export function TargetStep({
  state,
  mailboxes,
  mailboxesLoading,
  onMode,
  onName,
  onObject,
  onArchive,
  showErrors,
  archiveRetention = null,
}: TargetStepProps) {
  const { t } = useTranslation("imports");
  const retentionLine = archiveRetentionMessage(archiveRetention);
  const nameProblem = validateName(state.name);
  const noMailboxes = !mailboxesLoading && (mailboxes?.length ?? 0) === 0;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t("target.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("target.description")}</p>
      </div>

      <RadioGroup
        value={state.targetMode}
        onValueChange={(value) => onMode(value as TargetMode)}
        aria-label={t("target.title")}
        className="gap-3"
      >
        <div
          className={cn(
            "space-y-3 rounded-lg border border-border p-4",
            state.targetMode === "new" && "border-primary bg-primary/5",
          )}
        >
          <div className="flex items-start gap-3">
            <RadioGroupItem value="new" id="target-new" className="mt-1" />
            <Label htmlFor="target-new" className="flex-col items-start gap-0.5">
              <span className="text-sm font-medium">{t("target.new.title")}</span>
              <span className="text-sm font-normal text-muted-foreground">
                {t("target.new.description")}
              </span>
            </Label>
          </div>
          {state.targetMode === "new" ? (
            <div className="space-y-1.5 pl-7">
              <Label htmlFor="target-name">{t("target.new.name")}</Label>
              <Input
                id="target-name"
                value={state.name}
                maxLength={NAME_MAX_LENGTH + 20}
                autoComplete="off"
                placeholder={t("target.new.placeholder")}
                aria-invalid={showErrors && nameProblem !== null}
                aria-describedby="target-name-hint"
                onChange={(event) => onName(event.target.value)}
              />
              <p
                id="target-name-hint"
                role={showErrors && nameProblem ? "alert" : undefined}
                className={cn(
                  "text-xs",
                  showErrors && nameProblem ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {showErrors && nameProblem
                  ? t(`target.new.errors.${nameProblem}`, { max: NAME_MAX_LENGTH })
                  : t("target.new.hint", { max: NAME_MAX_LENGTH })}
              </p>
            </div>
          ) : null}
        </div>

        <div
          className={cn(
            "space-y-3 rounded-lg border border-border p-4",
            state.targetMode === "existing" && "border-primary bg-primary/5",
            noMailboxes && "bg-muted/40",
          )}
        >
          <div className="flex items-start gap-3">
            <RadioGroupItem
              value="existing"
              id="target-existing"
              disabled={noMailboxes}
              className="mt-1"
            />
            <Label
              htmlFor="target-existing"
              className={cn("flex-col items-start gap-0.5", noMailboxes && "cursor-not-allowed")}
            >
              <span className="text-sm font-medium">{t("target.existing.title")}</span>
              <span className="text-sm font-normal text-muted-foreground">
                {noMailboxes ? t("target.existing.none") : t("target.existing.description")}
              </span>
            </Label>
          </div>
          {state.targetMode === "existing" ? (
            <div className="space-y-1.5 pl-7">
              <Label htmlFor="target-mailbox">{t("target.existing.select")}</Label>
              {mailboxesLoading ? (
                <Skeleton className="h-9 w-full" />
              ) : (
                <Select value={state.objectId ?? ""} onValueChange={(value) => onObject(value)}>
                  <SelectTrigger
                    id="target-mailbox"
                    className="w-full"
                    aria-invalid={showErrors && state.objectId === null}
                  >
                    <SelectValue placeholder={t("target.existing.placeholder")} />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {(mailboxes ?? []).map((mailbox) => (
                      <SelectItem key={mailbox.id} value={mailbox.id}>
                        {mailbox.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {showErrors && state.objectId === null ? (
                <p role="alert" className="text-xs text-destructive">
                  {t("target.existing.error")}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">{t("target.existing.hint")}</p>
              )}
            </div>
          ) : null}
        </div>
      </RadioGroup>

      <div className="flex items-start gap-3 rounded-lg border border-border p-4">
        <Checkbox
          id="target-archive"
          checked={state.archive}
          onCheckedChange={(checked) => onArchive(checked === true)}
          className="mt-0.5"
        />
        <Label htmlFor="target-archive" className="flex-col items-start gap-0.5">
          <span className="text-sm font-medium">{t("target.archive.title")}</span>
          <span className="text-sm font-normal text-muted-foreground">
            {t("target.archive.description")}
          </span>
        </Label>
      </div>
      {state.archive ? (
        <Alert variant="warning" data-slot="archive-irreversible">
          <CircleAlert />
          <AlertDescription>
            <p>{t("target.archive.irreversible")}</p>
            {retentionLine ? <p>{t(retentionLine.key, retentionLine.values)}</p> : null}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

// --- Step 4: review -------------------------------------------------------------------------------------

interface ReviewStepProps {
  state: WizardState;
  uploads: readonly UploadItem[];
  targetName: string | null;
  uploadsBusy: number;
  language: string;
  error: React.ReactNode;
}

export function ReviewStep({
  state,
  uploads,
  targetName,
  uploadsBusy,
  language,
  error,
}: ReviewStepProps) {
  const { t } = useTranslation("imports");
  const files =
    state.origin === "folder"
      ? state.folderSelection.map((entry) => ({
          key: entry.path,
          name: entry.path,
          size: entry.size,
          directory: entry.type === "directory",
        }))
      : uploads
          .filter((item) => item.status === "ready")
          .map((item) => ({
            key: item.localId,
            name: item.name,
            size: item.size,
            directory: false,
          }));
  const totalBytes = files.reduce((sum, file) => sum + (file.size ?? 0), 0);

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t("review.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("review.description")}</p>
      </div>

      <Facts className="grid-cols-[minmax(0,8rem)_minmax(0,1fr)] sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
        <Fact label={t("review.facts.source")}>
          {state.origin === "folder" ? t("review.source.folder") : t("review.source.upload")}
        </Fact>
        <Fact label={t("review.facts.files")}>
          {t("review.filesSummary", {
            count: files.length,
            size: formatBytes(totalBytes, language),
          })}
        </Fact>
        <Fact label={t("review.facts.target")}>
          {state.targetMode === "new"
            ? t("review.target.new", { name: state.name.trim() })
            : t("review.target.existing", { name: targetName ?? "" })}
        </Fact>
        <Fact label={t("review.facts.archive")}>
          {state.archive ? t("review.archive.willBe") : t("review.archive.willNotBe")}
        </Fact>
      </Facts>

      {files.length > 0 ? (
        <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-lg border border-border">
          {files.map((file) => (
            <li key={file.key} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.name}>
                {file.name}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {file.directory
                  ? t("folder.directory")
                  : file.size !== null
                    ? formatBytes(file.size, language)
                    : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {uploadsBusy > 0 ? (
        <Alert variant="info">
          <CircleAlert />
          <AlertDescription>{t("review.uploading", { count: uploadsBusy })}</AlertDescription>
        </Alert>
      ) : null}

      <Alert variant="default">
        <Info />
        <AlertDescription>{t("review.note")}</AlertDescription>
      </Alert>

      {error}
    </div>
  );
}
