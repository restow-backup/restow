import { useQuery } from "@tanstack/react-query";
import { MailCheck, TriangleAlert } from "lucide-react";
import * as React from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import {
  SetPasswordLinkField,
  useAbsoluteSetPasswordLink,
} from "@/features/accounts/components/set-password-link-field";
import {
  type ProvisionAccountValues,
  emptyProvisionForm,
  fieldMessageKey,
  provisionAccountSchema,
} from "@/features/accounts/forms";
import { useProvisionAccount } from "@/features/accounts/hooks";
import { type Message, provisionError } from "@/features/accounts/presenters";
import type { ProvisionResult } from "@/features/accounts/types";
import { type TenantRole, notificationMailConfigured } from "@/lib/api";
import { zodResolver } from "@/lib/form";
import { setupStateQueryOptions } from "@/routes/tree";

import { RoleSelect } from "./role-select";

interface InviteMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  tenantName: string;
  defaultRole: TenantRole;
}

/** Whether a provisioned account can also sign in with Microsoft directly (an extra path, never the only one). */
function useMicrosoftSignInAvailable(): boolean {
  const setup = useQuery(setupStateQueryOptions);
  return setup.data?.microsoftSignIn ?? false;
}

interface InviteDialogHeaderProps {
  /** null while the form is still showing; the outcome once submitted. */
  provisioned: ProvisionResult | null;
  tenantName: string;
}

/**
 * The dialog's title and lead line. Exported (and kept free of any hook but
 * `useTranslation`) so its own test can render it directly, the same way
 * {@link InvitedStep} is tested below: once a result comes back, the wording
 * must reflect whether a link was actually issued — "sign-in link ready"
 * would be a lie for someone who already had a way in and got no link at
 * all, so that case gets its own, honest heading instead.
 */
export function InviteDialogHeader({ provisioned, tenantName }: InviteDialogHeaderProps) {
  const { t } = useTranslation(["accounts", "tenants"]);
  if (!provisioned) {
    return (
      <DialogHeader>
        <DialogTitle>{t("tenants:invite.title", { tenant: tenantName })}</DialogTitle>
        <DialogDescription>{t("accounts:invite.description")}</DialogDescription>
      </DialogHeader>
    );
  }
  const titleKey = provisioned.linkIssued
    ? "accounts:invite.invited.title"
    : "accounts:invite.added.title";
  const leadKey = provisioned.linkIssued
    ? "accounts:invite.invited.lead"
    : "accounts:invite.added.lead";
  return (
    <DialogHeader>
      <DialogTitle>{t(titleKey)}</DialogTitle>
      <DialogDescription>{t(leadKey)}</DialogDescription>
    </DialogHeader>
  );
}

/**
 * Give a person access to a tenant. Whoever the email belongs to — a brand
 * new account or one that already existed — is added to the tenant right
 * away; there is no "wait until they sign in with Microsoft" step and no
 * dead end for someone without a Microsoft account. Someone who cannot sign
 * in yet also gets a link to choose a password; someone who already can
 * (a password, a passkey or a linked Microsoft account) simply becomes a
 * member, with no link issued for an account that is not theirs to redeem.
 * When this installation also offers Microsoft sign-in, that stays available
 * as an extra way in, never the only one.
 */
export function InviteMemberDialog({
  open,
  onOpenChange,
  tenantId,
  tenantName,
  defaultRole,
}: InviteMemberDialogProps) {
  const microsoftSignIn = useMicrosoftSignInAvailable();
  const setup = useQuery(setupStateQueryOptions);
  const mailConfigured = notificationMailConfigured(setup.data);
  const [provisioned, setProvisioned] = React.useState<ProvisionResult | null>(null);
  // Remount the form for "invite another" so it starts empty again.
  const [formKey, setFormKey] = React.useState(0);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setProvisioned(null);
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <InviteDialogHeader provisioned={provisioned} tenantName={tenantName} />
        {provisioned ? (
          <ConnectedInvitedStep
            result={provisioned}
            microsoftSignIn={microsoftSignIn}
            onAnother={() => {
              setProvisioned(null);
              setFormKey((key) => key + 1);
            }}
            onDone={() => handleOpenChange(false)}
          />
        ) : (
          <InviteForm
            key={formKey}
            tenantId={tenantId}
            defaultRole={defaultRole}
            mailConfigured={mailConfigured}
            onProvisioned={setProvisioned}
            onDone={() => handleOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface InviteFormProps {
  tenantId: string;
  defaultRole: TenantRole;
  /** Whether a link could actually be emailed; changes the submit button's wording. */
  mailConfigured: boolean;
  onProvisioned: (result: ProvisionResult) => void;
  onDone: () => void;
}

function InviteForm({
  tenantId,
  defaultRole,
  mailConfigured,
  onProvisioned,
  onDone,
}: InviteFormProps) {
  const { t } = useTranslation(["accounts", "tenants"]);
  const provision = useProvisionAccount(tenantId);
  const [submitError, setSubmitError] = React.useState<Message | null>(null);

  const form = useForm<ProvisionAccountValues>({
    resolver: zodResolver(provisionAccountSchema),
    defaultValues: emptyProvisionForm(defaultRole),
  });
  const { errors, isSubmitting } = form.formState;
  const role = useWatch({ control: form.control, name: "role" });
  const emailMessage = fieldMessageKey(errors.email);

  const onSubmit = form.handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      const result = await provision.mutateAsync({ email: values.email.trim(), role: values.role });
      onProvisioned(result);
    } catch (error) {
      setSubmitError(provisionError(error));
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <Field
        id="invite-email"
        label={t("tenants:invite.email")}
        error={emailMessage ? t(emailMessage) : undefined}
      >
        <Input
          id="invite-email"
          type="email"
          autoComplete="off"
          spellCheck={false}
          placeholder={t("tenants:invite.emailPlaceholder")}
          aria-invalid={errors.email !== undefined}
          aria-describedby={messageId("invite-email")}
          {...form.register("email")}
        />
      </Field>
      <div className="space-y-1.5">
        <Label htmlFor="invite-role">{t("tenants:invite.role")}</Label>
        <Controller
          control={form.control}
          name="role"
          render={({ field }) => (
            <RoleSelect
              id="invite-role"
              value={field.value}
              onChange={field.onChange}
              describedBy={messageId("invite-role")}
            />
          )}
        />
        <p id={messageId("invite-role")} className="text-xs text-muted-foreground">
          {t(`tenants:members.roleHints.${role}`)}
        </p>
      </div>

      {submitError ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{t(submitError.key, submitError.values)}</AlertDescription>
        </Alert>
      ) : null}

      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={isSubmitting}>
          {t("common:actions.cancel")}
        </Button>
        <Button type="submit" loading={isSubmitting}>
          {mailConfigured ? t("accounts:invite.submit") : t("accounts:invite.submitNoMail")}
        </Button>
      </DialogFooter>
    </form>
  );
}

interface InvitedStepProps {
  result: ProvisionResult;
  /** The absolute set-password link (see {@link useAbsoluteSetPasswordLink}). */
  link: string;
  microsoftSignIn: boolean;
  onAnother: () => void;
  onDone: () => void;
}

/**
 * The account is provisioned; here is the link. Pure (the link is a prop),
 * so it renders without a query client in tests — {@link ConnectedInvitedStep}
 * is what the dialog actually uses.
 */
export function InvitedStep({
  result,
  link,
  microsoftSignIn,
  onAnother,
  onDone,
}: InvitedStepProps) {
  const { t } = useTranslation(["accounts", "tenants"]);
  const summaryKey = result.linkIssued
    ? result.created
      ? "accounts:invite.invited.summary"
      : "accounts:invite.invited.reusedSummary"
    : "accounts:invite.invited.alreadySignedIn";
  return (
    <div className="space-y-4">
      <Alert variant="info">
        <MailCheck />
        <AlertDescription>
          {t(summaryKey, { email: result.email, role: result.role })}
        </AlertDescription>
      </Alert>
      {result.linkIssued ? (
        <>
          <SetPasswordLinkField id="invite-set-password-link" result={result} link={link} />
          {microsoftSignIn ? (
            <p className="text-xs text-muted-foreground">
              {t("accounts:invite.invited.microsoftHint", { email: result.email })}
            </p>
          ) : null}
        </>
      ) : null}
      <DialogFooter>
        <Button variant="outline" onClick={onAnother}>
          {t("tenants:invite.invited.another")}
        </Button>
        <Button onClick={onDone}>{t("tenants:invite.invited.done")}</Button>
      </DialogFooter>
    </div>
  );
}

function ConnectedInvitedStep(props: Omit<InvitedStepProps, "link">) {
  const link = useAbsoluteSetPasswordLink(props.result.setPasswordToken ?? "");
  return <InvitedStep {...props} link={link} />;
}
