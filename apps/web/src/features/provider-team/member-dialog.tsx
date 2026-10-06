import { CheckCircle2, Lock } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "@/components/ui/sonner";
import { ConnectedSetPasswordLinkField } from "@/features/accounts/components/set-password-link-field";
import type { ProviderRole } from "@/lib/api";
import { ExtensionSlot } from "@/lib/extensions";
import { PROVIDER_ROLES } from "@/lib/provider-role";

import type { Invitation, TeamMember } from "./api";
import { useInviteMember, useTeamScope, useTenantChoices, useUpdateMember } from "./hooks";
import {
  EMAIL_PATTERN,
  type ScopeDraft,
  normalizeDraft,
  scopeIsValid,
  teamErrorKey,
  tenantScopeChoice,
} from "./presenters";

interface MemberDialogProps {
  /** The member to change; null invites a new one. */
  member: TeamMember | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Invite a provider admin, or change a member's role and tenants. After an
 * invitation the same dialog says where the link went, or shows it (with the
 * username) for the owner to hand over when no mail could be sent.
 *
 * Limiting a member to chosen tenants is offered only where the installation
 * enables the gated feature `providerTeam.tenantScope`; elsewhere the choice
 * shows locked, with the reason an extension words in the slot
 * `team.tenantScopeLocked` (the core says it neutrally).
 */
export function MemberDialog({ member, open, onOpenChange }: MemberDialogProps) {
  const [invitation, setInvitation] = React.useState<Invitation | null>(null);
  const close = () => {
    setInvitation(null);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        {invitation ? (
          <IssuedLinkResult invitation={invitation} kind="invitation" onDone={close} />
        ) : (
          <MemberForm
            key={member?.userId ?? "new"}
            member={member}
            onInvited={setInvitation}
            onSaved={close}
            onCancel={close}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function MemberForm({
  member,
  onInvited,
  onSaved,
  onCancel,
}: {
  member: TeamMember | null;
  onInvited: (invitation: Invitation) => void;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("team");
  const { t: tAny } = useTranslation();
  const invite = useInviteMember();
  const update = useUpdateMember();
  const tenants = useTenantChoices();
  const scopeChoice = tenantScopeChoice({ tenantScope: useTeamScope().tenantScope, member });
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [draft, setDraft] = React.useState<ScopeDraft>({
    role: member?.role ?? "technician",
    allTenants: member?.allTenants ?? true,
    tenantIds: member?.tenantIds ?? [],
  });
  const [submitted, setSubmitted] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const pending = invite.isPending || update.isPending;

  const emailError = !member && submitted && !EMAIL_PATTERN.test(email.trim());
  const nameError = !member && submitted && name.trim().length === 0;
  const scopeError = submitted && !scopeIsValid(draft);
  const effective = normalizeDraft(draft);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setSubmitError(null);
    if (!scopeIsValid(draft) || (!member && (!EMAIL_PATTERN.test(email.trim()) || !name.trim()))) {
      return;
    }
    try {
      if (member) {
        await update.mutateAsync({ userId: member.userId, input: effective });
        toast.success(t("toasts.updated"));
        onSaved();
      } else {
        const result = await invite.mutateAsync({
          ...effective,
          email: email.trim(),
          name: name.trim(),
        });
        toast.success(t("toasts.invited"));
        onInvited(result);
      }
    } catch (error) {
      setSubmitError(error);
    }
  };

  const toggleTenant = (id: string, checked: boolean) =>
    setDraft((current) => ({
      ...current,
      tenantIds: checked
        ? [...new Set([...current.tenantIds, id])]
        : current.tenantIds.filter((tenantId) => tenantId !== id),
    }));

  return (
    <>
      <DialogHeader>
        <DialogTitle>{member ? t("dialog.editTitle") : t("dialog.inviteTitle")}</DialogTitle>
        <DialogDescription>
          {member
            ? t("dialog.editDescription", { name: member.name || member.email })
            : t("dialog.inviteDescription")}
        </DialogDescription>
      </DialogHeader>

      <form id="provider-team-member" onSubmit={onSubmit} noValidate className="space-y-5">
        {member ? null : (
          <>
            <Field
              id="team-email"
              label={t("form.email")}
              hint={t("form.emailHint")}
              error={emailError ? t("form.errors.email") : undefined}
            >
              <Input
                id="team-email"
                type="email"
                autoComplete="off"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                aria-invalid={emailError}
                aria-describedby={messageId("team-email")}
              />
            </Field>
            <Field
              id="team-name"
              label={t("form.name")}
              error={nameError ? t("form.errors.name") : undefined}
            >
              <Input
                id="team-name"
                autoComplete="off"
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
                aria-invalid={nameError}
                aria-describedby={messageId("team-name")}
              />
            </Field>
          </>
        )}

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("form.role")}</legend>
          <RadioGroup
            value={draft.role}
            onValueChange={(value) =>
              setDraft((current) => ({ ...current, role: value as ProviderRole }))
            }
            className="gap-2"
          >
            {PROVIDER_ROLES.map((role) => (
              <Label
                key={role}
                htmlFor={`team-role-${role}`}
                className="flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal has-[[data-state=checked]]:border-primary"
              >
                <RadioGroupItem id={`team-role-${role}`} value={role} className="mt-0.5" />
                <span className="space-y-0.5">
                  <span className="block font-medium">{t(`roles.${role}.label`)}</span>
                  <span className="block text-sm text-muted-foreground">
                    {t(`roles.${role}.description`)}
                  </span>
                </span>
              </Label>
            ))}
          </RadioGroup>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("form.scope")}</legend>
          {draft.role === "owner" ? (
            <p className="text-sm text-muted-foreground">{t("scope.ownerHint")}</p>
          ) : (
            <>
              <RadioGroup
                value={draft.allTenants ? "all" : "selected"}
                onValueChange={(value) =>
                  setDraft((current) =>
                    // A limit from before comes back exactly as it was.
                    value === "selected" && scopeChoice === "kept" && member
                      ? { ...current, allTenants: false, tenantIds: member.tenantIds }
                      : { ...current, allTenants: value === "all" },
                  )
                }
                className="gap-2"
              >
                <Label htmlFor="team-scope-all" className="flex items-start gap-3 font-normal">
                  <RadioGroupItem id="team-scope-all" value="all" className="mt-0.5" />
                  <span>
                    <span className="block font-medium">{t("scope.all")}</span>
                    <span className="block text-sm text-muted-foreground">
                      {t("scope.allHint")}
                    </span>
                  </span>
                </Label>
                <Label
                  htmlFor="team-scope-selected"
                  className="flex items-start gap-3 font-normal has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
                >
                  <RadioGroupItem
                    id="team-scope-selected"
                    value="selected"
                    className="mt-0.5"
                    disabled={scopeChoice === "locked"}
                  />
                  <span className="flex items-center gap-1.5 font-medium">
                    {scopeChoice === "locked" ? (
                      <Lock className="size-3.5" aria-hidden="true" />
                    ) : null}
                    {t("scope.selected")}
                  </span>
                </Label>
              </RadioGroup>
              {scopeChoice === "locked" ? (
                <ExtensionSlot
                  name="team.tenantScopeLocked"
                  props={{}}
                  fallback={<p className="text-sm text-muted-foreground">{t("scope.locked")}</p>}
                />
              ) : null}
              {scopeChoice === "kept" ? (
                <p className="text-sm text-muted-foreground">{t("scope.kept")}</p>
              ) : null}
              {draft.allTenants ? null : (
                <div className="ml-7 max-h-56 space-y-2 overflow-y-auto rounded-md border p-3">
                  {tenants.data && tenants.data.length > 0 ? (
                    tenants.data.map((tenant) => (
                      <Label
                        key={tenant.id}
                        htmlFor={`team-tenant-${tenant.id}`}
                        className="flex items-center gap-2 font-normal"
                      >
                        <Checkbox
                          id={`team-tenant-${tenant.id}`}
                          checked={draft.tenantIds.includes(tenant.id)}
                          disabled={scopeChoice !== "open"}
                          onCheckedChange={(checked) => toggleTenant(tenant.id, checked === true)}
                        />
                        {tenant.name}
                      </Label>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">{t("scope.noTenants")}</p>
                  )}
                </div>
              )}
              {scopeError ? (
                <p className="text-sm text-destructive">{t("form.errors.tenants")}</p>
              ) : null}
            </>
          )}
        </fieldset>

        {submitError ? (
          <Alert variant="destructive">
            <AlertDescription>{tAny(teamErrorKey(submitError))}</AlertDescription>
          </Alert>
        ) : null}
      </form>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={pending}>
          {t("dialog.cancel")}
        </Button>
        <Button type="submit" form="provider-team-member" disabled={pending}>
          {member ? t("dialog.submitSave") : t("dialog.submitInvite")}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Where a freshly issued set-password link went (an invitation, a reissued
 * invitation link or a reset of a member's access): the shared field of the
 * accounts feature says whether it was mailed and when it expires, and shows
 * the username and the link, built on the installation's public URL, to copy
 * when the owner has to hand them over.
 */
export function IssuedLinkResult({
  invitation,
  kind,
  onDone,
}: {
  invitation: Invitation;
  kind: "invitation" | "reset";
  onDone: () => void;
}) {
  const { t } = useTranslation("team");
  const email = invitation.member.email;
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <CheckCircle2 className="size-5" aria-hidden="true" />
          {kind === "reset" ? t("link.resetTitle") : t("link.title")}
        </DialogTitle>
        <DialogDescription>{t("link.description", { email })}</DialogDescription>
      </DialogHeader>
      <ConnectedSetPasswordLinkField
        id="provider-team-set-password-link"
        result={{
          email,
          linkExpiresAt: invitation.linkExpiresAt,
          setPasswordToken: invitation.setPasswordToken,
          mailOutcome: invitation.mailOutcome,
        }}
      />
      <DialogFooter>
        <Button onClick={onDone}>{t("link.done")}</Button>
      </DialogFooter>
    </>
  );
}
