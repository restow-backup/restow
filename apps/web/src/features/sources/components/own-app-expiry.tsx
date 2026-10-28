import { CalendarClock, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import {
  dateInputValue,
  type ExpiryState,
  expiryState,
  isCalendarDate,
} from "@/features/shared/credential-expiry";
import { ExpiryBadge } from "@/features/shared/credential-expiry-badge";
import { ApiError } from "@/lib/api";
import { problemField, sourceErrorKey } from "../presenters";
import type { OwnAppInfo } from "../types";
import { useUpdateOwnAppExpiry } from "../use-sources";
import { DetailsItem } from "./details-list";

/**
 * The end of a source's own app credential (docs/ENTRA-SETUP.md, "Expiry"): the date an admin
 * noted for a client secret, or a certificate's own notAfter. The worker's monitor pass reminds
 * 30 days before, 7 days before and once it has expired (apps/worker source-app-expiry.ts);
 * the badge here reads the same stages.
 */

/** The date the reminders run on: the certificate's end for a certificate, else the secret's. */
export function ownAppExpiresAt(ownApp: OwnAppInfo): string | null {
  return ownApp.credentialKind === "certificate"
    ? (ownApp.certificateNotAfter ?? ownApp.secretExpiresAt ?? null)
    : (ownApp.secretExpiresAt ?? ownApp.certificateNotAfter ?? null);
}

/**
 * The "Expires" fact of the connection card. For a secret it can be noted or changed in place
 * (PATCH own-app/expiry), without entering the secret again; a certificate's date is its own.
 */
export function OwnAppExpiryItem({
  sourceId,
  ownApp,
  now,
}: {
  sourceId: string;
  ownApp: OwnAppInfo;
  now?: number;
}) {
  const { t } = useTranslation("sources");
  const { t: tc } = useTranslation();
  const update = useUpdateOwnAppExpiry(sourceId);
  const expiresAt = ownAppExpiresAt(ownApp);
  const editable = ownApp.credentialKind === "secret";
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState("");
  const [invalid, setInvalid] = React.useState(false);

  const open = () => {
    setValue(dateInputValue(ownApp.secretExpiresAt));
    setInvalid(false);
    update.reset();
    setEditing(true);
  };

  const save = (date: string | null) => {
    if (date !== null && !isCalendarDate(date)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    update.mutate(date, {
      onSuccess: () => {
        setEditing(false);
        toast.success(t(date === null ? "m365.ownApp.expiry.cleared" : "m365.ownApp.expiry.saved"));
      },
    });
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const date = value.trim();
    save(date.length > 0 ? date : null);
  };

  // A refused date (422 with the issue `date`) reads under the field, anything else below it.
  const refused =
    update.error instanceof ApiError &&
    (update.error.status === 422 || problemField(update.error) === "expires_at");

  return (
    <DetailsItem label={t("m365.ownApp.expiry.label")} className="sm:col-span-2">
      {editing ? (
        <form onSubmit={submit} className="space-y-2 pt-1" noValidate>
          <Field
            id="own-app-expiry-edit"
            label={t("m365.ownApp.expiresAt")}
            hint={t("m365.ownApp.expiresAtHint")}
            error={invalid || refused ? t("m365.ownApp.invalidDate") : undefined}
            className="max-w-xs"
          >
            <Input
              id="own-app-expiry-edit"
              type="date"
              value={value}
              aria-invalid={invalid || refused}
              aria-describedby={messageId("own-app-expiry-edit")}
              onChange={(event) => setValue(event.target.value)}
            />
          </Field>
          {update.error && !refused ? (
            <p role="alert" className="text-sm text-destructive">
              {tc(sourceErrorKey(update.error))}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" loading={update.isPending}>
              {t("m365.ownApp.expiry.save")}
            </Button>
            {ownApp.secretExpiresAt ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={update.isPending}
                onClick={() => save(null)}
              >
                {t("m365.ownApp.expiry.clear")}
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {tc("actions.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <span className="flex flex-wrap items-center gap-2">
          <ExpiryBadge
            expiresAt={expiresAt}
            now={now}
            unknownText={t("m365.ownApp.expiry.unknown")}
          />
          {editable ? (
            <Button type="button" size="sm" variant="ghost" onClick={open}>
              <CalendarClock />
              {expiresAt ? t("m365.ownApp.expiry.edit") : t("m365.ownApp.expiry.add")}
            </Button>
          ) : null}
        </span>
      )}
    </DetailsItem>
  );
}

/** What to do when the credential runs out within the reminder window, or has run out. */
export function OwnAppExpiryAlert({ ownApp, now }: { ownApp: OwnAppInfo; now?: number }) {
  const { t } = useTranslation("sources");
  const state: ExpiryState = expiryState(ownAppExpiresAt(ownApp), now);
  if (state.kind !== "expired" && state.kind !== "soon") {
    return null;
  }
  const red = state.kind === "expired" || state.urgent;
  return (
    <Alert variant={red ? "destructive" : "warning"}>
      <TriangleAlert />
      <AlertDescription>
        {t(state.kind === "expired" ? "m365.ownApp.expiry.expired" : "m365.ownApp.expiry.soon")}
      </AlertDescription>
    </Alert>
  );
}
