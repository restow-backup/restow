import { MailX, UserMinus, UserPlus, Users } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import {
  PIN_FIRST,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PendingAccountsPanel } from "@/features/accounts/components/pending-accounts-panel";
import type { TenantRole } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useSession } from "@/lib/session";

import { useCancelInvitation, useMembers, useRemoveMember, useUpdateMemberRole } from "../hooks";
import { isExpired, memberChangeError, suggestedRole } from "../presenters";
import type { Invitation, Member } from "../types";
import { ConfirmDialog } from "./confirm-dialog";
import { CopyInvitationLinkButton } from "./copy-link";
import { InviteMemberDialog } from "./invite-member-dialog";
import { RoleSelect } from "./role-select";

interface MembersPanelProps {
  tenantId: string;
  tenantName: string;
  /** No changes while the tenant is being deleted (the API refuses them too). */
  readOnly?: boolean;
  /** Mention that provider admins are not listed (only useful to provider admins). */
  showProviderNote?: boolean;
}

type PendingAction =
  | { kind: "remove"; member: Member }
  | { kind: "cancel"; invitation: Invitation }
  | null;

/**
 * Who can sign in to a tenant and with which role, plus open invitations.
 * Used on the provider's tenant page and on a tenant admin's own members
 * page. Nobody changes or removes their own access here, so an admin cannot
 * lock themselves out by accident.
 */
export function MembersPanel({
  tenantId,
  tenantName,
  readOnly = false,
  showProviderNote = false,
}: MembersPanelProps) {
  const { t } = useTranslation("tenants");
  const query = useMembers(tenantId);
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [pending, setPending] = React.useState<PendingAction>(null);

  const members = query.data?.members ?? [];
  const invitations = query.data?.invitations ?? [];
  const adminCount = [...members, ...invitations].filter(
    (entry) => entry.role === "tenant_admin",
  ).length;

  let body: React.ReactNode;
  if (query.isPending) {
    body = <MembersSkeleton />;
  } else if (query.isError) {
    body = (
      <ErrorState
        title={t("members.error")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  } else if (members.length === 0 && invitations.length === 0) {
    body = (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-10 text-center">
        <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Users className="size-5" aria-hidden="true" />
        </div>
        <div className="max-w-md space-y-1">
          <p className="text-sm font-medium">{t("members.empty.title")}</p>
          <p className="text-sm text-muted-foreground">{t("members.empty.description")}</p>
        </div>
        {readOnly ? null : (
          <Button onClick={() => setInviteOpen(true)}>
            <UserPlus />
            {t("actions.inviteFirst")}
          </Button>
        )}
      </div>
    );
  } else {
    body = (
      <div className="space-y-6">
        {members.length > 0 ? (
          <MemberTable
            tenantId={tenantId}
            members={members}
            readOnly={readOnly}
            onRemove={(member) => setPending({ kind: "remove", member })}
          />
        ) : (
          <p className="text-sm text-muted-foreground">{t("members.noMembersYet")}</p>
        )}
        {invitations.length > 0 ? (
          <InvitationTable
            invitations={invitations}
            readOnly={readOnly}
            onCancel={(invitation) => setPending({ kind: "cancel", invitation })}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
          <div className="space-y-1.5">
            <CardTitle>{t("members.title")}</CardTitle>
            <CardDescription>
              {t("members.description")}
              {showProviderNote ? ` ${t("members.providerNote")}` : null}
            </CardDescription>
          </div>
          {readOnly || query.isPending || query.isError ? null : (
            <Button onClick={() => setInviteOpen(true)}>
              <UserPlus />
              {t("actions.invite")}
            </Button>
          )}
        </CardHeader>
        <CardContent>{body}</CardContent>

        <InviteMemberDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          tenantId={tenantId}
          tenantName={tenantName}
          defaultRole={suggestedRole(adminCount)}
        />
        <PendingActionDialog
          tenantId={tenantId}
          action={pending}
          onClose={() => setPending(null)}
        />
      </Card>

      {readOnly ? null : <PendingAccountsPanel tenantId={tenantId} readOnly={readOnly} />}
    </div>
  );
}

// --- Members ------------------------------------------------------------------------

interface MemberTableProps {
  tenantId: string;
  members: Member[];
  readOnly: boolean;
  onRemove: (member: Member) => void;
}

function MemberTable({ tenantId, members, readOnly, onRemove }: MemberTableProps) {
  const { t, i18n } = useTranslation("tenants");
  const { user } = useSession();
  const updateRole = useUpdateMemberRole(tenantId);
  // The role being saved, shown right away while the request runs.
  const [changing, setChanging] = React.useState<{ userId: string; role: TenantRole } | null>(null);

  const changeRole = (member: Member, role: TenantRole) => {
    if (role === member.role) {
      return;
    }
    setChanging({ userId: member.userId, role });
    updateRole.mutate(
      { userId: member.userId, role },
      {
        onSuccess: () =>
          toast.success(t("toasts.roleChanged", { name: displayName(member), role })),
        onError: (error) => {
          const message = memberChangeError(error);
          toast.error(t(message.key, message.values));
        },
        onSettled: () => setChanging(null),
      },
    );
  };

  return (
    <Table scrollLabel={t("members.title")}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead pin={PIN_FIRST}>{t("members.columns.person")}</TableHead>
          <TableHead>{t("members.columns.role")}</TableHead>
          <TableHead className="hidden md:table-cell">{t("members.columns.joined")}</TableHead>
          <TableHead className="w-12">
            <span className="sr-only">{t("members.columns.actions")}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((member) => {
          const isSelf = member.userId === user?.id;
          const locked = readOnly || isSelf;
          return (
            <TableRow key={member.userId}>
              <TableCell pin={PIN_FIRST} className="min-w-0 max-w-[22rem]">
                <div className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-2 font-medium">
                    <span className="truncate">{displayName(member)}</span>
                    {isSelf ? <Badge variant="secondary">{t("members.you")}</Badge> : null}
                  </span>
                  {member.name ? (
                    <span className="truncate text-xs text-muted-foreground">{member.email}</span>
                  ) : null}
                </div>
              </TableCell>
              <TableCell>
                {locked ? (
                  <span className="text-sm" title={isSelf ? t("members.selfHint") : undefined}>
                    {t(`members.roles.${member.role}`)}
                  </span>
                ) : (
                  <RoleSelect
                    value={changing?.userId === member.userId ? changing.role : member.role}
                    onChange={(role) => changeRole(member, role)}
                    disabled={changing?.userId === member.userId}
                    label={t("members.roleOf", { name: displayName(member) })}
                    className="h-8 sm:w-40"
                  />
                )}
              </TableCell>
              <TableCell className="hidden text-muted-foreground md:table-cell">
                {formatDateTime(member.joinedAt, i18n.language) ?? t("common:time.unknown")}
              </TableCell>
              <TableCell className="text-right">
                {locked ? null : (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onRemove(member)}
                    aria-label={t("members.removeOf", { name: displayName(member) })}
                    title={t("members.removeOf", { name: displayName(member) })}
                  >
                    <UserMinus />
                  </Button>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function displayName(member: Pick<Member, "name" | "email">): string {
  return member.name.trim() || member.email;
}

// --- Invitations --------------------------------------------------------------------

interface InvitationTableProps {
  invitations: Invitation[];
  readOnly: boolean;
  onCancel: (invitation: Invitation) => void;
}

function InvitationTable({ invitations, readOnly, onCancel }: InvitationTableProps) {
  const { t, i18n } = useTranslation("tenants");
  const now = Date.now();
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">
        {t("members.invitations.title", { count: invitations.length })}
      </h3>
      <Table scrollLabel={t("members.invitations.title", { count: invitations.length })}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead pin={PIN_FIRST}>{t("members.invitations.columns.email")}</TableHead>
            <TableHead>{t("members.columns.role")}</TableHead>
            <TableHead className="hidden md:table-cell">
              {t("members.invitations.columns.expires")}
            </TableHead>
            <TableHead className="w-24">
              <span className="sr-only">{t("members.columns.actions")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invitations.map((invitation) => {
            const expired = isExpired(invitation.expiresAt, now);
            return (
              <TableRow key={invitation.id}>
                <TableCell pin={PIN_FIRST} className="min-w-0 max-w-[22rem]">
                  <div className="flex min-w-0 flex-col items-start gap-1">
                    <span className="truncate font-medium">{invitation.email}</span>
                    <Badge variant={expired ? "warning" : "muted"}>
                      {expired
                        ? t("members.invitations.expired")
                        : t("members.invitations.pending")}
                    </Badge>
                  </div>
                </TableCell>
                <TableCell>{t(`members.roles.${invitation.role}`)}</TableCell>
                <TableCell className="hidden text-muted-foreground md:table-cell">
                  {formatDateTime(invitation.expiresAt, i18n.language) ?? t("common:time.unknown")}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    {expired ? null : (
                      <CopyInvitationLinkButton
                        invitationId={invitation.id}
                        email={invitation.email}
                      />
                    )}
                    {readOnly ? null : (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => onCancel(invitation)}
                        aria-label={t("members.invitations.cancelFor", { email: invitation.email })}
                        title={t("members.invitations.cancelFor", { email: invitation.email })}
                      >
                        <MailX />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// --- Confirmations ------------------------------------------------------------------

interface PendingActionDialogProps {
  tenantId: string;
  action: PendingAction;
  onClose: () => void;
}

/** Confirm removing a member or cancelling an invitation. */
function PendingActionDialog({ tenantId, action, onClose }: PendingActionDialogProps) {
  const { t } = useTranslation("tenants");
  const remove = useRemoveMember(tenantId);
  const cancel = useCancelInvitation(tenantId);
  // Keep showing the last action while the dialog fades out.
  const lastAction = React.useRef(action);
  if (action) {
    lastAction.current = action;
  }
  const shown = action ?? lastAction.current;
  const mutation = shown?.kind === "cancel" ? cancel : remove;

  const close = () => {
    remove.reset();
    cancel.reset();
    onClose();
  };

  const confirm = () => {
    if (action?.kind === "remove") {
      remove.mutate(action.member.userId, {
        onSuccess: () => {
          toast.success(t("toasts.memberRemoved", { name: displayName(action.member) }));
          close();
        },
      });
    } else if (action?.kind === "cancel") {
      cancel.mutate(action.invitation.id, {
        onSuccess: () => {
          toast.success(t("toasts.invitationCanceled", { email: action.invitation.email }));
          close();
        },
      });
    }
  };

  const copy =
    shown?.kind === "cancel"
      ? {
          title: t("members.cancelInvitation.title"),
          description: t("members.cancelInvitation.description", {
            email: shown.invitation.email,
          }),
          confirmLabel: t("members.cancelInvitation.confirm"),
          cancelLabel: t("members.cancelInvitation.keep"),
        }
      : {
          title: t("members.remove.title", { name: shown ? displayName(shown.member) : "" }),
          description: t("members.remove.description"),
          confirmLabel: t("members.remove.confirm"),
          cancelLabel: undefined,
        };

  return (
    <ConfirmDialog
      open={action !== null}
      onOpenChange={(open) => !open && close()}
      {...copy}
      destructive
      pending={mutation.isPending}
      error={mutation.error ? memberChangeError(mutation.error) : null}
      onConfirm={confirm}
    />
  );
}

function MembersSkeleton() {
  const { t } = useTranslation("tenants");
  return (
    <div aria-busy="true" className="space-y-3">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-center gap-4">
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-32" />
          </div>
          <Skeleton className="h-8 w-40" />
        </div>
      ))}
      <span className="sr-only">{t("common:loading.label")}</span>
    </div>
  );
}
