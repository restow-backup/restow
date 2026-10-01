import { Link2, Pencil, Plus, ShieldAlert, Trash2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { ConfirmDialog, CopyButton, RelativeTime, usePageWidth } from "@/components/kit";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { setPasswordLink } from "@/features/accounts/paths";

import type { Invitation, TeamMember } from "./api";
import {
  useReissueInvitation,
  useRemoveMember,
  useTeam,
  useTeamScope,
  useTenantChoices,
} from "./hooks";
import { MemberDialog } from "./member-dialog";
import { STATUS_VARIANT, teamErrorKey } from "./presenters";

/**
 * The provider team (Service Provider edition): every provider admin with
 * their role, tenants and sign-in state. Owners invite, change and remove;
 * everyone else with every tenant sees the team read-only.
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
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("columns.member")}</TableHead>
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
            <TableCell className="min-w-48">
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
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [reissued, setReissued] = React.useState<Invitation | null>(null);
  const label = member.name || member.email;

  const onReissue = async () => {
    try {
      const result = await reissue.mutateAsync(member.userId);
      toast.success(t("toasts.reissued"));
      setReissued(result);
    } catch (error) {
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
      {reissued?.setPasswordToken ? (
        <ReissuedLink invitation={reissued} onClose={() => setReissued(null)} />
      ) : null}
    </div>
  );
}

/** A reissued link that could not be mailed, for the owner to hand over. */
function ReissuedLink({ invitation, onClose }: { invitation: Invitation; onClose: () => void }) {
  const { t } = useTranslation("team");
  const link = setPasswordLink(window.location.origin, invitation.setPasswordToken ?? "");
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t("link.title")}
      description={t("link.copy", { email: invitation.member.email })}
      confirmLabel={t("link.done")}
      onConfirm={onClose}
    >
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1.5 font-mono text-xs">
          {link}
        </code>
        <CopyButton value={link} />
      </div>
    </ConfirmDialog>
  );
}
