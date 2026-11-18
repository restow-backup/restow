import {
  Circle,
  CircleCheck,
  CircleDot,
  Link2,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isRecentSignInRequired } from "@/lib/recent-sign-in";

import type { ApproveOneshotInput, IssuedRecoveryCode, RecoveryDetail } from "../api.js";
import { useEndpointFormat, useIssueRecoveryCode } from "../hooks.js";
import { endpointErrorKey } from "../presenters.js";
import { CommandBox } from "./enroll-dialog.js";

/**
 * Bare metal onto a fresh machine without an ISO (docs/BAREMETAL-ONESHOT.md 18, O8a): the dialog
 * that issues the command, the release with what the machine reported, and the way of a session
 * through its phases with the checklist after a success.
 */

/** The session lengths offered (4 to 48 hours from the issue, default 12; decision 22.12). */
export const ONESHOT_VALIDITY_CHOICES = [4, 8, 12, 24, 48] as const;

/** The command for the provider's rescue system (direct mode, 17.1). */
export function directCommand(command: string): string {
  return command.replace(/ sh$/, " sh -s -- --direct");
}

/** Whole minutes until `at` (0 when passed). */
export function minutesLeft(at: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(at) - now) / 60_000));
}

function useNow(intervalMs: number): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** The command once issued: for a root shell, how long it can be redeemed, and the hints. */
export function IssuedOneshotView({
  issued,
  direct,
  now,
}: {
  issued: IssuedRecoveryCode;
  direct: boolean;
  now?: number;
}) {
  const { t } = useTranslation("endpoints");
  const ticking = useNow(30_000);
  const command = issued.command ?? "";
  const left = minutesLeft(issued.expiresAt, now ?? ticking);
  return (
    <div className="grid gap-4" data-slot="oneshot-issued">
      <p className="text-sm text-muted-foreground">{t("recovery.oneshot.onceHint")}</p>
      <div className="grid gap-1.5">
        <span className="text-sm font-medium">
          {t(direct ? "recovery.oneshot.commandDirect" : "recovery.oneshot.command")}
        </span>
        <CommandBox
          command={direct ? directCommand(command) : command}
          label={t("recovery.oneshot.copy")}
        />
        <p className="text-xs text-muted-foreground" data-slot="oneshot-root-hint">
          {t("recovery.oneshot.rootShell")}
        </p>
      </div>
      <p className="text-sm" data-slot="oneshot-countdown" data-left={left}>
        {left > 0
          ? t("recovery.oneshot.redeemLeft", { count: left })
          : t("recovery.oneshot.redeemOver")}
        {issued.sessionValidityHours
          ? ` ${t("recovery.oneshot.sessionHours", { count: issued.sessionValidityHours })}`
          : ""}
      </p>
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {t("recovery.oneshot.secretHint")}
      </p>
      <p className="text-sm text-muted-foreground" data-slot="oneshot-same-provider">
        {t("recovery.oneshot.sameProvider")}
      </p>
      {direct ? (
        <p className="text-sm text-muted-foreground" data-slot="oneshot-direct-hint">
          {t("recovery.oneshot.directHint")}
        </p>
      ) : null}
    </div>
  );
}

/** The dialog of the action "Onto a fresh machine (link)". */
export function OneshotDialog({
  endpointId,
  machineName,
  snapshotId,
  open,
  onOpenChange,
  onIssued,
}: {
  endpointId: string;
  machineName: string;
  snapshotId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIssued?: (issued: IssuedRecoveryCode) => void;
}) {
  const { t } = useTranslation("endpoints");
  const issue = useIssueRecoveryCode(endpointId);
  const identity = useConfirmIdentity();
  const [validityHours, setValidityHours] = React.useState(12);
  const [direct, setDirect] = React.useState(false);
  const { reset } = issue;
  React.useEffect(() => {
    if (!open) {
      // The command carries the code: forgotten with the dialog.
      reset();
      setValidityHours(12);
      setDirect(false);
    }
  }, [open, reset]);
  const submit = () => {
    issue.mutate(
      {
        kind: "oneshot",
        validityHours,
        requireApproval: true,
        ...(snapshotId ? { snapshotId } : {}),
      },
      {
        onSuccess: (issued) => onIssued?.(issued),
        onError: (error) => {
          if (isRecentSignInRequired(error)) identity.ask(submit);
        },
      },
    );
  };
  const issued = issue.data ?? null;
  const error = issue.error && !isRecentSignInRequired(issue.error) ? issue.error : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent className="sm:max-w-2xl" data-slot="oneshot-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Link2 aria-hidden="true" className="size-4" />
              {t("recovery.oneshot.title", { name: machineName })}
            </DialogTitle>
            <DialogDescription>{t("recovery.oneshot.description")}</DialogDescription>
          </DialogHeader>
          {issued ? (
            <IssuedOneshotView issued={issued} direct={direct} />
          ) : (
            <div className="grid gap-4" data-slot="oneshot-form">
              <div className="grid gap-1.5">
                <Label htmlFor="oneshot-validity">{t("recovery.oneshot.validity")}</Label>
                <Select
                  value={String(validityHours)}
                  onValueChange={(value) => setValidityHours(Number(value))}
                >
                  <SelectTrigger id="oneshot-validity" className="w-full sm:w-60">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ONESHOT_VALIDITY_CHOICES.map((hours) => (
                      <SelectItem key={hours} value={String(hours)}>
                        {t("recovery.validityHours", { count: hours })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t("recovery.oneshot.validityHint")}
                </p>
              </div>
              <RadioGroup
                value={direct ? "direct" : "kexec"}
                onValueChange={(value) => setDirect(value === "direct")}
                className="grid gap-2"
              >
                <div className="flex items-start gap-2">
                  <RadioGroupItem id="oneshot-mode-kexec" value="kexec" />
                  <Label htmlFor="oneshot-mode-kexec" className="grid gap-0.5 font-normal">
                    <span className="font-medium">{t("recovery.oneshot.modeKexec")}</span>
                    <span className="text-xs text-muted-foreground">
                      {t("recovery.oneshot.modeKexecHint")}
                    </span>
                  </Label>
                </div>
                <div className="flex items-start gap-2">
                  <RadioGroupItem id="oneshot-mode-direct" value="direct" />
                  <Label htmlFor="oneshot-mode-direct" className="grid gap-0.5 font-normal">
                    <span className="font-medium">{t("recovery.oneshot.modeDirect")}</span>
                    <span className="text-xs text-muted-foreground">
                      {t("recovery.oneshot.modeDirectHint")}
                    </span>
                  </Label>
                </div>
              </RadioGroup>
              <p className="text-sm text-muted-foreground">{t("recovery.oneshot.eraseHint")}</p>
              <p className="text-sm text-muted-foreground" data-slot="oneshot-ttl">
                {t("recovery.oneshot.ttlHint")}
              </p>
            </div>
          )}
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>{t("recovery.issueFailed")}</AlertTitle>
              <AlertDescription>{t(endpointErrorKey(error))}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t(issued ? "recovery.done" : "recovery.cancel")}
            </Button>
            {issued ? null : (
              <Button onClick={submit} disabled={issue.isPending} data-action="issue-oneshot">
                <Link2 aria-hidden="true" />
                {t("recovery.oneshot.issue")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      ) : null}
      {identity.dialog}
    </Dialog>
  );
}

/** A match code as typed: six digits, with or without the space. */
export function validMatchCode(typed: string): boolean {
  return /^\d{3} ?\d{3}$/.test(typed.trim());
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** The old public addresses as typed (comma or space separated), or null when one is no address. */
export function parseOldAddresses(typed: string): string[] | null {
  const parts = typed
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > 4) return null;
  for (const part of parts) {
    const v6 = part.includes(":") && /^[0-9A-Fa-f:.]+$/.test(part) && part.split("::").length <= 2;
    if (!IPV4.test(part) && !v6) return null;
  }
  return parts;
}

/** Why the machine cannot be released yet (the server refuses the same), or null. */
export function oneshotNotReady(
  recovery: RecoveryDetail,
): "agent_enrolled" | "kexec_failed" | "kexec_not_tried" | null {
  const checks = recovery.oneshot?.reported?.checks;
  if (!checks) return "kexec_not_tried";
  if (checks.inUse?.includes("agent_enrolled")) return "agent_enrolled";
  if (checks.mode === "direct" || checks.kexec === "ok") return null;
  return checks.kexec === "failed" ? "kexec_failed" : "kexec_not_tried";
}

/** What the machine reported, marked as its own word. */
function ReportedMachine({ recovery }: { recovery: RecoveryDetail }) {
  const { t } = useTranslation("endpoints");
  const format = useEndpointFormat();
  const reported = recovery.oneshot?.reported;
  const target = reported?.target;
  const checks = reported?.checks;
  const hardware = recovery.hardware;
  return (
    <div className="grid gap-2 text-sm" data-slot="oneshot-reported">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
        {target ? (
          <>
            <dt className="text-muted-foreground">{t("recovery.oneshot.machine")}</dt>
            <dd>
              {target.hostname}
              {target.vendor || target.product
                ? ` (${[target.vendor, target.product].filter(Boolean).join(" ")})`
                : ""}
              {target.cloud ? ` · ${target.cloud.name} ${target.cloud.region}`.trimEnd() : ""}
              {target.rescue ? ` · ${t("recovery.oneshot.rescue")}` : ""}
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{t("recovery.oneshot.seenFrom")}</dt>
        <dd className="font-mono" data-slot="oneshot-used-ip">
          {recovery.usedIp ?? "-"}
        </dd>
        {hardware ? (
          <>
            <dt className="text-muted-foreground">{t("recovery.live.firmware")}</dt>
            <dd>
              {t(`recovery.live.firmwareMode.${hardware.firmware}`)}
              {hardware.secureBoot === null
                ? ""
                : `, ${t(hardware.secureBoot ? "recovery.live.secureBootOn" : "recovery.live.secureBootOff")}`}
            </dd>
          </>
        ) : null}
        {checks ? (
          <>
            <dt className="text-muted-foreground">{t("recovery.live.ram")}</dt>
            <dd data-slot="oneshot-ram">{format.bytes(checks.memTotalBytes)}</dd>
            <dt className="text-muted-foreground">{t("recovery.oneshot.switch")}</dt>
            <dd
              data-slot="oneshot-kexec"
              data-kexec={checks.mode === "direct" ? "direct" : checks.kexec}
            >
              {checks.mode === "direct"
                ? t("recovery.oneshot.kexec.direct")
                : t(`recovery.oneshot.kexec.${checks.kexec}`)}
              {checks.kexecError ? (
                <span className="ml-1 font-mono text-xs text-muted-foreground">
                  {checks.kexecError}
                </span>
              ) : null}
            </dd>
          </>
        ) : null}
      </dl>
      {target && target.interfaces.length > 0 ? (
        <div data-slot="oneshot-network">
          <span className="font-medium">{t("recovery.oneshot.network")}</span>
          <ul className="list-disc pl-5">
            {target.interfaces.map((iface) => (
              <li key={iface.mac}>
                <span className="font-mono">{iface.name}</span> ·{" "}
                <span className="font-mono text-xs">{iface.mac}</span>
                {iface.addresses.length > 0 ? " · " : ""}
                {iface.addresses
                  .map(
                    (a) =>
                      `${a.address}/${a.prefix}${a.dynamic ? ` (${t("recovery.oneshot.dynamic")})` : ""}`,
                  )
                  .join(", ")}
              </li>
            ))}
            {target.routes.map((route) => (
              <li key={`${route.family}-${route.gateway}`}>
                {t("recovery.oneshot.gateway", { gateway: route.gateway })}
                {route.onlink ? ` (${t("recovery.oneshot.onlink")})` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {hardware ? (
        <div data-slot="oneshot-disks">
          <span className="font-medium">{t("recovery.live.disks")}</span>
          <ul className="list-disc pl-5">
            {hardware.disks.map((disk) => (
              <li key={`${disk.serial}-${disk.wwn}-${disk.model}-${disk.sizeBytes}`}>
                {disk.model || t("recovery.live.unknownModel")} · {format.bytes(disk.sizeBytes)}
                {disk.wwn || disk.serial ? (
                  <span className="ml-1 font-mono text-xs text-muted-foreground">
                    {disk.wwn || disk.serial}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {checks && (checks.inUse.length > 0 || checks.warnings.length > 0) ? (
        <ul className="grid gap-1" data-slot="oneshot-warnings">
          {checks.inUse.map((sign) => (
            <li key={sign} className="flex items-start gap-2 text-warning-text" data-sign={sign}>
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {t(`recovery.oneshot.inUse.${sign}`)}
            </li>
          ))}
          {checks.warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-2" data-warning={warning}>
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {t(`recovery.oneshot.warning.${warning}`, { defaultValue: warning })}
            </li>
          ))}
        </ul>
      ) : null}
      {checks?.lockdown && checks.lockdown !== "none" ? (
        <p className="flex items-start gap-2" data-slot="oneshot-lockdown">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t("recovery.oneshot.lockdown", { mode: checks.lockdown })}
        </p>
      ) : null}
      {reported?.sshKeys && reported.sshKeys.length > 0 ? (
        <div data-slot="oneshot-ssh-keys">
          <span className="font-medium">{t("recovery.oneshot.sshKeys")}</span>
          <ul className="font-mono text-xs">
            {reported.sshKeys.map((key) => (
              <li key={key.fingerprint}>
                {key.type} {key.fingerprint} {key.comment}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">{t("recovery.oneshot.machineReported")}</p>
    </div>
  );
}

/**
 * The release of a session for a fresh machine (6.3): what the machine reported, the network, the
 * permissions (all off by default) and the match code its console shows, which the server compares.
 */
export function OneshotApproval({
  recovery,
  pending,
  onApprove,
  onReject,
}: {
  recovery: RecoveryDetail;
  pending: boolean;
  onApprove: (answers: ApproveOneshotInput) => void;
  onReject: () => void;
}) {
  const { t } = useTranslation("endpoints");
  const [networkMode, setNetworkMode] = React.useState<"takeover" | "keep">("takeover");
  const [oldAddresses, setOldAddresses] = React.useState("");
  const [confirmShrink, setConfirmShrink] = React.useState(false);
  const [secureBootWarningsOnly, setSecureBootWarningsOnly] = React.useState(false);
  const [remoteAccess, setRemoteAccess] = React.useState(false);
  const [matchCode, setMatchCode] = React.useState("");
  const [tried, setTried] = React.useState(false);
  const notReady = oneshotNotReady(recovery);
  const keys = recovery.oneshot?.reported?.sshKeys ?? [];
  const addresses = parseOldAddresses(oldAddresses);
  const codeOk = validMatchCode(matchCode);
  const submit = () => {
    setTried(true);
    if (!codeOk || addresses === null || notReady) return;
    onApprove({
      matchCode: matchCode.replace(/\s/g, ""),
      networkMode,
      confirmShrink,
      secureBootWarningsOnly,
      remoteAccess: remoteAccess && keys.length > 0,
      oldAddresses: addresses,
    });
  };
  return (
    <section
      className="grid gap-4 rounded-md border border-warning/40 bg-warning/5 p-3"
      data-slot="oneshot-approval"
    >
      <h3 className="text-sm font-medium">{t("recovery.oneshot.approveTitle")}</h3>
      <ReportedMachine recovery={recovery} />
      {notReady ? (
        <Alert variant="warning" data-not-ready={notReady}>
          <TriangleAlert />
          <AlertDescription>{t(`recovery.oneshot.notReady.${notReady}`)}</AlertDescription>
        </Alert>
      ) : null}
      <fieldset className="grid gap-2" data-slot="oneshot-network-choice">
        <legend className="text-sm font-medium">{t("recovery.oneshot.networkTitle")}</legend>
        <RadioGroup
          value={networkMode}
          onValueChange={(value) => setNetworkMode(value === "keep" ? "keep" : "takeover")}
          className="grid gap-2"
        >
          {(["takeover", "keep"] as const).map((mode) => (
            <div key={mode} className="flex items-start gap-2">
              <RadioGroupItem id={`oneshot-net-${mode}`} value={mode} />
              <Label htmlFor={`oneshot-net-${mode}`} className="grid gap-0.5 font-normal">
                <span className="font-medium">{t(`recovery.oneshot.net.${mode}`)}</span>
                <span className="text-xs text-muted-foreground">
                  {t(`recovery.oneshot.net.${mode}Hint`)}
                </span>
              </Label>
            </div>
          ))}
        </RadioGroup>
        <div className="grid gap-1">
          <Label htmlFor="oneshot-old-addresses">{t("recovery.oneshot.oldAddresses")}</Label>
          <Input
            id="oneshot-old-addresses"
            value={oldAddresses}
            onChange={(event) => setOldAddresses(event.target.value)}
            placeholder="203.0.113.10"
            aria-invalid={addresses === null}
            className="sm:w-80"
          />
          <p className="text-xs text-muted-foreground">{t("recovery.oneshot.oldAddressesHint")}</p>
          {addresses === null ? (
            <p className="text-sm text-destructive-text" role="alert" data-error="old-addresses">
              {t("recovery.oneshot.oldAddressesInvalid")}
            </p>
          ) : null}
        </div>
      </fieldset>
      <div className="grid gap-2" data-slot="oneshot-permissions">
        {(
          [
            ["confirmShrink", confirmShrink, setConfirmShrink, false],
            ["secureBootWarningsOnly", secureBootWarningsOnly, setSecureBootWarningsOnly, false],
            ["remoteAccess", remoteAccess, setRemoteAccess, keys.length === 0],
          ] as const
        ).map(([name, value, set, disabled]) => (
          <div key={name} className="flex items-start gap-2">
            <Checkbox
              id={`oneshot-${name}`}
              checked={value}
              disabled={disabled}
              onCheckedChange={(checked) => set(checked === true)}
            />
            <Label htmlFor={`oneshot-${name}`} className="grid gap-0.5 font-normal">
              <span>{t(`recovery.oneshot.permission.${name}`)}</span>
              <span className="text-xs text-muted-foreground">
                {t(
                  name === "remoteAccess" && disabled
                    ? "recovery.oneshot.permission.remoteAccessNoKeys"
                    : `recovery.oneshot.permission.${name}Hint`,
                )}
              </span>
            </Label>
          </div>
        ))}
      </div>
      <div className="grid gap-1">
        <Label htmlFor="oneshot-match-code">{t("recovery.oneshot.matchCode")}</Label>
        <Input
          id="oneshot-match-code"
          value={matchCode}
          onChange={(event) => setMatchCode(event.target.value)}
          inputMode="numeric"
          autoComplete="off"
          placeholder="000 000"
          aria-invalid={tried && !codeOk}
          className="font-mono sm:w-40"
          data-slot="oneshot-match-code"
        />
        <p className="text-xs text-muted-foreground">{t("recovery.oneshot.matchCodeHint")}</p>
        {tried && !codeOk ? (
          <p className="text-sm text-destructive-text" role="alert" data-error="match-code">
            {t("recovery.oneshot.matchCodeInvalid")}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={submit}
          disabled={pending || notReady !== null}
          data-action="approve-oneshot"
        >
          <ShieldCheck aria-hidden="true" />
          {t("recovery.oneshot.approve")}
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

/** The way of a oneshot session, in order (6.5). */
export const ONESHOT_STEPS = [
  "registered",
  "waiting_approval",
  "downloading",
  "kexec",
  "booted",
  "restoring",
  "done",
] as const;
export type OneshotStep = (typeof ONESHOT_STEPS)[number];

/**
 * How far a oneshot session got: "booted" only from the recovery environment's report
 * (oneshot.booted), never from a phase the machine claims; restoring from any phase after it.
 */
export function oneshotStepOf(recovery: RecoveryDetail): number {
  const booted = Boolean(recovery.oneshot?.booted ?? recovery.bootedAt);
  if (recovery.status === "succeeded") return ONESHOT_STEPS.indexOf("done");
  const phase = recovery.progress?.phase ?? recovery.phase ?? null;
  if (booted) {
    const before = [
      "registered",
      "waiting_approval",
      "downloading",
      "kexec",
      "booted",
      "connected",
    ];
    return phase && !before.includes(phase)
      ? ONESHOT_STEPS.indexOf("restoring")
      : ONESHOT_STEPS.indexOf("booted");
  }
  if (phase === "kexec") return ONESHOT_STEPS.indexOf("kexec");
  if (phase === "downloading") return ONESHOT_STEPS.indexOf("downloading");
  if (recovery.status === "active") return ONESHOT_STEPS.indexOf("kexec");
  if (recovery.status === "pending_approval") return ONESHOT_STEPS.indexOf("waiting_approval");
  return ONESHOT_STEPS.indexOf("registered");
}

/** The steps of a oneshot session; the current one in the neutral info tone. */
export function OneshotSteps({ recovery }: { recovery: RecoveryDetail }) {
  const { t } = useTranslation("endpoints");
  if (recovery.status === "issued") return null;
  const current = oneshotStepOf(recovery);
  const ended =
    recovery.status === "failed" ||
    recovery.status === "cancelled" ||
    recovery.status === "expired";
  return (
    <ol
      className="grid gap-1 text-sm"
      data-slot="oneshot-steps"
      data-current={ONESHOT_STEPS[current]}
    >
      {ONESHOT_STEPS.map((step, index) => {
        const state =
          index < current ? "done" : index === current ? (ended ? "stopped" : "current") : "next";
        const Icon =
          state === "done"
            ? CircleCheck
            : state === "current"
              ? CircleDot
              : state === "stopped"
                ? XCircle
                : Circle;
        return (
          <li
            key={step}
            data-step={step}
            data-state={state}
            className={
              state === "current"
                ? "flex items-center gap-2 text-info-text"
                : state === "stopped"
                  ? "flex items-center gap-2 text-destructive-text"
                  : state === "next"
                    ? "flex items-center gap-2 text-muted-foreground"
                    : "flex items-center gap-2"
            }
          >
            <Icon aria-hidden="true" className="size-4 shrink-0" />
            {t(`recovery.oneshot.steps.${step}`)}
          </li>
        );
      })}
      {recovery.status === "succeeded" ? (
        <li className="text-xs text-muted-foreground" data-slot="oneshot-restart">
          {t("recovery.oneshot.restartNote")}
        </li>
      ) : null}
    </ol>
  );
}

/** What remains outside the machine after a restore onto a fresh one (13). */
export const ONESHOT_CHECKLIST = [
  "dns",
  "ptr",
  "mail",
  "allowLists",
  "licences",
  "firewalls",
  "login",
  "cloudInit",
  "oldNetwork",
  "nat",
  "oldServer",
] as const;

export function OneshotChecklist({ recovery }: { recovery: RecoveryDetail }) {
  const { t } = useTranslation("endpoints");
  if (recovery.status !== "succeeded") return null;
  return (
    <section className="grid gap-2" data-slot="oneshot-checklist">
      <h3 className="text-sm font-medium">{t("recovery.oneshot.checklist.title")}</h3>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {ONESHOT_CHECKLIST.map((item) => (
          <li key={item} data-item={item}>
            {t(`recovery.oneshot.checklist.${item}`, { id: recovery.id })}
          </li>
        ))}
      </ul>
    </section>
  );
}
