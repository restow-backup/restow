import { KeyRound, Link2, Pencil, Plus, ShieldAlert, Trash2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { ErrorState } from "@/components/error-state";
import { ConfirmDialog, RelativeTime, usePageWidth } from "@/components/kit";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
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
import { isRecentSignInRequired } from "@/lib/recent-sign-in";

import type { Invitation, TeamMember } from "./api";
import {
  useReissueInvitation,
  useRemoveMember,
  useResetAccess,
  useTeam,
  useTeamScope,
  useTenantChoices,
} from "./hooks";
import { IssuedLinkResult, MemberDialog } from "./member-dialog";
import { STATUS_VARIANT, teamErrorKey } from "./presenters";

/**
 * Members (the provider team, every edition): every provider admin with
 * their role, tenants and sign-in state. Owners invite, change, remove and
 * reset the access of a member who lost their way to sign in; everyone else
 * with every tenant sees the members read-only.
 */
export function TeamPage() {
  const { t } = useTranslation("team");
  const scope = useTeamScope();
  const team = useTeam();
  const [editing, setEditing] = React.useState<TeamMember | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  usePageWidth("wide");

  const openInvite = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("subtitle")}>
        {scope.canManage ? (
          <Button onClick={openInvite}>
            <Plus aria-hidden="true" />
            {t("invite")}
          </Button>
        ) : null}
      </PageHeader>

      {!scope.canView ? (
        <Alert variant="warning">
          <ShieldAlert />
          <AlertTitle>{t("title")}</AlertTitle>
          <AlertDescription>{t("ownersOnly")}</AlertDescription>
        </Alert>
      ) : team.isPending ? (
        <Card>
          <CardContent className="space-y-3 p-6">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </CardContent>
        </Card>
      ) : team.isError ? (
        <ErrorState
          title={t("loadError")}
          error={team.error}
          onRetry={() => void team.refetch()}
          retrying={team.isFetching}
        />
      ) : (
        <>
          {scope.canManage ? null : (
            <p className="text-sm text-muted-foreground">{t("ownersOnly")}</p>
          )}
          <Card>
            <CardContent className="p-0">
              <TeamTable
                members={team.data.items}
                canManage={scope.canManage}
                onEdit={(member) => {
                  setEditing(member);
                  setDialogOpen(true);
                }}
              />
            </CardContent>
          </Card>
        </>
      )}

      {scope.canManage ? (
        <MemberDialog member={editing} open={dialogOpen} onOpenChange={setDialogOpen} />
      ) : null}
    </div>
  );
}

function TeamTable({
  members,
  canManage,
  onEdit,
}: {
  members: TeamMember[];
  canManage: boolean;
  onEdit: (member: TeamMember) => void;
}) {
  const { t } = useTranslation("team");
  const tenants = useTenantChoices();
  const tenantName = (id: string) => tenants.data?.find((tenant) => tenant.id === id)?.name ?? id;
  return (
    <Table className="min-w-[44rem]" scrollLabel={t("title")}>
      <TableHeader>
        <TableRow>
          <TableHead pin={PIN_FIRST}>{t("columns.member")}</TableHead>
          <TableHead>{t("columns.role")}</TableHead>
          <TableHead>{t("columns.tenants")}</TableHead>
          <TableHead>{t("columns.status")}</TableHead>
          {canManage ? (
            <TableHead className="text-right">
              <span className="sr-only">{t("columns.actions")}</span>
            </TableHead>
          ) : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((member) => (
          <TableRow key={member.userId}>
            <TableCell pin={PIN_FIRST} className="min-w-48">
              <div className="flex items-center gap-2 font-medium">
                {member.name || member.email}
                {member.isYou ? <Badge variant="outline">{t("you")}</Badge> : null}
              </div>
              <div className="text-xs text-muted-foreground">
                {member.email} · <RelativeTime value={member.addedAt} />
              </div>
            </TableCell>
            <TableCell>
              <span title={t(`roles.${member.role}.description`)}>
                {t(`roles.${member.role}.label`)}
              </span>
            </TableCell>
            <TableCell className="text-sm">
              {member.allTenants ? (
                t("scope.all")
              ) : (
                <span title={member.tenantIds.map(tenantName).join(", ")}>
                  {t("scope.count", { count: member.tenantIds.length })}
                </span>
              )}
            </TableCell>
            <TableCell>
              <Badge variant={STATUS_VARIANT[member.status]}>{t(`status.${member.status}`)}</Badge>
            </TableCell>
            {canManage ? (
              <TableCell className="text-right">
                <MemberActions member={member} onEdit={onEdit} />
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function MemberActions({
  member,
  onEdit,
}: {
  member: TeamMember;
  onEdit: (member: TeamMember) => void;
}) {
  const { t } = useTranslation("team");
  const { t: tAny } = useTranslation();
  const remove = useRemoveMember();
  const reissue = useReissueInvitation();
  const reset = useResetAccess();
  const identity = useConfirmIdentity();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [resetOpen, setResetOpen] = React.useState(false);
  const [issued, setIssued] = React.useState<{
    invitation: Invitation;
    kind: "invitation" | "reset";
  } | null>(null);
  const label = member.name || member.email;

  const onReissue = async () => {
    try {
      const result = await reissue.mutateAsync(member.userId);
      toast.success(t("toasts.reissued"));
      setIssued({ invitation: result, kind: "invitation" });
    } catch (error) {
      toast.error(tAny(teamErrorKey(error)));
    }
  };

  /**
   * Resetting needs a recent sign-in (the new link opens the member's
   * account): an older session confirms it is them first, then the reset
   * runs again. From the question dialog a failure stays in the dialog;
   * after the confirmation it is a toast.
   */
  const runReset = async (fromDialog: boolean): Promise<void> => {
    try {
      const result = await reset.mutateAsync(member.userId);
      toast.success(t("toasts.accessReset"));
      setResetOpen(false);
      setIssued({ invitation: result, kind: "reset" });
    } catch (error) {
      if (isRecentSignInRequired(error)) {
        setResetOpen(false);
        identity.ask(() => void runReset(false));
        return;
      }
      if (fromDialog) {
        throw error;
      }
      toast.error(tAny(teamErrorKey(error)));
    }
  };

  return (
    <div className="flex justify-end gap-1">
      {member.status === "active" ? null : (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void onReissue()}
          disabled={reissue.isPending}
          aria-label={t("actions.reissueLabel", { name: label })}
        >
          <Link2 aria-hidden="true" />
          {t("actions.reissue")}
        </Button>
      )}
      {member.status === "active" && !member.isYou ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setResetOpen(true)}
          aria-label={t("actions.resetAccessLabel", { name: label })}
        >
          <KeyRound aria-hidden="true" />
          {t("actions.resetAccess")}
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onEdit(member)}
        aria-label={t("actions.editLabel", { name: label })}
      >
        <Pencil aria-hidden="true" />
        {t("actions.edit")}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setConfirmOpen(true)}
        aria-label={t("actions.removeLabel", { name: label })}
      >
        <Trash2 aria-hidden="true" />
        {t("actions.remove")}
      </Button>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("remove.title", { name: label })}
        description={t("remove.description")}
        confirmLabel={t("remove.confirm")}
        destructive
        pending={remove.isPending}
        error={remove.error ? tAny(teamErrorKey(remove.error)) : undefined}
        onConfirm={async () => {
          await remove.mutateAsync(member.userId);
          toast.success(t("toasts.removed"));
        }}
      />
      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title={t("resetAccess.title", { name: label })}
        description={t("resetAccess.description")}
        confirmLabel={t("resetAccess.confirm")}
        destructive
        pending={reset.isPending}
        error={
          reset.error && !isRecentSignInRequired(reset.error)
            ? tAny(teamErrorKey(reset.error))
            : undefined
        }
        onConfirm={() => runReset(true)}
      />
      {identity.dialog}
      <Dialog open={issued !== null} onOpenChange={(open) => (open ? undefined : setIssued(null))}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
          {issued ? (
            <IssuedLinkResult
              invitation={issued.invitation}
              kind={issued.kind}
              onDone={() => setIssued(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
