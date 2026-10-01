import {
  AlertTriangle,
  Cloud,
  Inbox,
  Mail,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { StatusBadge } from "@/components/kit";
import type { ObjectKind, ObjectState, Reason, StorageState } from "@/features/verify/api";
import { STORAGE_BADGE, reasonMessage, stateBadgeView } from "@/features/verify/presenters";
import { cn } from "@/lib/utils";

const STATE_ICON = {
  green: ShieldCheck,
  yellow: ShieldAlert,
  red: ShieldX,
  unverified: ShieldQuestion,
  no_backup: ShieldQuestion,
} as const;

/**
 * The rating of an object, with an icon so it never relies on colour alone.
 * `overdue` decides the tone and label of a `no_backup` state: waiting for
 * its first backup (warning) or a real problem past the grace period (red).
 *
 * Unlike the base `StatusBadge` (which wraps by design so a long dynamic
 * status stays readable), this one's vocabulary is a handful of short fixed
 * words: it always sets `whitespace-nowrap` itself, so it never wraps onto a
 * second line regardless of the column it ends up in.
 */
export function StateBadge({
  state,
  overdue = false,
  className,
}: {
  state: ObjectState;
  overdue?: boolean;
  className?: string;
}) {
  const { t } = useTranslation("verify");
  const { tone, key } = stateBadgeView({ state, overdue });
  return (
    <StatusBadge
      tone={tone}
      icon={STATE_ICON[state]}
      className={cn("whitespace-nowrap", className)}
    >
      {t(key)}
    </StatusBadge>
  );
}

export function StorageBadge({ state }: { state: StorageState }) {
  const { t } = useTranslation("verify");
  return <StatusBadge tone={STORAGE_BADGE[state]}>{t(`storage.state.${state}`)}</StatusBadge>;
}

const KIND_ICON = { mailbox: Mail, onedrive: Cloud, imap: Inbox } as const;

export function ObjectKindIcon({ kind, className }: { kind: ObjectKind; className?: string }) {
  const { t } = useTranslation("verify");
  const Icon = KIND_ICON[kind];
  return (
    <Icon
      className={cn("size-4 shrink-0 text-muted-foreground", className)}
      aria-label={t(`kind.${kind}`)}
      role="img"
    />
  );
}

/** Every finding of a report, red ones first, each in plain language. */
export function ReasonList({
  reasons,
  className,
}: { reasons: readonly Reason[]; className?: string }) {
  const { t } = useTranslation("verify");
  return (
    <ul className={cn("space-y-2", className)}>
      {reasons.map((reason) => {
        const { key, values } = reasonMessage(reason);
        const Icon = reason.severity === "red" ? XCircle : AlertTriangle;
        return (
          <li
            key={`${reason.code}-${reason.count ?? ""}`}
            className="flex items-start gap-2 text-sm"
          >
            <Icon
              aria-hidden="true"
              className={cn(
                "mt-0.5 size-4 shrink-0",
                reason.severity === "red"
                  ? "text-destructive"
                  : "text-warning-foreground dark:text-warning",
              )}
            />
            <span>{t(key, values)}</span>
          </li>
        );
      })}
    </ul>
  );
}
