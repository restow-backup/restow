import * as React from "react";

import "../i18n";
import type { SuspicionTarget } from "../api";
import { useObjectSuspicions } from "../hooks";
import { judgementsById, type PointRef } from "../presenters";
import { LastCleanHint, SelectedPointNote } from "./last-clean-hint";
import { RetentionHoldNotice } from "./retention-hold-notice";
import { SuspicionBadge } from "./suspicion-badge";

/**
 * The ransomware marks of a restore view that has a timeline of its own (the explorer of a
 * mailbox or OneDrive): the paused retention while a suspicious restore point holds it, the hint
 * at the last clean restore point while the newest one is suspicious, and the badge and note of
 * the chosen restore point when it is. Nothing while there is nothing to say.
 */
export function RestorePointSuspicion<P extends PointRef>({
  target,
  objectName,
  points,
  selected,
  onPick,
}: {
  target: SuspicionTarget | null;
  objectName: string;
  points: readonly P[];
  selected: P | null;
  onPick: (point: P) => void;
}) {
  const suspicions = useObjectSuspicions(target);
  const judgements = React.useMemo(
    () => judgementsById(suspicions.data?.restorePoints),
    [suspicions.data],
  );
  const judgement = selected ? judgements.get(selected.id) : undefined;
  if (judgements.size === 0) {
    return null;
  }
  return (
    <div className="space-y-2" data-slot="restore-point-suspicion">
      <RetentionHoldNotice target={target} objectName={objectName} />
      <LastCleanHint points={points} judgements={judgements} onPick={onPick} />
      {selected && judgement?.verdict === "suspicious" ? (
        <div className="flex flex-wrap items-center gap-2">
          <SuspicionBadge judgement={judgement} objectName={objectName} />
          <SelectedPointNote point={selected} points={points} judgements={judgements} />
        </div>
      ) : null}
    </div>
  );
}
