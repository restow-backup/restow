import { KeyRound, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog, RelativeTime, StatusBadge } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";

import * as React from "react";
import type { EnrollmentToken } from "../api.js";
import { useEnrollmentTokens, useRevokeToken } from "../hooks.js";
import type { EndpointProfile } from "../paths.js";
import { ProfileBadge } from "./status.js";

/** The enrollment tokens that were created and neither used, revoked nor expired. */
export function pendingTokens(
  tokens: readonly EnrollmentToken[] | undefined,
  profile?: EndpointProfile,
): EnrollmentToken[] {
  return (tokens ?? []).filter(
    (token) => token.state === "valid" && (profile === undefined || token.profile === profile),
  );
}

/** Tokens of the kind the page shows, in whatever state (the "show all" view). */
export function tokensOfProfile(
  tokens: readonly EnrollmentToken[] | undefined,
  profile?: EndpointProfile,
): EnrollmentToken[] {
  return (tokens ?? []).filter((token) => profile === undefined || token.profile === profile);
}

/**
 * Install commands that were created but no machine used yet. The command
 * itself is not kept anywhere and cannot be shown again; what an admin can do
 * here is see that one is open and withdraw it. The card lists the valid
 * commands only; a switch adds the used, expired and revoked ones for a look
 * back. With no valid command the card is not shown at all (and the switch
 * with it): there is nothing to act on, and the audit log keeps the history.
 */
export function PendingTokens({ profile }: { profile?: EndpointProfile }) {
  const { t } = useTranslation("endpoints");
  const tokens = useEnrollmentTokens();
  const revoke = useRevokeToken();
  const [target, setTarget] = React.useState<EnrollmentToken | null>(null);
  const [showAll, setShowAll] = React.useState(false);
  const everything = useEnrollmentTokens({ state: "all", enabled: showAll });
  const pending = pendingTokens(tokens.data, profile);
  if (pending.length === 0) {
    return null;
  }
  const listed = showAll && everything.data ? tokensOfProfile(everything.data, profile) : pending;

  return (
    <Card data-slot="pending-enrollments">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound aria-hidden="true" className="size-4 text-muted-foreground" />
          {t("pending.title")}
        </CardTitle>
        <CardDescription>{t("pending.description")}</CardDescription>
        <div className="flex items-center gap-2 pt-1">
          <Checkbox
            id="pending-show-all"
            checked={showAll}
            onCheckedChange={(checked) => setShowAll(checked === true)}
          />
          <Label htmlFor="pending-show-all" className="text-sm font-normal">
            {t("pending.showAll")}
          </Label>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {listed.map((token) => (
            <li
              key={token.id}
              data-token-state={token.state}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5 first:pt-0 last:pb-0"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <span className="truncate font-medium">
                  {token.displayName?.trim() || t("pending.unnamed")}
                </span>
                {profile === undefined ? <ProfileBadge profile={token.profile} /> : null}
                <span className="text-sm text-muted-foreground">
                  {t("pending.created")} <RelativeTime value={token.createdAt} focusable={false} />
                  {" · "}
                  {t("pending.expires")} <RelativeTime value={token.expiresAt} focusable={false} />
                </span>
              </div>
              {token.state === "valid" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTarget(token)}
                  aria-label={t("pending.revokeFor", {
                    name: token.displayName?.trim() || t("pending.unnamed"),
                  })}
                >
                  <Trash2 aria-hidden="true" />
                  {t("pending.revoke")}
                </Button>
              ) : (
                <StatusBadge tone="muted">{t(`pending.state.${token.state}`)}</StatusBadge>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        title={t("pending.confirm.title")}
        description={<p>{t("pending.confirm.description")}</p>}
        confirmLabel={t("pending.confirm.action")}
        destructive
        onConfirm={async () => {
          if (!target) return;
          await revoke.mutateAsync(target.id);
          toast.success(t("pending.revoked"));
        }}
      />
    </Card>
  );
}
