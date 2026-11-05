import { Ban, Clock, KeyRound, ShieldCheck, Terminal, XCircle } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { ConfirmDialog, StatusBadge } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { isRecentSignInRequired } from "@/lib/recent-sign-in";

import type { RecoveryDetail } from "../api.js";
import {
  useApproveRecovery,
  useCancelRecovery,
  useEndpointFormat,
  useExtendRecoveryCode,
  useRecovery,
  useRevokeRecoveryCode,
  useSetRecoverySshKeys,
} from "../hooks.js";
import {
  endpointErrorKey,
  formatMatchCode,
  RECOVERY_STATUS_TONE,
  recoveryOpen,
} from "../presenters.js";
import { typedAddress } from "./recovery-code-dialog.js";
import { RecoveryVerificationBlock, RecoveryWarnings } from "./recovery-verification.js";

/** How much longer "Extend" asks for. */
const EXTEND_HOURS = 4;

/** The release of a session (9.4): match code, address, ISO version and the hardware the ISO found. */
export function ApprovalBlock({
  recovery,
  onApprove,
  onReject,
  pending,
}: {
  recovery: RecoveryDetail;
  onApprove: () => void;
  onReject: () => void;
  pending: boolean;
}) {
  const { t } = useTranslation("endpoints");
  const format = useEndpointFormat();
  const hardware = recovery.hardware;
  return (
    <section
      className="grid gap-3 rounded-md border border-warning/40 bg-warning/5 p-3"
      data-slot="recovery-approval"
    >
      <h3 className="text-sm font-medium">{t("recovery.live.approveTitle")}</h3>
      <div>
        <span className="text-sm text-muted-foreground">{t("recovery.live.matchCode")}</span>
        <p className="font-mono text-3xl font-semibold tracking-widest" data-slot="match-code">
          {formatMatchCode(recovery.matchCode)}
        </p>
        <p className="text-xs text-muted-foreground">{t("recovery.live.matchCodeHint")}</p>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t("recovery.address")}</dt>
        <dd className="font-mono">
          {recovery.instanceOrigin ? typedAddress(recovery.instanceOrigin) : "-"}
        </dd>
        <dt className="text-muted-foreground">{t("recovery.live.from")}</dt>
        <dd className="font-mono">{recovery.usedIp ?? "-"}</dd>
        <dt className="text-muted-foreground">{t("recovery.live.isoVersion")}</dt>
        <dd>{recovery.recoveryVersion ?? "-"}</dd>
        {hardware ? (
          <>
            <dt className="text-muted-foreground">{t("recovery.live.firmware")}</dt>
            <dd>
              {t(`recovery.live.firmwareMode.${hardware.firmware}`)}
              {hardware.secureBoot === null
                ? ""
                : `, ${t(hardware.secureBoot ? "recovery.live.secureBootOn" : "recovery.live.secureBootOff")}`}
            </dd>
            <dt className="text-muted-foreground">{t("recovery.live.ram")}</dt>
            <dd>{format.bytes(hardware.ramBytes)}</dd>
          </>
        ) : null}
      </dl>
      {hardware ? (
        <div className="grid gap-2 text-sm" data-slot="recovery-hardware">
          <span className="font-medium">{t("recovery.live.disks")}</span>
          <ul className="list-disc pl-5">
            {hardware.disks.map((disk) => (
              <li key={`${disk.serial}-${disk.wwn}-${disk.model}-${disk.sizeBytes}`}>
                {disk.model || t("recovery.live.unknownModel")} · {format.bytes(disk.sizeBytes)}
                {disk.transport ? ` · ${disk.transport}` : ""}
                {disk.serial ? (
                  <span className="ml-1 font-mono text-xs text-muted-foreground">
                    {disk.serial}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <span className="font-medium">{t("recovery.live.nics")}</span>
          <ul className="list-disc pl-5">
            {hardware.nics.map((nic) => (
              <li key={nic.mac}>
                <span className="font-mono">{nic.mac}</span> · {nic.driver}
                {nic.link ? "" : ` · ${t("recovery.live.noLink")}`}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t("recovery.isoReported")}</p>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={onApprove} disabled={pending} data-action="approve-recovery">
          <ShieldCheck aria-hidden="true" />
          {t("recovery.live.approve")}
        </Button>
        <Button
          variant="destructive"
          onClick={onReject}
          disabled={pending}
          data-action="reject-recovery"
        >
          <XCircle aria-hidden="true" />
          {t("recovery.live.reject")}
        </Button>
      </div>
    </section>
  );
}

/** The ISO's progress in its phases (9.8). */
function ProgressBlock({ recovery }: { recovery: RecoveryDetail }) {
  const { t } = useTranslation("endpoints");
  const format = useEndpointFormat();
  const progress = recovery.progress;
  if (!progress) {
    return null;
  }
  const ratio =
    progress.totalBytes > 0
      ? Math.min(100, (progress.bytesDone / progress.totalBytes) * 100)
      : null;
  return (
    <section className="grid gap-2" data-slot="recovery-progress">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium">{t(`recovery.phases.${progress.phase}`)}</span>
        <span className="text-muted-foreground">
          {t("recovery.live.step", { step: progress.step, total: progress.stepsTotal })}
        </span>
      </div>
      {ratio !== null ? <Progress value={ratio} /> : null}
      {progress.totalBytes > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("recovery.live.bytes", {
            done: format.bytes(progress.bytesDone),
            total: format.bytes(progress.totalBytes),
            files: format.integer(progress.filesDone),
            totalFiles: format.integer(progress.totalFiles),
          })}
        </p>
      ) : null}
      {progress.message ? <p className="text-sm whitespace-pre-wrap">{progress.message}</p> : null}
      <p className="text-xs text-muted-foreground">{t("recovery.isoReported")}</p>
    </section>
  );
}

/** Public SSH keys for the ISO's remote access, and the host keys the ISO reported (10.2). */
function SshKeys({ endpointId, recovery }: { endpointId: string; recovery: RecoveryDetail }) {
  const { t } = useTranslation("endpoints");
  const save = useSetRecoverySshKeys(endpointId);
  const identity = useConfirmIdentity();
  const [text, setText] = React.useState(recovery.sshKeys.join("\n"));
  const submit = () => {
    const keys = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    save.mutate(
      { recoveryId: recovery.id, keys },
      {
        onSuccess: () => toast.success(t("recovery.sshKeys.saved")),
        onError: (error) => {
          if (isRecentSignInRequired(error)) {
            identity.ask(submit);
          }
        },
      },
    );
  };
  return (
    <section className="grid gap-2" data-slot="recovery-ssh-keys">
      <Label htmlFor={`ssh-keys-${recovery.id}`}>{t("recovery.sshKeys.title")}</Label>
      <p className="text-xs text-muted-foreground">{t("recovery.sshKeys.hint")}</p>
      <Textarea
        id={`ssh-keys-${recovery.id}`}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={t("recovery.sshKeys.placeholder")}
        rows={3}
        className="font-mono text-xs"
        disabled={!recoveryOpen(recovery.status)}
      />
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={submit}
          disabled={save.isPending || !recoveryOpen(recovery.status)}
        >
          <KeyRound aria-hidden="true" />
          {t("recovery.sshKeys.save")}
        </Button>
      </div>
      {save.error && !isRecentSignInRequired(save.error) ? (
        <p className="text-sm text-destructive-text" role="alert">
          {t(endpointErrorKey(save.error))}
        </p>
      ) : null}
      {recovery.sshHostKeys.length > 0 ? (
        <div className="text-sm" data-slot="recovery-host-keys">
          <span className="font-medium">{t("recovery.sshKeys.hostKeys")}</span>
          <ul className="font-mono text-xs">
            {recovery.sshHostKeys.map((key) => (
              <li key={key.fingerprint}>
                {key.type} {key.fingerprint}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t("recovery.isoReported")}</p>
        </div>
      ) : null}
      {identity.dialog}
    </section>
  );
}

/** The ISO's log, as text only (never HTML). */
export function RecoveryLog({ recovery }: { recovery: RecoveryDetail }) {
  const { t } = useTranslation("endpoints");
  const lines = recovery.log.items.flatMap((item) => item.lines);
  if (lines.length === 0) {
    return null;
  }
  return (
    <section className="grid gap-1" data-slot="recovery-log">
      <span className="flex items-center gap-2 text-sm font-medium">
        <Terminal aria-hidden="true" className="size-4" />
        {t("recovery.live.log")}
      </span>
      <pre className="max-h-80 overflow-auto rounded-md border bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">
        {lines.join("\n")}
      </pre>
      <p className="text-xs text-muted-foreground">{t("recovery.isoReported")}</p>
    </section>
  );
}

export interface RecoveryLiveViewProps {
  recovery: RecoveryDetail;
  endpointId: string;
  pending: boolean;
  onApprove: () => void;
  onCancel: () => void;
  onRevoke: () => void;
  onExtend: () => void;
}

export function RecoveryLiveView(props: RecoveryLiveViewProps) {
  const { t } = useTranslation("endpoints");
  const format = useEndpointFormat();
  const { recovery } = props;
  const open = recoveryOpen(recovery.status);
  return (
    <div className="grid gap-4" data-slot="recovery-live" data-status={recovery.status}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={RECOVERY_STATUS_TONE[recovery.status]} data-slot="recovery-status">
          {t(`recovery.status.${recovery.status}`)}
        </StatusBadge>
        <span className="flex items-center gap-1 text-sm text-muted-foreground">
          <Clock aria-hidden="true" className="size-3.5" />
          {t("recovery.expiresAt")} {format.dateTime(recovery.expiresAt)}
        </span>
      </div>
      {recovery.status === "issued" ? (
        <p className="text-sm text-muted-foreground" data-slot="recovery-waiting">
          {t("recovery.live.waiting")}
        </p>
      ) : null}
      {recovery.status === "pending_approval" ? (
        <ApprovalBlock
          recovery={recovery}
          onApprove={props.onApprove}
          onReject={props.onCancel}
          pending={props.pending}
        />
      ) : null}
      <ProgressBlock recovery={recovery} />
      {recovery.verification ? (
        <RecoveryVerificationBlock verification={recovery.verification} />
      ) : null}
      <RecoveryWarnings warnings={recovery.warnings} />
      {open ? (
        <div className="flex flex-wrap gap-2">
          {recovery.status === "issued" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={props.onRevoke}
              disabled={props.pending}
              data-action="revoke-code"
            >
              <Ban aria-hidden="true" />
              {t("recovery.live.revoke")}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={props.onCancel}
              disabled={props.pending}
              data-action="cancel-recovery"
            >
              <XCircle aria-hidden="true" />
              {t("recovery.live.cancel")}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={props.onExtend}
            disabled={props.pending}
            data-action="extend-code"
          >
            <Clock aria-hidden="true" />
            {t("recovery.live.extend", { count: EXTEND_HOURS })}
          </Button>
        </div>
      ) : null}
      <SshKeys endpointId={props.endpointId} recovery={recovery} />
      <RecoveryLog recovery={recovery} />
    </div>
  );
}

/**
 * The live view of a code and its session (docs/BAREMETAL.md 9.4, 9.8, 14.6): waiting for the ISO,
 * the release with match code and hardware, then the phases with their progress, the log and the
 * SSH keys; revoke, extend and end. Followed every five seconds while it is open.
 */
export function RecoveryLive({
  endpointId,
  recoveryId,
}: {
  endpointId: string;
  recoveryId: string;
}) {
  const { t } = useTranslation("endpoints");
  const query = useRecovery(endpointId, recoveryId);
  const approve = useApproveRecovery(endpointId);
  const cancel = useCancelRecovery(endpointId);
  const revoke = useRevokeRecoveryCode(endpointId);
  const extend = useExtendRecoveryCode(endpointId);
  const identity = useConfirmIdentity();
  const [confirmCancel, setConfirmCancel] = React.useState(false);
  const recovery = query.data;
  const refetch = query.refetch;
  const failed = (error: unknown) => toast.error(t(endpointErrorKey(error)));
  const doApprove = () =>
    approve.mutate(recoveryId, {
      onSuccess: () => void refetch(),
      onError: (error) => (isRecentSignInRequired(error) ? identity.ask(doApprove) : failed(error)),
    });
  const doExtend = () =>
    extend.mutate(
      { codeId: recoveryId, validityHours: EXTEND_HOURS },
      {
        onSuccess: () => void refetch(),
        onError: (error) =>
          isRecentSignInRequired(error) ? identity.ask(doExtend) : failed(error),
      },
    );
  if (!recovery) {
    return null;
  }
  return (
    <Card data-slot="recovery-live-card">
      <CardHeader>
        <CardTitle className="text-base">{t("recovery.live.title")}</CardTitle>
        <CardDescription>{t("recovery.live.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <RecoveryLiveView
          recovery={recovery}
          endpointId={endpointId}
          pending={approve.isPending || cancel.isPending || revoke.isPending || extend.isPending}
          onApprove={doApprove}
          onCancel={() => setConfirmCancel(true)}
          onRevoke={() =>
            revoke.mutate(recoveryId, { onSuccess: () => void refetch(), onError: failed })
          }
          onExtend={doExtend}
        />
        <ConfirmDialog
          open={confirmCancel}
          onOpenChange={setConfirmCancel}
          title={t("recovery.live.cancelTitle")}
          description={<p>{t("recovery.live.cancelDescription")}</p>}
          confirmLabel={t("recovery.live.cancelAction")}
          destructive
          onConfirm={async () => {
            await cancel.mutateAsync(recoveryId);
            void refetch();
          }}
        />
        {identity.dialog}
      </CardContent>
    </Card>
  );
}
