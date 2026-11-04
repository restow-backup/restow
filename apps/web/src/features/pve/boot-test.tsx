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
export function bootTestVariant(
  outcome: PveBootTestOutcome,
): "success" | "warning" | "destructive" | "muted" {
  switch (outcome) {
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
  test: Pick<PveBootTest, "outcome" | "guestAgent">,
  kind: GuestKind,
): string | null {
  if (test.outcome === "green") {
    return kind === "ct" || !test.guestAgent
      ? "guest.bootTestDetail.greenContainer"
      : "guest.bootTestDetail.green";
  }
  if (test.outcome === "yellow" || test.outcome === "red") {
    return `guest.bootTestDetail.${test.outcome}`;
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
  const detail = bootTestDetailKey(test, kind);
  const leftover = bootTestLeftover(test);
  // Red says it in the badge; the node's message is the text. The other outcomes explain why.
  const summary =
    detail && test.outcome !== "red"
      ? t(detail, { seconds: test.bootSeconds === null ? "?" : Math.round(test.bootSeconds) })
      : null;
  const badge = (
    <Badge variant={bootTestVariant(test.outcome)}>
      {t(`guest.bootTestOutcome.${test.outcome}`)}
    </Badge>
  );
  const tone =
    test.outcome === "red" ? "destructive" : test.outcome === "yellow" ? "warning" : "muted";
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
      {test.outcome === "red" && test.message ? (
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
