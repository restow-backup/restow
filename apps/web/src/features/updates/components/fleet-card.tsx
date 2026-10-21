import { CalendarClock } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "@/components/kit/confirm-dialog";
import { RelativeTime } from "@/components/kit/relative-time";
import { StatusBadge, type StatusTone } from "@/components/kit/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";

import type { FleetMember, FleetMemberState, FleetStatus, UpdatesView } from "../api";
import { useCancelMaintenance } from "../hooks";
import { countdownLabel, updatesErrorKey } from "../presenters";
import { CommandBlock } from "./command-block";

/**
 * An update planned for a chosen time (0.4.2): which version, when (in the installation's time
 * zone), with which countdown, who planned it, and the way out. Nothing is paused before it.
 */
export function PlannedCard({ view, canChange }: { view: UpdatesView; canChange: boolean }) {
  const { t, i18n } = useTranslation("updates");
  const { t: tc } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const cancel = useCancelMaintenance();
  const [confirming, setConfirming] = React.useState(false);
  const plan = view.planned;
  if (!plan) {
    return null;
  }
  const lead = countdownLabel(plan.leadSeconds);
  return (
    <Alert variant="info" data-slot="update-planned">
      <CalendarClock />
      <AlertTitle>{t("planned.title", { version: plan.version })}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>
          {t("planned.body", {
            date: plan.at.date,
            time: plan.at.time,
            zone: plan.timeZone,
            local: formatDateTime(plan.startsAt, language) ?? "",
            by: plan.requestedBy,
          })}
        </p>
        <p>{t("planned.countdown", { lead: t(lead.key, lead.params) })}</p>
        {canChange ? (
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => setConfirming(true)}>
              {t("planned.cancel")}
            </Button>
          </div>
        ) : null}
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={t("planned.cancelTitle", { version: plan.version })}
          description={t("planned.cancelBody")}
          confirmLabel={t("planned.cancel")}
          cancelLabel={tc("actions.cancel")}
          destructive
          pending={cancel.isPending}
          error={cancel.error ? t(updatesErrorKey(cancel.error)) : undefined}
          onConfirm={() => cancel.mutateAsync().then(() => setConfirming(false))}
        />
      </AlertDescription>
    </Alert>
  );
}

const STATE_TONE: Record<FleetMemberState, StatusTone> = {
  updated: "neutral",
  pending: "info",
  unreachable: "warning",
  paused: "muted",
};

/** `0.4.2-rc.1` -> [0, 4, 2]; null for what is no release version. */
function releaseOf(version: string | null | undefined): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version?.trim() ?? "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Whether `version` is a release before `since` (an unknown version counts as older). */
export function olderThan(version: string | null, since: string): boolean {
  const have = releaseOf(version);
  const want = releaseOf(since);
  if (!want) {
    return false;
  }
  if (!have) {
    return true;
  }
  for (let index = 0; index < 3; index++) {
    const difference = (have[index] ?? 0) - (want[index] ?? 0);
    if (difference !== 0) {
      return difference < 0;
    }
  }
  return false;
}

export interface ManualCommand {
  command: string;
  /** An agent before 0.4.2, which has no `update` command: its service is restarted instead. */
  legacy: boolean;
}

/** What to run by hand on a member that was not reached. */
export function manualCommand(
  commands: FleetStatus["commands"],
  member: Pick<FleetMember, "kind" | "os" | "version">,
): ManualCommand | null {
  if (member.kind === "pve_node") {
    return { command: commands.pve_node, legacy: false };
  }
  if (member.os !== "darwin" && member.os !== "linux") {
    return null;
  }
  const legacy =
    commands.legacy !== undefined &&
    commands.agentUpdateSince !== undefined &&
    olderThan(member.version, commands.agentUpdateSince);
  return legacy && commands.legacy
    ? { command: commands.legacy[member.os], legacy: true }
    : { command: commands[member.os], legacy: false };
}

/**
 * Proxmox VE nodes and endpoint agents follow the server (0.4.2): while the pause of new runs
 * holds after an update (the phase `fleet`, at most 15 minutes) they update themselves; this
 * card shows how far they are, the ones still to come, and for the unreachable ones the command
 * for an update by hand. Outside an update it lists what is behind, if anything.
 */
export function FleetCard({ view }: { view: UpdatesView }) {
  const { t, i18n } = useTranslation("updates");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const fleet = view.fleet;
  const pause = view.jobPause;
  const following = pause?.phase === "fleet";
  if (!fleet || fleet.counts.all.total === 0) {
    return null;
  }
  const all = fleet.counts.all;
  const behind = all.pending + all.unreachable + all.paused;
  if (!following && behind === 0) {
    return null;
  }
  const percent = all.total > 0 ? Math.round((all.updated / all.total) * 100) : 100;
  const unreachable = fleet.members.filter((member) => member.state === "unreachable");
  const manual = unreachable.flatMap((member) => manualCommand(fleet.commands, member) ?? []);
  const current = [
    ...new Set(manual.filter((entry) => !entry.legacy).map((entry) => entry.command)),
  ];
  const legacy = [...new Set(manual.filter((entry) => entry.legacy).map((entry) => entry.command))];
  return (
    <Card data-slot="update-fleet" data-following={following ? "true" : undefined}>
      <CardHeader>
        <CardTitle>{t("fleet.title", { version: fleet.targetVersion })}</CardTitle>
        <CardDescription>
          {following && pause
            ? t("fleet.following", { time: formatDateTime(pause.deadlineAt, language) ?? "" })
            : t("fleet.behind")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Progress value={percent} aria-label={t("fleet.progressLabel")} />
          <p className="text-sm text-muted-foreground tabular-nums" data-slot="fleet-counts">
            {t("fleet.counts", {
              updated: all.updated,
              total: all.total,
              pending: all.pending,
              unreachable: all.unreachable,
              paused: all.paused,
            })}
          </p>
        </div>
        {fleet.members.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("fleet.name")}</TableHead>
                <TableHead>{t("fleet.tenant")}</TableHead>
                <TableHead>{t("fleet.version")}</TableHead>
                <TableHead>{t("fleet.state")}</TableHead>
                <TableHead>{t("fleet.lastSeen")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fleet.members.map((member) => (
                <TableRow key={`${member.kind}:${member.id}`} data-state={member.state}>
                  <TableCell className="font-medium">
                    {member.name}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {t(`fleet.kind.${member.kind}`)}
                    </span>
                  </TableCell>
                  <TableCell>{member.tenantName}</TableCell>
                  <TableCell className="font-mono text-xs">{member.version ?? "–"}</TableCell>
                  <TableCell>
                    <StatusBadge tone={STATE_TONE[member.state]}>
                      {t(`fleet.states.${member.state}`)}
                    </StatusBadge>
                  </TableCell>
                  <TableCell>
                    <RelativeTime value={member.lastSeenAt} fallback={t("fleet.never")} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
        {fleet.truncated ? (
          <p className="text-xs text-muted-foreground">{t("fleet.truncated")}</p>
        ) : null}
        {unreachable.length > 0 ? (
          <div className="space-y-2" data-slot="fleet-manual">
            <p className="text-sm">{t("fleet.manual")}</p>
            {current.map((command) => (
              <CommandBlock key={command} command={command} copyLabel={t("fleet.copy")} />
            ))}
            {legacy.length > 0 ? (
              <>
                <p className="text-sm text-muted-foreground" data-slot="fleet-manual-legacy">
                  {t("fleet.manualLegacy", {
                    version: fleet.commands.agentUpdateSince ?? "0.4.2",
                  })}
                </p>
                {legacy.map((command) => (
                  <CommandBlock key={command} command={command} copyLabel={t("fleet.copy")} />
                ))}
              </>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
