import type { UseQueryResult } from "@tanstack/react-query";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import type * as React from "react";

import { ErrorState } from "@/components/error-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import type { AuditEntry } from "../api";
import type { AuditFormat } from "../hooks";
import { formatDetails } from "../presenters";
import { CopyButton, actorText } from "./actor";

/**
 * Everything recorded for one entry, including the hash values that tie it
 * into its chain. Opened from the table or from a chain break.
 */
export function AuditEntrySheet({
  open,
  entry,
  lookup,
  showTenant,
  format,
  onClose,
}: {
  open: boolean;
  /** The entry when it is at hand (loaded list or lookup). */
  entry: AuditEntry | undefined;
  /** The single-entry lookup for entries outside the loaded list. */
  lookup: UseQueryResult<AuditEntry>;
  showTenant: boolean;
  format: AuditFormat;
  onClose: () => void;
}) {
  const { t } = format;
  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent
        side="right"
        className="flex w-full max-w-none flex-col gap-5 overflow-y-auto p-6 sm:max-w-xl"
      >
        {entry ? (
          <EntryDetails entry={entry} showTenant={showTenant} format={format} />
        ) : lookup.isError ? (
          <>
            <SheetHeader className="p-0">
              <SheetTitle className="text-lg">{t("entry.title")}</SheetTitle>
              <SheetDescription className="sr-only">{t("entry.loadError")}</SheetDescription>
            </SheetHeader>
            <ErrorState
              title={t("entry.loadError")}
              error={lookup.error}
              onRetry={() => void lookup.refetch()}
              retrying={lookup.isFetching}
            />
          </>
        ) : (
          <>
            <SheetHeader className="p-0">
              <SheetTitle className="text-lg">{t("entry.title")}</SheetTitle>
              <SheetDescription className="sr-only">{t("entry.title")}</SheetDescription>
            </SheetHeader>
            <div className="space-y-3">
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[9rem_1fr] sm:gap-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-sm">{children}</dd>
    </div>
  );
}

function HashValue({
  value,
  label,
  format,
}: { value: string; label: string; format: AuditFormat }) {
  return (
    <span className="flex items-start gap-1">
      <code className="min-w-0 flex-1 select-all break-all font-mono text-xs leading-5">
        {value}
      </code>
      <CopyButton value={value} label={label} format={format} />
    </span>
  );
}

function EntryDetails({
  entry,
  showTenant,
  format,
}: {
  entry: AuditEntry;
  showTenant: boolean;
  format: AuditFormat;
}) {
  const { t } = format;
  const label = format.actionLabel(entry.action);
  const details = formatDetails(entry.details);
  const notRecorded = <span className="text-muted-foreground">{t("entry.notRecorded")}</span>;

  return (
    <>
      <SheetHeader className="p-0 pr-8">
        <SheetTitle className="text-lg">{label ?? entry.action}</SheetTitle>
        <SheetDescription>
          <time dateTime={entry.createdAt}>{format.dateTime(entry.createdAt)}</time>
        </SheetDescription>
        <div>
          {entry.hashValid ? (
            <Badge variant="success">
              <ShieldCheck aria-hidden="true" />
              {t("entry.hashValid")}
            </Badge>
          ) : (
            <Badge variant="destructive">
              <ShieldAlert aria-hidden="true" />
              {t("entry.hashInvalid")}
            </Badge>
          )}
        </div>
      </SheetHeader>

      {entry.hashValid ? null : (
        <Alert variant="destructive">
          <ShieldAlert />
          <AlertDescription>{t("entry.hashInvalidHint")}</AlertDescription>
        </Alert>
      )}

      <dl className="space-y-3">
        <Field label={t("entry.time")}>
          <time dateTime={entry.createdAt}>{format.dateTime(entry.createdAt)}</time>
          <span className="block text-xs text-muted-foreground">
            {format.relative(entry.createdAt)}
          </span>
        </Field>
        <Field label={t("entry.action")}>
          <code className="text-xs">{entry.action}</code>
        </Field>
        <Field label={t("entry.actor")}>{actorText(entry.actor, format)}</Field>
        {entry.actorUserId ? (
          <Field label={t("entry.actorUserId")}>
            <code className="text-xs">{entry.actorUserId}</code>
          </Field>
        ) : null}
        {entry.onBehalfOf ? <Field label={t("entry.onBehalfOf")}>{entry.onBehalfOf}</Field> : null}
        {entry.targetLabel ? (
          <Field label={t("entry.targetName")}>{entry.targetLabel}</Field>
        ) : null}
        <Field label={t("entry.target")}>{entry.target ?? notRecorded}</Field>
        {entry.targetType ? (
          <Field label={t("entry.targetType")}>{format.targetTypeLabel(entry.targetType)}</Field>
        ) : null}
        {showTenant ? (
          <Field label={t("entry.tenant")}>{entry.tenantName ?? t("chain.installation")}</Field>
        ) : null}
        <Field label={t("entry.ip")}>
          {entry.ip ? <code className="text-xs">{entry.ip}</code> : notRecorded}
        </Field>
      </dl>

      <Separator />

      <section className="space-y-2">
        <h3 className="text-sm font-medium">{t("entry.details")}</h3>
        {details ? (
          <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-5">
            {details}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">{t("entry.noDetails")}</p>
        )}
      </section>

      <Separator />

      <section className="space-y-3">
        <h3 className="text-sm font-medium">{t("entry.integrity")}</h3>
        <dl className="space-y-3">
          <Field label={t("entry.chainHash")}>
            <HashValue value={entry.chainHash} label={t("entry.chainHash")} format={format} />
          </Field>
          <Field label={t("entry.prevHash")}>
            {entry.prevHash ? (
              <HashValue value={entry.prevHash} label={t("entry.prevHash")} format={format} />
            ) : (
              <span className="text-muted-foreground">{t("entry.firstEntry")}</span>
            )}
          </Field>
          <Field label={t("entry.entryId")}>
            <HashValue value={entry.id} label={t("entry.entryId")} format={format} />
          </Field>
        </dl>
      </section>
    </>
  );
}
