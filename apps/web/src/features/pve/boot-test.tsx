import { useTranslation } from "react-i18next";

import { DetailHover, RelativeTime } from "@/components/kit";
import { Badge } from "@/components/ui/badge";

import type { GuestKind, PveBootTest, PveBootTestOutcome, PveGuestDetail } from "./api.js";
import { PVE_NAMESPACE } from "./i18n.js";

/**
 * Boot tests of a guest's restore points (docs/PVE.md, "Boot test"). Green only for proof: the
 * restored VM's QEMU guest agent answered (a container: its init runs). A VM that only started
 * is amber, one that did not boot red; a test the node skipped or could not carry out is grey.
 */
/**
 * What a boot test's reason stands for, whatever outcome came with it (pveBootTestOutcomeOf in
 * @restow/core, which the server applies; the web app has no dependency on core). Green is
 * proof only: a reason that proves nothing never shows green.
 */
const REASON_OUTCOMES: Readonly<Record<string, PveBootTestOutcome>> = {
  memory_limit: "skipped",
  node_memory: "skipped",
  node_resources: "skipped",
  storage_space: "skipped",
  storage_content: "skipped",
  no_storage: "skipped",
  backup_running: "skipped",
  boot_test_running: "skipped",
  restores_off: "skipped",
  boot_tests_off: "skipped",
  custom_qemu_args: "skipped",
  host_disk: "skipped",
  bridge_not_isolated: "skipped",
  setup_failed: "error",
  io_error: "error",
  node_error: "error",
  no_guest_agent: "yellow",
  guest_agent_silent: "yellow",
  init_unknown: "yellow",
  init_running_unverified: "yellow",
  systemd_degraded: "yellow",
  restore_failed: "red",
  start_failed: "red",
  guest_stopped: "red",
  guest_panicked: "red",
  systemd_emergency: "red",
};

/** Reasons with a text of their own (`guest.bootTestReason.<reason>`); others show the node's message. */
export const BOOT_TEST_REASON_TEXTS = [
  "custom_qemu_args",
  "host_disk",
  "bridge_not_isolated",
  "node_resources",
  "storage_space",
  "setup_failed",
  "io_error",
  "guest_agent_silent",
  "init_running_unverified",
  "systemd_degraded",
  "systemd_emergency",
  "guest_panicked",
] as const;

/**
 * The outcome a boot test stands for: a skipped or error reason rates nothing, a red reason is
 * red, a yellow reason takes a green down to yellow; an unknown reason keeps the outcome.
 */
export function bootTestOutcome(outcome: PveBootTestOutcome, reason = ""): PveBootTestOutcome {
  const meant = REASON_OUTCOMES[reason];
  if (meant === undefined) {
    return outcome;
  }
  if (meant === "yellow") {
    return outcome === "green" ? "yellow" : outcome;
  }
  return meant;
}

export function bootTestVariant(
  outcome: PveBootTestOutcome,
  reason = "",
): "success" | "warning" | "destructive" | "muted" {
  switch (bootTestOutcome(outcome, reason)) {
    case "green":
      return "success";
    case "yellow":
      return "warning";
    case "red":
      return "destructive";
    default:
      return "muted";
  }
}

/** The line under a boot test's badge: why it is green, amber or red. */
export function bootTestDetailKey(
  test: Pick<PveBootTest, "outcome" | "guestAgent"> & { reason?: string },
  kind: GuestKind,
): string | null {
  const reason = test.reason ?? "";
  const outcome = bootTestOutcome(test.outcome, reason);
  if ((BOOT_TEST_REASON_TEXTS as readonly string[]).includes(reason) && outcome !== "green") {
    return `guest.bootTestReason.${reason}`;
  }
  if (outcome === "green") {
    return kind === "ct" || !test.guestAgent
      ? "guest.bootTestDetail.greenContainer"
      : "guest.bootTestDetail.green";
  }
  if (outcome === "yellow" || outcome === "red") {
    return `guest.bootTestDetail.${outcome}`;
  }
  return null;
}

/**
 * The temporary guest a boot test made and could not remove (whatever its outcome), while no
 * later inventory of the node said it is gone; null when nothing is left.
 */
export function bootTestLeftover(
  test:
    | Pick<PveBootTest, "tempVmid" | "cleanedUp" | "storage" | "leftoverGoneAt">
    | null
    | undefined,
): { vmid: number; storage: string | null } | null {
  if (!test || test.tempVmid === null || test.tempVmid === undefined) {
    return null;
  }
  return test.cleanedUp === false && !test.leftoverGoneAt
    ? { vmid: test.tempVmid, storage: test.storage ?? null }
    : null;
}

/** Amber: the temporary guest of a boot test is still on the node, and what to do about it. */
export function BootTestLeftoverNote({
  leftover,
  node,
}: {
  leftover: { vmid: number; storage: string | null };
  node?: string | null;
}) {
  const { t } = useTranslation(PVE_NAMESPACE);
  return (
    <span
      className="max-w-96 text-xs break-words text-warning-text"
      data-slot="pve-boot-test-leftover"
    >
      {leftover.storage
        ? t("guest.bootTestLeftover.onStorage", { vmid: leftover.vmid, storage: leftover.storage })
        : t("guest.bootTestLeftover.plain", { vmid: leftover.vmid })}{" "}
      {t("guest.bootTestLeftover.what", { node: node ?? "?" })}
    </span>
  );
}

export function BootTestBadge({
  test,
  kind,
}: {
  test: PveBootTest | null | undefined;
  kind: GuestKind;
}) {
  const { t } = useTranslation(PVE_NAMESPACE);
  if (!test) {
    return <Badge variant="muted">{t("guest.bootTestNone")}</Badge>;
  }
  const outcome = bootTestOutcome(test.outcome, test.reason);
  const detail = bootTestDetailKey(test, kind);
  const leftover = bootTestLeftover(test);
  // Red says it in the badge; the node's message is the text. The other outcomes, and a red
  // whose reason has a text of its own, explain why.
  const summary =
    detail && (outcome !== "red" || detail.startsWith("guest.bootTestReason."))
      ? t(detail, { seconds: test.bootSeconds === null ? "?" : Math.round(test.bootSeconds) })
      : null;
  const badge = (
    <Badge variant={bootTestVariant(test.outcome, test.reason)}>
      {t(`guest.bootTestOutcome.${outcome}`)}
    </Badge>
  );
  const tone = outcome === "red" ? "destructive" : outcome === "yellow" ? "warning" : "muted";
  return (
    <span className="inline-flex flex-col gap-0.5" data-slot="pve-boot-test">
      {test.message ? (
        <DetailHover text={test.message} title={summary ?? undefined} tone={tone}>
          {badge}
        </DetailHover>
      ) : (
        badge
      )}
      <RelativeTime value={test.checkedAt} focusable={false} className="text-xs" />
      {summary && detail?.startsWith("guest.bootTestReason.") ? (
        <span
          className={`max-w-80 text-xs break-words ${outcome === "red" ? "text-destructive-text" : outcome === "yellow" ? "text-warning-text" : "text-muted-foreground"}`}
          data-slot="pve-boot-test-reason"
        >
          {summary}
        </span>
      ) : null}
      {outcome !== "red" &&
      outcome !== "green" &&
      test.message &&
      test.reason &&
      !(test.reason in REASON_OUTCOMES) ? (
        // A reason of a newer restow-pve this app has no text for: what the node said.
        <span
          className="line-clamp-2 max-w-80 text-xs break-words text-muted-foreground"
          data-slot="pve-boot-test-node-message"
        >
          {test.message}
        </span>
      ) : null}
      {outcome === "red" && test.message ? (
        // What the node saw (restore, start or stop of the temporary guest), not only red.
        <span
          className="line-clamp-2 max-w-80 text-xs break-words text-destructive-text"
          data-slot="pve-boot-test-message"
        >
          {test.message}
        </span>
      ) : null}
      {leftover ? <BootTestLeftoverNote leftover={leftover} /> : null}
    </span>
  );
}

/** What the guest's page says about boot tests: the job's schedule, the last one, or why none. */
export function BootTestFacts({ facts }: { facts: NonNullable<PveGuestDetail["bootTest"]> }) {
  const { t } = useTranslation(PVE_NAMESPACE);
  return (
    <p className="text-sm text-muted-foreground" data-slot="pve-boot-test-facts">
      {facts.blocker
        ? t(`guest.bootTestBlocked.${facts.blocker}`)
        : t(`guest.bootTestSchedule.${facts.schedule}`)}
      {facts.lastBootTestAt ? (
        <>
          {" · "}
          {t("guest.bootTestLast")} <RelativeTime value={facts.lastBootTestAt} focusable={false} />
        </>
      ) : null}
    </p>
  );
}
