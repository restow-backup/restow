import { useTranslation } from "react-i18next";

import { CopyButton } from "@/components/kit/copy-button";
import { RelativeTime } from "@/components/kit/relative-time";

import type { PveGuestDetail, PveRun } from "./api.js";
import { PVE_NAMESPACE } from "./i18n.js";
import { restoreFindings } from "./run-status.js";

/** Lines as the node sent them, monospaced: configuration lines, commands, log lines. */
function Lines({ lines, copy }: { lines: readonly string[]; copy?: string }) {
  return (
    <div className="flex items-start gap-1">
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted px-2 py-1 font-mono text-xs">
        {lines.join("\n")}
      </pre>
      {copy ? <CopyButton value={lines.join("\n")} label={copy} size="icon-xs" /> : null}
    </div>
  );
}

/**
 * What a restore or restore check reported beside its success (run-status.ts
 * `restoreFindings`), each with what to do: a temporary guest that is still there, a start that
 * did not happen, mount points left out (and how to put them back), the restore task's warnings,
 * raw LXC options and host devices. Nothing when there is nothing to say.
 */
export function RestoreFindings({
  run,
}: {
  run: Pick<PveRun, "kind" | "status" | "stats" | "warnings">;
}) {
  const { t } = useTranslation(PVE_NAMESPACE);
  const findings = restoreFindings(run);
  const stats = run.stats ?? {};
  const check = run.kind === "restore_test";
  const notes: string[] = [];
  if (run.status === "succeeded" && stats.madeUnprivileged) {
    notes.push(t("guest.restoreFinding.madeUnprivileged"));
  }
  if (run.status === "succeeded" && stats.onbootCleared) {
    notes.push(t("guest.restoreFinding.onbootCleared"));
  }
  if (stats.readFrom) {
    // The primary no longer held the container's repository: the restore read its copy.
    notes.push(
      t("guest.restoreFinding.readFromCopy", {
        target: stats.readFrom.targetName ?? t("guest.restoreFinding.readFromUnnamed"),
      }),
    );
  }
  if (findings.length === 0 && notes.length === 0) {
    return null;
  }
  const warnings = stats.warnings ?? run.warnings ?? [];
  return (
    <ul className="space-y-2 text-sm" data-slot="pve-restore-findings">
      {findings.includes("leftover") ? (
        <li data-finding="leftover">
          {t("guest.restoreFinding.leftoverDetail", {
            vmid: stats.leftoverVmid ?? stats.vmid ?? "?",
          })}
        </li>
      ) : null}
      {findings.includes("notStarted") ? (
        <li data-finding="notStarted">
          {stats.startError
            ? t("guest.restoreFinding.startFailed", { error: stats.startError })
            : t(`guest.restoreFinding.startSkipped.${stats.startSkipped ?? "other"}`, {
                defaultValue: t("guest.restoreFinding.startSkipped.other"),
              })}
        </li>
      ) : null}
      {findings.includes("omittedMounts") ? (
        <li className="space-y-1" data-finding="omittedMounts">
          <p>
            {t(
              check
                ? "guest.restoreFinding.omittedMountsCheck"
                : "guest.restoreFinding.omittedMountsRestore",
              { count: stats.omittedMounts?.length ?? 0 },
            )}
          </p>
          <Lines lines={stats.omittedMounts ?? []} />
          {!check && (stats.remountCommands ?? []).length > 0 ? (
            <>
              <p>{t("guest.restoreFinding.remount")}</p>
              <Lines
                lines={stats.remountCommands ?? []}
                copy={t("guest.restoreFinding.copyCommands")}
              />
            </>
          ) : null}
          {!check ? (
            <p className="text-warning-text">{t("guest.restoreFinding.sharedData")}</p>
          ) : null}
        </li>
      ) : null}
      {findings.includes("warnings") ? (
        <li className="space-y-1" data-finding="warnings">
          <p>{t("guest.restoreFinding.warningsDetail", { count: warnings.length })}</p>
          <Lines lines={warnings} />
        </li>
      ) : null}
      {findings.includes("skippedLxc") ? (
        <li className="space-y-1" data-finding="skippedLxc">
          <p>{t("guest.restoreFinding.skippedLxcDetail")}</p>
          <Lines lines={stats.skippedLxc ?? []} copy={t("guest.restoreFinding.copyLines")} />
          {stats.customIdmap ? <p>{t("guest.restoreFinding.customIdmap")}</p> : null}
        </li>
      ) : null}
      {findings.includes("keptDevices") ? (
        <li className="space-y-1" data-finding="keptDevices">
          <p>{t("guest.restoreFinding.keptDevicesDetail")}</p>
          <Lines lines={stats.keptDevices ?? []} />
        </li>
      ) : null}
      {notes.map((note) => (
        <li key={note} className="text-muted-foreground">
          {note}
        </li>
      ))}
    </ul>
  );
}

/**
 * What the guest's page says about the job's monthly restore check: why the node cannot run it
 * (restores off, offline: the check waits and is not counted as done), or when the last ran.
 * Nothing when the job asks for none.
 */
export function RestoreCheckFacts({
  facts,
}: {
  facts: NonNullable<PveGuestDetail["restoreCheck"]>;
}) {
  const { t } = useTranslation(PVE_NAMESPACE);
  if (!facts.enabled) {
    return null;
  }
  return (
    <p className="text-sm text-muted-foreground" data-slot="pve-restore-check-facts">
      {facts.blocker ? (
        t(`guest.restoreCheckBlocked.${facts.blocker}`, { node: facts.node ?? "?" })
      ) : facts.lastRestoreTestAt ? (
        <>
          {t("guest.restoreCheckLast")}{" "}
          <RelativeTime value={facts.lastRestoreTestAt} focusable={false} />
        </>
      ) : (
        t("guest.restoreCheckNone")
      )}
    </p>
  );
}
