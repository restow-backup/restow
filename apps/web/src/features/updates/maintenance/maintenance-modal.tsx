import { Link, useRouterState } from "@tanstack/react-router";
import {
  Circle,
  CircleCheck,
  CircleMinus,
  CircleX,
  Loader2,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DIALOG_BOX,
  DIALOG_LAYER,
  Dialog,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

import { type MaintenanceView, type StepStatus, UPDATE_STEPS, type UpdateStepId } from "../api";
import { ProgressBar } from "../progress-bar";
import "../i18n";
import { useUpdateMessage } from "../messages";
import { failureKey, stepLabelKey, stepStatusKey, switchKey } from "../presenters";
import { isUpdatesTab, updatesTabLink } from "../settings-link";
import { type ModalState, modalStateOf } from "./maintenance-state";
import { useMaintenanceState } from "./use-maintenance";

/**
 * The full-screen notice while an update runs, and after it, until the person
 * has seen the result. It cannot be dismissed while the update runs (no
 * Escape, no click outside, focus stays inside). While the api is away
 * (it stops first, then comes back on the new version) the modal stays and
 * says so: the server restarting is expected, not an error.
 */
export function MaintenanceModal({ onUpdatesTab = false }: { onUpdatesTab?: boolean }) {
  const { t } = useTranslation("updates");
  const { snapshot, sawActiveRun, dismissedRunId, dismiss } = useMaintenanceState();
  const { isProviderAdmin } = useSession();
  const state = modalStateOf({
    snapshot,
    nowMs: Date.now(),
    sawActiveRun,
    dismissedRunId,
    isProviderAdmin,
    onUpdatesTab,
  });

  if (state.kind === "none" || !snapshot) {
    return null;
  }
  const view = snapshot.view;
  const unreachable = !snapshot.apiReachable;
  // A provider admin cannot dismiss "needs attention"; the way on is the Updates tab.
  const attentionForAdmin =
    state.kind === "failed" && state.outcome === "needs_attention" && isProviderAdmin;
  const canDismiss = state.kind !== "running" && !attentionForAdmin;
  const link = updatesTabLink();

  return (
    <Dialog open>
      <DialogPortal>
        {/* Content inside the overlay, placed and scrolling like DialogContent. */}
        <DialogOverlay
          className={cn(
            DIALOG_LAYER,
            "z-[100] bg-background/90 backdrop-blur-sm motion-reduce:animate-none",
          )}
        >
          <DialogPrimitive.Content
            aria-modal="true"
            data-slot="maintenance-modal"
            data-state-kind={state.kind}
            onEscapeKeyDown={(event) => event.preventDefault()}
            onPointerDownOutside={(event) => event.preventDefault()}
            onInteractOutside={(event) => event.preventDefault()}
            className={cn(
              DIALOG_BOX,
              "grid max-w-lg gap-5 rounded-xl border bg-card p-6 text-card-foreground shadow-lg outline-none motion-reduce:animate-none",
            )}
          >
            {state.kind === "running" ? (
              <RunningContent view={view} unreachable={unreachable} />
            ) : state.kind === "succeeded" ? (
              <SucceededContent view={view} unreachable={unreachable} />
            ) : (
              <FailedContent
                view={view}
                state={state}
                isProviderAdmin={isProviderAdmin}
                unreachable={unreachable}
              />
            )}
            {state.kind !== "running" ? (
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                {canDismiss ? (
                  <Button
                    type="button"
                    variant={state.kind === "succeeded" ? "outline" : "default"}
                    onClick={() => view.runId && dismiss(view.runId)}
                    disabled={!view.runId}
                  >
                    {t("maintenance.modal.dismiss")}
                  </Button>
                ) : null}
                {state.kind === "succeeded" ? (
                  <Button type="button" onClick={() => window.location.reload()}>
                    {t("maintenance.modal.succeeded.reload")}
                  </Button>
                ) : null}
                {attentionForAdmin ? (
                  <Button asChild>
                    <Link to={link.to} search={link.search}>
                      {t("maintenance.openSettings")}
                    </Link>
                  </Button>
                ) : null}
              </div>
            ) : null}
          </DialogPrimitive.Content>
        </DialogOverlay>
      </DialogPortal>
    </Dialog>
  );
}

/** The modal for the app shell: it steps aside on Settings, Updates, where the recovery steps are. */
export function ShellMaintenanceModal() {
  const onUpdatesTab = useRouterState({
    select: (state) => isUpdatesTab(state.location.pathname),
  });
  return <MaintenanceModal onUpdatesTab={onUpdatesTab} />;
}

// --- Running ---------------------------------------------------------------------------------------

function RunningContent({ view, unreachable }: { view: MaintenanceView; unreachable: boolean }) {
  const { t } = useTranslation("updates");
  const { t: tc } = useTranslation();
  const product = tc("app.name");
  const messageText = useUpdateMessage()(view.message, view.switchTo);

  return (
    <>
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-info/10 text-info-text">
          <Wrench className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 space-y-1">
          <DialogTitle className="text-lg leading-snug font-semibold [overflow-wrap:anywhere]">
            {view.targetVersion
              ? t(switchKey("maintenance.modal.running.title", view.switchTo), {
                  product,
                  version: view.targetVersion,
                })
              : t(
                  view.switchTo
                    ? "maintenance.modal.running.titleSwitchNoVersion"
                    : "maintenance.modal.running.titleNoVersion",
                  { product },
                )}
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            {t("maintenance.modal.running.description")}
          </DialogDescription>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{t("maintenance.modal.progress")}</span>
          <span className="tabular-nums">
            {t("maintenance.modal.percent", { value: Math.round(view.progress) })}
          </span>
        </div>
        <ProgressBar
          value={view.progress}
          label={t("maintenance.modal.progress")}
          className="h-2"
        />
      </div>

      <StepsList steps={view.steps} currentStep={view.step} />

      {messageText ? (
        <p className="text-sm text-muted-foreground" data-slot="maintenance-message">
          {messageText}
        </p>
      ) : null}

      {unreachable ? (
        <Alert variant="info" aria-live="polite" data-slot="maintenance-unreachable">
          <Loader2 className="motion-safe:animate-spin" />
          <AlertDescription>{t("maintenance.modal.unreachable")}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

const STEP_ICON: Record<
  StepStatus,
  { icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  pending: { icon: Circle, className: "text-muted-foreground/60" },
  running: { icon: Loader2, className: "text-info-text motion-safe:animate-spin" },
  done: { icon: CircleCheck, className: "text-foreground" },
  failed: { icon: CircleX, className: "text-destructive-text" },
  skipped: { icon: CircleMinus, className: "text-muted-foreground" },
};

/** The steps in the order they run; a step the status does not list yet is pending. */
export function StepsList({
  steps,
  currentStep,
  mode = null,
}: {
  steps: readonly { id: UpdateStepId; status: StepStatus }[];
  currentStep: UpdateStepId | null;
  mode?: "image" | "source" | null;
}) {
  const { t } = useTranslation("updates");
  const statusOf = (id: UpdateStepId): StepStatus =>
    steps.find((step) => step.id === id)?.status ?? "pending";
  return (
    <ol className="space-y-2" aria-label={t("maintenance.modal.steps")} data-slot="update-steps">
      {UPDATE_STEPS.map((id) => {
        const status = statusOf(id);
        const { icon: Icon, className } = STEP_ICON[status];
        return (
          <li
            key={id}
            data-step={id}
            data-status={status}
            aria-current={
              status === "running" || (currentStep === id && status !== "done") ? "step" : undefined
            }
            className="flex items-center gap-3 text-sm"
          >
            <Icon className={cn("size-4 shrink-0", className)} aria-hidden="true" />
            <span
              className={cn(
                "min-w-0 flex-1",
                status === "pending" && "text-muted-foreground",
                status === "running" && "font-medium",
              )}
            >
              {t(stepLabelKey(id, mode))}
            </span>
            <span className="sr-only">{t(stepStatusKey(status))}</span>
          </li>
        );
      })}
    </ol>
  );
}

// --- Terminal states ---------------------------------------------------------------------------------

function SucceededContent({ view, unreachable }: { view: MaintenanceView; unreachable: boolean }) {
  const { t } = useTranslation("updates");
  return (
    <>
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
          <CircleCheck className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 space-y-1">
          <DialogTitle className="text-lg leading-snug font-semibold [overflow-wrap:anywhere]">
            {t(switchKey("maintenance.modal.succeeded.title", view.switchTo), {
              version: view.targetVersion ?? "",
            })}
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            {t(switchKey("maintenance.modal.succeeded.description", view.switchTo))}
          </DialogDescription>
        </div>
      </div>
      {unreachable ? (
        <Alert variant="info" aria-live="polite" data-slot="maintenance-unreachable">
          <Loader2 className="motion-safe:animate-spin" />
          <AlertDescription>{t("maintenance.modal.unreachable")}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

function FailedContent({
  view,
  state,
  isProviderAdmin,
  unreachable,
}: {
  view: MaintenanceView;
  state: Extract<ModalState, { kind: "failed" }>;
  isProviderAdmin: boolean;
  unreachable: boolean;
}) {
  const { t } = useTranslation("updates");
  const { t: tc } = useTranslation();
  const outcome = state.outcome;
  const group =
    outcome === "unchanged"
      ? "unchanged"
      : outcome === "rolled_back"
        ? "rolledBack"
        : outcome === "needs_attention"
          ? "needsAttention"
          : "generic";
  const attention = outcome === "needs_attention";
  const reason = view.failureCode ? t(failureKey(view.failureCode)) : null;

  return (
    <>
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-full",
            attention
              ? "bg-destructive/10 text-destructive-text"
              : "bg-warning/10 text-warning-text",
          )}
        >
          <TriangleAlert className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 space-y-2">
          <DialogTitle className="text-lg leading-snug font-semibold [overflow-wrap:anywhere]">
            {t(switchKey(`maintenance.modal.failed.${group}.title`, view.switchTo))}
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            {attention
              ? isProviderAdmin
                ? t("maintenance.modal.failed.needsAttention.admin")
                : t("maintenance.modal.failed.needsAttention.user", { product: tc("app.name") })
              : t(
                  // Only the two groups that name the running build have a switch wording.
                  group === "unchanged" || group === "rolledBack"
                    ? switchKey(`maintenance.modal.failed.${group}.description`, view.switchTo)
                    : `maintenance.modal.failed.${group}.description`,
                  { product: tc("app.name") },
                )}
          </DialogDescription>
          {reason ? (
            <p className="text-sm" data-slot="maintenance-reason">
              {t("maintenance.modal.failed.reason", { reason })}
            </p>
          ) : null}
        </div>
      </div>
      {unreachable ? (
        <Alert variant="info" aria-live="polite" data-slot="maintenance-unreachable">
          <Loader2 className="motion-safe:animate-spin" />
          <AlertDescription>{t("maintenance.modal.unreachable")}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}
