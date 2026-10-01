import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, LogOut, MailQuestion, MailWarning, UserPlus, X } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { authClient } from "@/lib/auth-client";
import { LOGIN_PATH } from "@/lib/entry";
import { formatDateTime } from "@/lib/format";
import { meQueryOptions, useSession } from "@/lib/session";

import { ConfirmDialog } from "./components/confirm-dialog";
import { decodeInvitationDetails } from "./decoders";
import { INVITATIONS_PATH, homeTo } from "./paths";
import { type AuthFailure, type InvitationFailure, invitationFailure } from "./presenters";
import type { InvitationDetails } from "./types";

/**
 * The page an invited person opens. The shell has already made sure they
 * are signed in (and brings them back here after signing in). They see which
 * tenant invited them, accept or decline; accepting makes that tenant the
 * active one. Invitations belong to one email address, so a mismatch is
 * explained with the way out: signing in with the invited address.
 */

/** A failed better-auth call, carrying what `invitationFailure` needs. */
class InvitationRequestError extends Error {
  readonly failure: AuthFailure;

  constructor(failure: AuthFailure, message?: string) {
    super(message ?? `Invitation request failed with status ${failure.status}`);
    this.name = "InvitationRequestError";
    this.failure = failure;
  }
}

type AuthResponse<T> = {
  data: T | null;
  error: { status: number; code?: string; message?: string } | null;
};

async function unwrap<T>(call: Promise<AuthResponse<T>>): Promise<T> {
  const { data, error } = await call;
  if (error) {
    throw new InvitationRequestError({ status: error.status, code: error.code }, error.message);
  }
  return data as T;
}

function failureOf(error: unknown): InvitationFailure {
  return error instanceof InvitationRequestError ? invitationFailure(error.failure) : "failed";
}

type Lookup =
  | { state: "loading" }
  | { state: "ready"; details: InvitationDetails | null }
  | { state: "blocked"; failure: Exclude<InvitationFailure, "detailsHidden" | "failed"> }
  | { state: "error"; error: unknown };

export function InvitationPage({ invitationId }: { invitationId: string }) {
  const { t } = useTranslation("tenants");
  const query = useQuery({
    // Under "auth": tenant switches must not refetch it.
    queryKey: ["auth", "invitation", invitationId],
    queryFn: async () =>
      decodeInvitationDetails(
        await unwrap(authClient.organization.getInvitation({ query: { id: invitationId } })),
      ),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  let lookup: Lookup;
  if (query.isPending) {
    lookup = { state: "loading" };
  } else if (query.isSuccess) {
    lookup = { state: "ready", details: query.data };
  } else {
    const failure = failureOf(query.error);
    lookup =
      failure === "detailsHidden"
        ? { state: "ready", details: null }
        : failure === "failed"
          ? { state: "error", error: query.error }
          : { state: "blocked", failure };
  }

  return (
    <div className="mx-auto w-full max-w-xl space-y-6 py-4 sm:py-10">
      <h1 className="sr-only">{t("invitation.pageTitle")}</h1>
      {lookup.state === "loading" ? (
        <InvitationSkeleton />
      ) : lookup.state === "error" ? (
        <ErrorState
          title={t("invitation.error")}
          error={lookup.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : lookup.state === "blocked" ? (
        <BlockedInvitation invitationId={invitationId} failure={lookup.failure} />
      ) : (
        <OpenInvitation invitationId={invitationId} details={lookup.details} />
      )}
    </div>
  );
}

// --- Open invitation ------------------------------------------------------------------

interface OpenInvitationProps {
  invitationId: string;
  /** Null when better-auth withholds the details (the inviter is a provider admin). */
  details: InvitationDetails | null;
}

function OpenInvitation({ invitationId, details }: OpenInvitationProps) {
  const { t, i18n } = useTranslation("tenants");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = useSession();
  const [declineOpen, setDeclineOpen] = React.useState(false);
  const [answerFailure, setAnswerFailure] = React.useState<InvitationFailure | null>(null);

  const accept = useMutation({
    mutationFn: () => unwrap(authClient.organization.acceptInvitation({ invitationId })),
    onSuccess: async () => {
      // better-auth made the tenant the session's active organization; `/me`
      // reports it as the active tenant once re-read.
      await session.refresh();
      const me = await queryClient.fetchQuery({ ...meQueryOptions, staleTime: 0 });
      const joined =
        me.tenants.find((tenant) => tenant.id === me.activeTenantId) ??
        me.tenants.find((tenant) => details?.tenantSlug && tenant.slug === details.tenantSlug);
      if (joined) {
        session.setActiveTenant(joined.id);
        toast.success(t("invitation.accepted", { tenant: joined.name }));
      } else {
        toast.success(t("invitation.acceptedGeneric"));
      }
      await navigate({ to: homeTo(), replace: true });
    },
    onError: (error) => setAnswerFailure(failureOf(error)),
  });

  const decline = useMutation({
    mutationFn: () => unwrap(authClient.organization.rejectInvitation({ invitationId })),
    onSuccess: async () => {
      setDeclineOpen(false);
      toast.success(t("invitation.declined"));
      await navigate({ to: homeTo(), replace: true });
    },
    onError: (error) => {
      setDeclineOpen(false);
      setAnswerFailure(failureOf(error));
    },
  });

  const busy = accept.isPending || decline.isPending;
  const expires = formatDateTime(details?.expiresAt, i18n.language);

  if (answerFailure && answerFailure !== "failed" && answerFailure !== "detailsHidden") {
    return <BlockedInvitation invitationId={invitationId} failure={answerFailure} />;
  }

  return (
    <Card>
      <CardHeader className="flex flex-col items-center text-center">
        <div className="mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <UserPlus aria-hidden="true" className="size-5" />
        </div>
        <CardTitle className="text-xl">
          {details?.tenantName
            ? t("invitation.heading", { tenant: details.tenantName })
            : t("invitation.headingGeneric")}
        </CardTitle>
        <CardDescription>
          {details ? t("invitation.lead", { role: details.role }) : t("invitation.leadGeneric")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="divide-y divide-border rounded-lg border border-border text-sm">
          <DetailRow label={t("invitation.fields.account")} value={session.user?.email ?? null} />
          {details ? (
            <>
              <DetailRow
                label={t("invitation.fields.role")}
                value={t(`members.roles.${details.role}`)}
              />
              <DetailRow label={t("invitation.fields.invitedBy")} value={details.inviterEmail} />
              <DetailRow label={t("invitation.fields.expires")} value={expires} />
            </>
          ) : null}
        </dl>
        {answerFailure === "failed" ? (
          <Alert variant="destructive">
            <MailWarning />
            <AlertDescription>{t("invitation.answerFailed")}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
      <CardFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          variant="outline"
          onClick={() => setDeclineOpen(true)}
          disabled={busy}
          className="w-full sm:w-auto"
        >
          <X />
          {t("invitation.decline")}
        </Button>
        <Button
          onClick={() => {
            setAnswerFailure(null);
            accept.mutate();
          }}
          loading={accept.isPending}
          disabled={decline.isPending}
          className="w-full sm:w-auto"
        >
          {accept.isPending ? null : <Check />}
          {t("invitation.accept")}
        </Button>
      </CardFooter>

      <ConfirmDialog
        open={declineOpen}
        onOpenChange={setDeclineOpen}
        title={t("invitation.declineConfirm.title")}
        description={t("invitation.declineConfirm.description")}
        confirmLabel={t("invitation.declineConfirm.confirm")}
        destructive
        pending={decline.isPending}
        onConfirm={() => {
          setAnswerFailure(null);
          decline.mutate();
        }}
      />
    </Card>
  );
}

function DetailRow({ label, value }: { label: string; value: string | null }) {
  const { t } = useTranslation("tenants");
  return (
    <div className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-all font-medium sm:text-right">{value ?? t("common:time.unknown")}</dd>
    </div>
  );
}

// --- Blocked ------------------------------------------------------------------------

interface BlockedInvitationProps {
  invitationId: string;
  failure: Exclude<InvitationFailure, "detailsHidden" | "failed">;
}

/** Why this invitation cannot be answered by this account, and what to do instead. */
function BlockedInvitation({ invitationId, failure }: BlockedInvitationProps) {
  const { t } = useTranslation("tenants");
  const navigate = useNavigate();
  const { user, signOut } = useSession();
  const [signingOut, setSigningOut] = React.useState(false);

  const switchAccount = async () => {
    setSigningOut(true);
    try {
      await signOut();
      await navigate({
        to: LOGIN_PATH,
        search: { redirect: `${INVITATIONS_PATH}/${encodeURIComponent(invitationId)}` },
        replace: true,
      });
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-col items-center text-center">
        <div className="mb-2 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <MailQuestion aria-hidden="true" className="size-5" />
        </div>
        <CardTitle className="text-xl">{t(`invitation.blocked.${failure}.title`)}</CardTitle>
        <CardDescription>
          {t(`invitation.blocked.${failure}.description`, { email: user?.email ?? "" })}
        </CardDescription>
      </CardHeader>
      <CardFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-center">
        <Button
          variant="outline"
          onClick={() => void navigate({ to: homeTo() })}
          className="w-full sm:w-auto"
        >
          {t("common:actions.backHome")}
        </Button>
        {failure === "wrongRecipient" ? (
          <Button
            onClick={() => void switchAccount()}
            loading={signingOut}
            className="w-full sm:w-auto"
          >
            {signingOut ? null : <LogOut />}
            {t("invitation.switchAccount")}
          </Button>
        ) : null}
      </CardFooter>
    </Card>
  );
}

function InvitationSkeleton() {
  const { t } = useTranslation("tenants");
  return (
    <Card aria-busy="true">
      <CardHeader className="flex flex-col items-center gap-3">
        <Skeleton className="size-12 rounded-full" />
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-4 w-48" />
      </CardHeader>
      <CardContent className="space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </CardContent>
      <span className="sr-only">{t("common:loading.label")}</span>
    </Card>
  );
}
