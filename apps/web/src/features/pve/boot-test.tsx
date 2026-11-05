import { CircleSlash } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  DetailHover,
  RelativeTime,
  StatusBadge,
  type StatusMeta,
  toneOf,
  VERIFICATION_META,
} from "@/components/kit";

import type { GuestKind, PveBootTest, PveBootTestOutcome, PveGuestDetail } from "./api.js";
import { PVE_NAMESPACE } from "./i18n.js";

/**
 * A boot test the node skipped or could not carry out: no proof either way, so muted (its
 * label is the outcome's own, `guest.bootTestOutcome.<outcome>`).
 */
const BOOT_TEST_NOT_RUN_META: StatusMeta = {
  id: "not_run",
  severity: "muted",
  labelKey: "pve:guest.bootTestOutcome.skipped",
  icon: CircleSlash,
  pattern: "solid",
};

/**
 * Boot tests of a guest's restore points (docs/PVE.md, "Boot test"), in the look of a
 * verification (status meta, UI rework phase 1). Green only for proof: the restored VM's QEMU
 * guest agent answered (a container: its init runs). A VM that only started needs attention
 * (orange, the meta's yellow), one that did not boot is red; a test the node skipped or could not
 * carry out is grey.
 */
export function bootTestMeta(outcome: PveBootTestOutcome): StatusMeta {
  return outcome === "green" || outcome === "yellow" || outcome === "red"
    ? VERIFICATION_META[outcome]
    : BOOT_TEST_NOT_RUN_META;
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

export function BootTestBadge({
  test,
  kind,
}: {
  test: PveBootTest | null | undefined;
  kind: GuestKind;
}) {
  const { t } = useTranslation(PVE_NAMESPACE);
  if (!test) {
    return (
      <StatusBadge tone={toneOf(BOOT_TEST_NOT_RUN_META)} icon={BOOT_TEST_NOT_RUN_META.icon}>
        {t("guest.bootTestNone")}
      </StatusBadge>
    );
  }
  const detail = bootTestDetailKey(test, kind);
  // Red says it in the badge; the node's message is the text. The other outcomes explain why.
  const summary =
    detail && test.outcome !== "red"
      ? t(detail, { seconds: test.bootSeconds === null ? "?" : Math.round(test.bootSeconds) })
      : null;
  const meta = bootTestMeta(test.outcome);
  const badge = (
    <StatusBadge tone={toneOf(meta)} icon={meta.icon} data-outcome={test.outcome}>
      {t(`guest.bootTestOutcome.${test.outcome}`)}
    </StatusBadge>
  );
  // The hover's text block has no attention look: a finding is shown as a warning text there.
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
