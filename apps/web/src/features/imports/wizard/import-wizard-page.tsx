import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, History, Play } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useArchiveRetention } from "@/features/archive/hooks";
import { sourcesListTo } from "@/features/sources/paths";
import { CircleX } from "lucide-react";
import { ImportsForbidden, NoTenantSelected } from "../components/access-states";
import { IMPORTS_TAB_SEARCH, importDetailTo, importsListTo } from "../paths";
import { importErrorKey } from "../presenters";
import type { ImportConfig } from "../types";
import { UploadLeaveGuard } from "../upload/upload-leave-guard";
import { useUploadManager } from "../upload/use-upload-manager";
import {
  useCreateImport,
  useDiscardUpload,
  useImportConfig,
  useImportedMailboxes,
  useUnfinishedUploads,
} from "../use-imports";
import { FolderBrowser, SelectedEntries } from "./folder-browser";
import { Stepper } from "./stepper";
import { ReviewStep, SourceStep, TargetStep } from "./steps";
import { UploadPanel } from "./upload-panel";
import {
  type WizardContext,
  type WizardState,
  buildCreateInput,
  canOpen,
  initialWizardState,
  stepBlocker,
  stepIndex,
  wizardReducer,
} from "./wizard-state";

const BUSY_STATUSES = new Set(["queued", "opening", "uploading", "completing"]);

/**
 * "Import mail files": where the files come from, which files, where they go,
 * review and start. Uploads run in the background while the person moves
 * through the steps; the import can start once every chosen file is complete.
 */
export function ImportWizardPage() {
  const { t } = useTranslation("imports");
  const { query, tenantId, canManage } = useImportConfig();

  let body: React.ReactNode;
  if (!tenantId) {
    body = <NoTenantSelected />;
  } else if (!canManage) {
    body = <ImportsForbidden />;
  } else if (query.isPending) {
    body = (
      <div className="space-y-4">
        <Skeleton className="h-10 w-full max-w-md" />
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
    );
  } else if (query.isError) {
    body = (
      <ErrorState
        title={t("loadError")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  } else {
    // Keyed by tenant: another tenant starts with an empty wizard and its own uploads.
    body = <Wizard key={tenantId} config={query.data} tenantId={tenantId} />;
  }

  return (
    <div className="space-y-6">
      <Link
        to={sourcesListTo()}
        search={IMPORTS_TAB_SEARCH as never}
        className="inline-flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        {t("actions.backToSources")}
      </Link>
      <PageHeader title={t("title")} description={t("subtitle")}>
        {tenantId && canManage ? (
          <Link
            to={importsListTo()}
            search={IMPORTS_TAB_SEARCH as never}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <History />
            {t("actions.history")}
          </Link>
        ) : null}
      </PageHeader>
      {body}
    </div>
  );
}

function initialState(config: ImportConfig): WizardState {
  const origin = config.uploadEnabled ? "upload" : config.folder.enabled ? "folder" : null;
  return { ...initialWizardState, origin };
}

function Wizard({ config, tenantId }: { config: ImportConfig; tenantId: string }) {
  const { t, i18n } = useTranslation("imports");
  const { t: tAny } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const navigate = useNavigate();

  const [state, dispatch] = React.useReducer(wizardReducer, config, initialState);
  const [folderPath, setFolderPath] = React.useState("");
  const [attempted, setAttempted] = React.useState(false);

  const unfinished = useUnfinishedUploads(state.origin === "upload");
  const manager = useUploadManager({ tenantId, config, unfinished: unfinished.data });
  const discard = useDiscardUpload();
  const mailboxes = useImportedMailboxes(state.step === "target" || state.step === "review");
  const create = useCreateImport();
  const archiveRetention = useArchiveRetention();

  const context: WizardContext = React.useMemo(
    () => ({
      uploadEnabled: config.uploadEnabled,
      folderEnabled: config.folder.enabled,
      uploadsReady: manager.ready.length,
      uploadsBusy: manager.items.filter((item) => BUSY_STATUSES.has(item.status)).length,
    }),
    [config, manager.ready.length, manager.items],
  );

  const blocker = stepBlocker(state, state.step, context);
  const lastStep = stepIndex(state.step) === 3;
  const showBlocker = attempted && blocker !== null;
  const targetName =
    state.targetMode === "existing"
      ? (mailboxes.data?.find((mailbox) => mailbox.id === state.objectId)?.name ?? null)
      : null;

  const go = (action: Parameters<typeof dispatch>[0]) => {
    setAttempted(false);
    create.reset();
    dispatch(action);
  };

  const next = () => {
    if (blocker !== null) {
      setAttempted(true);
      return;
    }
    go({ type: "next", context });
  };

  const start = () => {
    if (blocker !== null) {
      setAttempted(true);
      return;
    }
    const uploadIds = manager.ready.flatMap((item) => (item.uploadId ? [item.uploadId] : []));
    create.mutate(buildCreateInput(state, uploadIds), {
      onSuccess: (created) => {
        void navigate({ to: importDetailTo(created.id) });
      },
    });
  };

  return (
    <div className="space-y-5">
      <UploadLeaveGuard busy={manager.progress.busy} />
      <Stepper
        current={state.step}
        canOpen={(step) => canOpen(state, step, context)}
        onSelect={(step) => go({ type: "goTo", step, context })}
      />

      <Card>
        <CardContent className="space-y-6">
          {state.step === "source" ? (
            <SourceStep
              config={config}
              origin={state.origin}
              onChange={(origin) => go({ type: "setOrigin", origin })}
            />
          ) : null}

          {state.step === "files" ? (
            <div className="space-y-5">
              <div className="space-y-1">
                <h2 className="text-base font-semibold">{t("files.title")}</h2>
                <p className="text-sm text-muted-foreground">
                  {state.origin === "folder"
                    ? t("files.descriptionFolder")
                    : t("files.descriptionUpload")}
                </p>
              </div>
              {state.origin === "folder" ? (
                <div className="space-y-5">
                  <FolderBrowser
                    path={folderPath}
                    onPathChange={setFolderPath}
                    selection={state.folderSelection}
                    onToggle={(entry) => dispatch({ type: "toggleFolderEntry", entry })}
                  />
                  <SelectedEntries
                    selection={state.folderSelection}
                    onRemove={(path) => dispatch({ type: "removeFolderEntry", path })}
                    onClear={() => dispatch({ type: "clearFolderSelection" })}
                  />
                </div>
              ) : (
                <UploadPanel
                  manager={manager}
                  config={config}
                  unfinished={unfinished.data ?? []}
                  onDiscardUnfinished={(uploadId) => discard.mutate(uploadId)}
                  discarding={discard.isPending}
                />
              )}
            </div>
          ) : null}

          {state.step === "target" ? (
            <TargetStep
              state={state}
              mailboxes={mailboxes.data}
              mailboxesLoading={mailboxes.isPending}
              showErrors={attempted}
              onMode={(mode) => dispatch({ type: "setTargetMode", mode })}
              onName={(name) => dispatch({ type: "setName", name })}
              onObject={(objectId) => dispatch({ type: "setObjectId", objectId })}
              onArchive={(archive) => dispatch({ type: "setArchive", archive })}
              archiveRetention={archiveRetention.data ?? null}
            />
          ) : null}

          {state.step === "review" ? (
            <ReviewStep
              state={state}
              uploads={manager.items}
              targetName={targetName}
              uploadsBusy={context.uploadsBusy}
              language={language}
              error={
                create.error ? (
                  <Alert variant="destructive">
                    <CircleX />
                    <AlertDescription>{tAny(importErrorKey(create.error))}</AlertDescription>
                  </Alert>
                ) : null
              }
            />
          ) : null}
        </CardContent>

        <CardFooter className="flex-wrap justify-between gap-3 border-t">
          <div className="flex items-center gap-2">
            {state.step !== "source" ? (
              <Button variant="outline" onClick={() => go({ type: "back" })}>
                <ArrowLeft />
                {tAny("actions.back")}
              </Button>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            {showBlocker ? (
              <p role="alert" className="text-sm text-destructive">
                {t(`blockers.${blocker}`)}
              </p>
            ) : null}
            {lastStep ? (
              <Button onClick={start} loading={create.isPending}>
                {create.isPending ? null : <Play />}
                {t("actions.start")}
              </Button>
            ) : (
              <Button onClick={next}>
                {t("actions.next")}
                <ArrowRight />
              </Button>
            )}
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}
