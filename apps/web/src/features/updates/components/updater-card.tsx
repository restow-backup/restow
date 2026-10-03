import { ChevronDown, Info, Loader2, ShieldAlert, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "@/components/kit/confirm-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { toast } from "@/components/ui/sonner";

import type { UpdatesView } from "../api";
import { useCancelMaintenance } from "../hooks";
import { smoothOffset } from "../maintenance/maintenance-state";
import { useCountdown } from "../maintenance/use-countdown";
import {
  ENABLE_UPDATER_COMMAND,
  RECREATE_UPDATER_COMMAND,
  blockerKey,
  clockOffset,
  formatClock,
  isSourceInstallRefused,
  manualUpdateCommands,
  selfUpdateNote,
  sourceAllowlistLine,
  switchKey,
  updaterImageLine,
  updatesErrorKey,
} from "../presenters";
import { ProgressBar } from "../progress-bar";
import { CommandBlock, CommandList } from "./command-block";
import { DumpsList } from "./dumps-list";
import { InstallDialog } from "./install-dialog";

/**
 * Installing an update from here, by what the updater can do: nothing (it is
 * not running: the manual steps), blocked (why), ready (install), busy (the
 * announced or running update, with the countdown) or demo (read-only).
 */
export function UpdaterCard({
  view,
  canChange,
  receivedAt,
}: {
  view: UpdatesView;
  canChange: boolean;
  /** Client time at which `view` arrived (`dataUpdatedAt`), for the clock skew of the countdown. */
  receivedAt: number;
}) {
  const { t } = useTranslation("updates");
  const state = view.updater.state;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("updater.title")}</CardTitle>
        <CardDescription>{t(`updater.description.${state}`)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6" data-slot="updater" data-state={state}>
        {view.updater.incompatible ? (
          <Alert
            variant="warning"
            data-slot="updater-incompatible"
            className="has-[>svg]:grid-cols-[calc(var(--spacing)*4)_minmax(0,1fr)]"
          >
            <TriangleAlert />
            <AlertTitle>{t("updater.incompatible.title")}</AlertTitle>
            <AlertDescription className="min-w-0 grid-cols-[minmax(0,1fr)] justify-items-stretch">
              <p>{t("updater.incompatible.body")}</p>
              <CommandBlock
                command={RECREATE_UPDATER_COMMAND}
                copyLabel={t("commands.copy")}
                className="w-full"
              />
            </AlertDescription>
          </Alert>
        ) : (
          <SelfUpdateNoteView view={view} />
        )}
        {state === "unavailable" ? <Unavailable view={view} /> : null}
        {state === "blocked" ? <Blocked view={view} /> : null}
        {state === "ready" ? <Ready view={view} canChange={canChange} /> : null}
        {state === "busy" ? (
          <Busy view={view} canChange={canChange} receivedAt={receivedAt} />
        ) : null}
        {state === "demo" ? (
          <Alert variant="info" data-slot="demo-note">
            <Info />
            <AlertDescription>{t("updater.demo")}</AlertDescription>
          </Alert>
        ) : null}
        {state === "ready" || state === "blocked" || state === "busy" ? (
          <DumpsList dumps={view.updater.dumps} />
        ) : null}
      </CardContent>
    </Card>
  );
}

// --- The updater's own version ---------------------------------------------------------------------

/**
 * The updater runs another version than the installation: whether it is replacing
 * itself, why it did not, or (for an updater that cannot) how to move it once.
 */
function SelfUpdateNoteView({ view }: { view: UpdatesView }) {
  const { t } = useTranslation("updates");
  const note = selfUpdateNote(view);
  if (!note) {
    return null;
  }
  const values = { updater: view.updater.version ?? "", running: view.running ?? "" };
  const reason =
    (note.kind === "failed" || note.kind === "skipped") && note.reason
      ? t(`updater.selfUpdate.reasons.${note.reason}`)
      : "";
  const envLine = updaterImageLine(view);
  // A failed self-update already wrote the verified image: recreating is all that is left.
  const commands =
    note.kind === "failed" || note.kind === "pending" || !envLine
      ? [RECREATE_UPDATER_COMMAND]
      : [envLine, RECREATE_UPDATER_COMMAND];
  const failed = note.kind === "failed";
  return (
    <Alert
      variant={failed ? "warning" : "info"}
      data-slot="updater-outdated"
      data-kind={note.kind}
      className="has-[>svg]:grid-cols-[calc(var(--spacing)*4)_minmax(0,1fr)]"
    >
      {failed ? <TriangleAlert /> : <Info />}
      <AlertDescription className="min-w-0 grid-cols-[minmax(0,1fr)] justify-items-stretch">
        <p>
          {note.kind === "pending"
            ? t("updater.selfUpdate.pending", { version: note.version })
            : t(`updater.selfUpdate.${note.kind}`, { ...values, reason })}
        </p>
        {note.kind === "failed" && note.detail ? (
          <p className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {note.detail}
          </p>
        ) : null}
        {note.kind === "pending" ? null : (
          <CommandList commands={commands} copyLabel={t("commands.copy")} />
        )}
      </AlertDescription>
    </Alert>
  );
}

// --- Not running -------------------------------------------------------------------------------------

function Unavailable({ view }: { view: UpdatesView }) {
  const { t } = useTranslation("updates");
  // An updater that answers but speaks another protocol is not "not running": the note above says what to do.
  if (view.updater.incompatible) {
    return <ManualSteps view={view} />;
  }
  return (
    <>
      <Alert variant="info" data-slot="updater-unavailable">
        <Info />
        <AlertTitle>{t("updater.unavailable.title")}</AlertTitle>
        <AlertDescription>
          <p>{t("updater.unavailable.body")}</p>
        </AlertDescription>
      </Alert>
      <ManualSteps view={view} />
      <section className="space-y-3" data-slot="enable-updater">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{t("updater.enable.title")}</h3>
          <p className="text-sm text-muted-foreground">{t("updater.enable.body")}</p>
        </div>
        <CommandBlock command={ENABLE_UPDATER_COMMAND} copyLabel={t("commands.copy")} />
        <p className="text-sm text-muted-foreground" data-slot="updater-image-note">
          {view.updater.applicationImage
            ? t("updater.enable.image", { image: view.updater.applicationImage })
            : t("updater.enable.imageGeneric")}
        </p>
        <Alert variant="warning" data-slot="socket-warning">
          <ShieldAlert />
          <AlertDescription>{t("updater.enable.socket")}</AlertDescription>
        </Alert>
      </section>
    </>
  );
}

/** The manual update of docs/UPDATING.md, for the mode this installation uses first. */
function ManualSteps({ view, collapsible = false }: { view: UpdatesView; collapsible?: boolean }) {
  const { t } = useTranslation("updates");
  const [open, setOpen] = React.useState(false);
  const commands = manualUpdateCommands(view.latest?.tag ?? null);
  const order =
    view.mode === "source" ? (["source", "image"] as const) : (["image", "source"] as const);

  const body = (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("manual.body")}</p>
      {order.map((mode) => (
        <div key={mode} className="space-y-2" data-mode={mode}>
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {t(`manual.${mode}.title`)}
            {view.mode === mode ? <Badge variant="secondary">{t("manual.yourMode")}</Badge> : null}
          </p>
          <p className="text-xs text-muted-foreground">{t(`manual.${mode}.hint`)}</p>
          <CommandList commands={commands[mode]} copyLabel={t("commands.copy")} />
        </div>
      ))}
    </div>
  );

  if (!collapsible) {
    return (
      <section className="space-y-3" data-slot="manual-steps">
        <h3 className="text-sm font-semibold">{t("manual.title")}</h3>
        {body}
      </section>
    );
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-slot="manual-steps">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="-ml-2.5">
          <ChevronDown className={open ? "rotate-180" : undefined} aria-hidden="true" />
          {t("manual.title")}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3">{body}</CollapsibleContent>
    </Collapsible>
  );
}

// --- Blocked ---------------------------------------------------------------------------------------------

function Blocked({ view }: { view: UpdatesView }) {
  const { t } = useTranslation("updates");
  return (
    <>
      <Alert variant="warning" data-slot="updater-blocked">
        <TriangleAlert />
        <AlertTitle>{t("updater.blocked.title")}</AlertTitle>
        <AlertDescription>
          <p>{t("updater.blocked.body")}</p>
        </AlertDescription>
      </Alert>
      <ul className="space-y-3">
        {view.updater.blockers.map((blocker) => (
          <li
            key={blocker.code}
            className="space-y-1 rounded-lg border border-border p-3 text-sm"
            data-blocker={blocker.code}
          >
            <p className="font-medium">{t(blockerKey(blocker.code))}</p>
            {blocker.detail ? (
              <p className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {blocker.detail}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      <ManualSteps view={view} collapsible />
    </>
  );
}

// --- Ready -------------------------------------------------------------------------------------------------

function Ready({ view, canChange }: { view: UpdatesView; canChange: boolean }) {
  const { t } = useTranslation("updates");
  const [installing, setInstalling] = React.useState(false);
  const newest = view.releases[0];
  const refused = isSourceInstallRefused(view);
  const allowLine = sourceAllowlistLine(view.source);
  return (
    <>
      {refused ? (
        <Alert
          variant="warning"
          data-slot="source-not-allowed"
          className="has-[>svg]:grid-cols-[calc(var(--spacing)*4)_minmax(0,1fr)]"
        >
          <ShieldAlert />
          <AlertTitle>{t("updater.sourceNotAllowed.title")}</AlertTitle>
          <AlertDescription className="min-w-0 grid-cols-[minmax(0,1fr)] justify-items-stretch">
            <p>{t("updater.sourceNotAllowed.body")}</p>
            {allowLine ? (
              <CommandList
                commands={[allowLine, RECREATE_UPDATER_COMMAND]}
                copyLabel={t("commands.copy")}
              />
            ) : null}
            <p>{t("updater.sourceNotAllowed.risk")}</p>
          </AlertDescription>
        </Alert>
      ) : null}
      {newest ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <p className="font-medium">
              {t("updater.ready.available", { version: newest.version })}
            </p>
            <p className="text-sm text-muted-foreground">{t("updater.ready.body")}</p>
          </div>
          <Button
            className="shrink-0"
            onClick={() => setInstalling(true)}
            disabled={!canChange || refused}
          >
            {t("updater.ready.install")}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground" data-slot="nothing-to-install">
          {t("updater.ready.nothing")}
        </p>
      )}
      {newest ? <InstallDialog view={view} open={installing} onOpenChange={setInstalling} /> : null}
    </>
  );
}

// --- Busy ----------------------------------------------------------------------------------------------------

/** Server clock minus client clock, steadied over the last few polls of the tab. */
function useServerOffset(serverTime: string, receivedAt: number): number {
  const measured = clockOffset(serverTime, receivedAt);
  const [samples, setSamples] = React.useState<number[]>(() => [measured]);
  React.useEffect(() => {
    setSamples((current) => smoothOffset(current, measured).samples);
  }, [measured]);
  return Math.max(...samples);
}

function Busy({
  view,
  canChange,
  receivedAt,
}: { view: UpdatesView; canChange: boolean; receivedAt: number }) {
  const { t } = useTranslation("updates");
  const cancel = useCancelMaintenance();
  const [confirming, setConfirming] = React.useState(false);
  const maintenance = view.maintenance;
  const scheduled = maintenance.phase === "scheduled";
  const offset = useServerOffset(maintenance.serverTime, receivedAt);
  const remaining = useCountdown(scheduled ? maintenance.startsAt : null, offset);
  const version = maintenance.targetVersion ?? "";

  return (
    <div className="space-y-4" data-slot="updater-busy" data-phase={maintenance.phase}>
      <Alert variant="info">
        <Loader2 className="motion-safe:animate-spin" />
        <AlertTitle>
          {scheduled
            ? t(switchKey("updater.busy.scheduledTitle", maintenance.switchTo), { version })
            : t(switchKey("updater.busy.runningTitle", maintenance.switchTo), { version })}
        </AlertTitle>
        <AlertDescription>
          {scheduled ? (
            <p className="tabular-nums" data-slot="busy-countdown">
              {remaining !== null && remaining > 0
                ? t("updater.busy.startsIn", { time: formatClock(remaining) })
                : t("updater.busy.starting")}
            </p>
          ) : (
            <p>{t("updater.busy.noCancel")}</p>
          )}
        </AlertDescription>
      </Alert>
      {!scheduled ? (
        <ProgressBar value={maintenance.progress} label={t("maintenance.modal.progress")} />
      ) : null}
      {scheduled ? (
        <div className="flex justify-end">
          <Button variant="outline" onClick={() => setConfirming(true)} disabled={!canChange}>
            {t("updater.busy.cancel")}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("updater.busy.cancelTitle")}
        description={<p>{t("updater.busy.cancelBody")}</p>}
        confirmLabel={t("updater.busy.cancelConfirm")}
        cancelLabel={t("updater.busy.cancelKeep")}
        pending={cancel.isPending}
        error={cancel.isError ? t(updatesErrorKey(cancel.error)) : undefined}
        onConfirm={() =>
          cancel.mutateAsync().then(() => {
            toast.success(t("toasts.cancelled"));
          })
        }
      />
    </div>
  );
}
