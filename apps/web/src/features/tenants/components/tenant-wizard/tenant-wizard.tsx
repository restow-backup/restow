import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, Info, TriangleAlert, X } from "lucide-react";
import * as React from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { sourcesListTo } from "@/features/sources/paths";

import { ConfirmDialog } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { toast } from "@/components/ui/sonner";
import { zodResolver } from "@/lib/form";
import { formatDateTime } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { setupStateQueryOptions } from "@/routes/tree";

import { addMember, tenantKeys } from "../../api";
import {
  type TenantWizardAdminValues,
  type TenantWizardValues,
  WIZARD_STEPS,
  WIZARD_STEP_FIELDS,
  type WizardStep,
  emptyTenantWizardForm,
  tenantWizardSchema,
  toCreateTenantInput,
} from "../../forms";
import { useCreateTenant } from "../../hooks";
import { tenantDetailTo } from "../../paths";
import {
  type Message,
  createTenantError,
  isCustomerNumberConflict,
  isSlugConflict,
} from "../../presenters";
import type { AddMemberResult, TenantItem } from "../../types";
import { CopyInvitationLinkButton } from "../copy-link";
import { AdminsStep } from "./step-admins";
import { ContactsStep } from "./step-contacts";
import { NotificationsStep } from "./step-notifications";
import { OrganisationStep } from "./step-organisation";
import { ReviewStep } from "./step-review";
import { SourceStep } from "./step-source";

export interface TenantWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * "+ New tenant": organisation, contacts, notification recipients,
 * administrators to invite, a pointer to connecting a source, then review and
 * create. One transaction on the API (customer data, contacts and
 * notification recipients atomically); administrators are invited
 * afterwards, one call per person, through the existing invitation API.
 */
export function TenantWizard({ open, onOpenChange }: TenantWizardProps) {
  // `TenantWizardBody` decides what closing means (discard confirmation for a
  // dirty form); it is rendered inside `SheetContent` below and keeps this
  // ref current on every render, so Escape (handled here, on the content
  // Radix attaches the listener to) can call the same logic as the close
  // button and "Cancel" instead of bypassing it.
  const requestCloseRef = React.useRef<() => void>(() => onOpenChange(false));
  return (
    <Sheet open={open} onOpenChange={(next) => next && onOpenChange(true)}>
      <SheetContent
        side="right"
        hideClose
        className="flex w-full flex-col gap-0 sm:max-w-2xl"
        onEscapeKeyDown={(event) => {
          // Radix's default (close immediately) is replaced with the wizard's
          // own close, which confirms first when the form has unsaved data.
          event.preventDefault();
          requestCloseRef.current();
        }}
        onInteractOutside={(event) => event.preventDefault()}
      >
        {/* An outside click and the built-in close button are suppressed
            above and below: only the wizard's own close button, "Cancel" and
            Escape reach `onOpenChange`, after confirming an unsaved form. */}
        <TenantWizardBody onClose={() => onOpenChange(false)} requestCloseRef={requestCloseRef} />
      </SheetContent>
    </Sheet>
  );
}

/**
 * One administrator row's outcome from `POST /tenants/:id/members`: `result`
 * is `null` when the call itself failed (network, a server error — never
 * because the address was invalid, the schema already refused that before
 * submit). {@link WizardSuccess} shows each outcome honestly instead of only
 * counting failures.
 */
interface AdminOutcome {
  email: string;
  role: TenantWizardAdminValues["role"];
  result: AddMemberResult | null;
}

interface WizardResult {
  tenant: TenantItem;
  admins: AdminOutcome[];
}

/** Text-like `<input>` types: Enter in one of these advances the wizard step. */
const TEXT_LIKE_INPUT_TYPES = new Set(["text", "email", "tel", "url", "search", "password"]);

function isTextLikeInput(target: EventTarget | null): target is HTMLInputElement {
  return target instanceof HTMLInputElement && TEXT_LIKE_INPUT_TYPES.has(target.type);
}

function TenantWizardBody({
  onClose,
  requestCloseRef,
}: {
  onClose: () => void;
  requestCloseRef: React.MutableRefObject<() => void>;
}) {
  const { t, i18n } = useTranslation("tenants");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const create = useCreateTenant();
  const { setActiveTenant } = useSession();

  const [step, setStep] = React.useState(0);
  const [maxReached, setMaxReached] = React.useState(0);
  const [submitError, setSubmitError] = React.useState<Message | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = React.useState(false);
  const [result, setResult] = React.useState<WizardResult | null>(null);
  // The slug follows the name until step 1's field is edited by hand; kept
  // here (not local to OrganisationStep) so it survives moving away and back.
  const [slugEdited, setSlugEdited] = React.useState(false);

  const form = useForm<TenantWizardValues>({
    resolver: zodResolver(tenantWizardSchema),
    defaultValues: emptyTenantWizardForm(i18n.language.startsWith("de") ? "de" : "en"),
  });
  const stepId = WIZARD_STEPS[step] as WizardStep;
  const lastStep = step === WIZARD_STEPS.length - 1;

  async function goNext() {
    const fields = WIZARD_STEP_FIELDS[stepId];
    const ok = fields.length === 0 || (await form.trigger(fields, { shouldFocus: true }));
    if (!ok) {
      return;
    }
    const next = Math.min(step + 1, WIZARD_STEPS.length - 1);
    setStep(next);
    setMaxReached((current) => Math.max(current, next));
  }

  function goBack() {
    setStep((current) => Math.max(0, current - 1));
  }

  /**
   * Enter advances to the next step, but only when it was pressed in a
   * text-like field: everything else in the form (buttons, checkboxes,
   * radios, the Select trigger and its items) keeps its own native Enter
   * behaviour — activating it — instead of being overridden.
   */
  function handleFormKeyDown(event: React.KeyboardEvent<HTMLFormElement>) {
    if (event.key !== "Enter" || event.defaultPrevented || !isTextLikeInput(event.target)) {
      return;
    }
    if (!lastStep) {
      event.preventDefault();
      void goNext();
    }
  }

  /** The first step that owns a field named in `errors`, or -1 if none does. */
  function stepOfErrors(errors: Partial<Record<keyof TenantWizardValues, unknown>>): number {
    return WIZARD_STEPS.findIndex((wizardStep) =>
      WIZARD_STEP_FIELDS[wizardStep].some((field) => errors[field] !== undefined),
    );
  }

  const onSubmit = form.handleSubmit(
    async (values) => {
      setSubmitError(null);
      try {
        const created = await create.mutateAsync(toCreateTenantInput(values));
        const admins: AdminOutcome[] = [];
        if (values.admins.length > 0) {
          const outcomes = await Promise.allSettled(
            values.admins.map((admin) =>
              addMember(created.id, { email: admin.email, role: admin.role }),
            ),
          );
          outcomes.forEach((outcome, index) => {
            const admin = values.admins[index];
            if (!admin) {
              return;
            }
            admins.push({
              email: admin.email,
              role: admin.role,
              result: outcome.status === "fulfilled" ? outcome.value : null,
            });
          });
          void queryClient.invalidateQueries({ queryKey: tenantKeys.members(created.id) });
        }
        toast.success(t("toasts.created", { name: created.name }));
        setResult({ tenant: created, admins });
      } catch (error) {
        const organisationIndex = WIZARD_STEPS.indexOf("organisation");
        if (isSlugConflict(error)) {
          form.setError("slug", { message: "slugTaken" }, { shouldFocus: true });
          setStep(organisationIndex);
        } else if (isCustomerNumberConflict(error)) {
          form.setError(
            "customerNumber",
            { message: "customerNumberTaken" },
            { shouldFocus: true },
          );
          setStep(organisationIndex);
        } else {
          setSubmitError(createTenantError(error));
        }
      }
    },
    (errors) => {
      // "Create" was pressed from Review with an invalid earlier step (only
      // reachable through the step indicator): react-hook-form's errors land
      // on fields that are not on screen, so nothing would otherwise be
      // visible. Jump to the first step that has one.
      const invalidStep = stepOfErrors(errors);
      if (invalidStep >= 0) {
        setStep(invalidStep);
        setMaxReached((current) => Math.max(current, invalidStep));
      }
    },
  );

  function requestClose() {
    if (result || !form.formState.isDirty) {
      onClose();
      return;
    }
    setConfirmingDiscard(true);
  }
  // Kept current on every render (not in an effect): `TenantWizard`'s Escape
  // handler calls this ref synchronously and must never see a stale closure.
  requestCloseRef.current = requestClose;

  const header = (
    <SheetHeader className="flex-row items-start justify-between gap-4 space-y-0 border-b">
      <div className="space-y-1.5">
        <SheetTitle>{t("wizard.title")}</SheetTitle>
        <SheetDescription>{t("wizard.description")}</SheetDescription>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0"
        onClick={requestClose}
        aria-label={t("wizard.close")}
      >
        <X />
      </Button>
    </SheetHeader>
  );

  if (result) {
    return (
      <>
        {header}
        <WizardSuccess
          result={result}
          onConnectSource={() => {
            // The new tenant becomes active without `useEnterTenant`'s own
            // navigation and toast (it would otherwise send the browser to
            // the dashboard first and stack an "entered" toast on top of the
            // "created" one already showing): one switch, one navigation.
            setActiveTenant(result.tenant.id);
            onClose();
            void navigate({ to: sourcesListTo() });
          }}
          onOpenTenant={() => {
            onClose();
            void navigate({ to: tenantDetailTo(result.tenant.id) });
          }}
          onClose={onClose}
        />
      </>
    );
  }

  return (
    <>
      {header}
      <WizardStepIndicator current={step} maxReached={maxReached} onSelect={setStep} />
      <form onSubmit={onSubmit} onKeyDown={handleFormKeyDown} noValidate className="contents">
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6">
          <div className="space-y-1">
            <h2 className="text-base font-semibold">{t(`wizard.${stepId}.title`)}</h2>
            <p className="text-sm text-muted-foreground">{t(`wizard.${stepId}.description`)}</p>
          </div>
          <WizardStepBody
            stepId={stepId}
            form={form}
            slugEdited={slugEdited}
            onSlugEdited={setSlugEdited}
          />
          {submitError ? (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertDescription>{t(submitError.key, submitError.values)}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        <SheetFooter className="flex-row justify-between border-t">
          <Button type="button" variant="outline" onClick={requestClose}>
            {t("wizard.cancel")}
          </Button>
          <div className="flex gap-2">
            {step > 0 ? (
              <Button type="button" variant="outline" onClick={goBack}>
                {t("wizard.back")}
              </Button>
            ) : null}
            {lastStep ? (
              // `create.isPending` alone turns false the moment POST /tenants
              // resolves, while admin invitations are still being sent one by
              // one below — a second click in that window would create a
              // second tenant. `isSubmitting` stays true for the whole
              // `onSubmit` handler, invitations included.
              <Button type="submit" loading={create.isPending || form.formState.isSubmitting}>
                {t("wizard.create")}
              </Button>
            ) : (
              <Button type="button" onClick={() => void goNext()}>
                {t("wizard.next")}
              </Button>
            )}
          </div>
        </SheetFooter>
      </form>
      <ConfirmDialog
        open={confirmingDiscard}
        onOpenChange={setConfirmingDiscard}
        title={t("wizard.cancelConfirm.title")}
        description={t("wizard.cancelConfirm.description")}
        confirmLabel={t("wizard.cancelConfirm.confirm")}
        cancelLabel={t("wizard.cancelConfirm.keep")}
        destructive
        onConfirm={() => {
          setConfirmingDiscard(false);
          onClose();
        }}
      />
    </>
  );
}

function WizardStepBody({
  stepId,
  form,
  slugEdited,
  onSlugEdited,
}: {
  stepId: WizardStep;
  form: ReturnType<typeof useForm<TenantWizardValues>>;
  slugEdited: boolean;
  onSlugEdited: (edited: boolean) => void;
}) {
  switch (stepId) {
    case "organisation":
      return <OrganisationStep form={form} slugEdited={slugEdited} onSlugEdited={onSlugEdited} />;
    case "contacts":
      return <ContactsStep form={form} />;
    case "notifications":
      return <NotificationsStep form={form} />;
    case "admins":
      return <AdminsStep form={form} />;
    case "source":
      return <SourceStep />;
    case "review":
      return <ReviewStep form={form} />;
    default:
      return null;
  }
}

export function WizardStepIndicator({
  current,
  maxReached,
  onSelect,
}: {
  current: number;
  maxReached: number;
  onSelect: (index: number) => void;
}) {
  const { t } = useTranslation("tenants");
  return (
    <nav
      aria-label={t("wizard.title")}
      // Wrap instead of scrolling sideways: every step stays visible, also in a narrow dialog.
      className="flex flex-wrap gap-1 border-b px-4 py-3 sm:px-6"
    >
      {WIZARD_STEPS.map((id, index) => {
        const reached = index <= maxReached;
        const isCurrent = index === current;
        return (
          <button
            key={id}
            type="button"
            disabled={!reached}
            aria-current={isCurrent ? "step" : undefined}
            onClick={() => reached && onSelect(index)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              isCurrent
                ? "border-primary bg-primary text-primary-foreground"
                : reached
                  ? "border-input bg-background text-foreground hover:bg-accent"
                  : "cursor-not-allowed border-input/60 bg-muted text-muted-foreground",
            )}
          >
            {index < maxReached && !isCurrent ? (
              <Check aria-hidden="true" className="size-3.5" />
            ) : (
              <span aria-hidden="true">{index + 1}</span>
            )}
            {t(`wizard.steps.${id}`)}
          </button>
        );
      })}
    </nav>
  );
}

function WizardSuccess({
  result,
  onConnectSource,
  onOpenTenant,
  onClose,
}: {
  result: WizardResult;
  onConnectSource: () => void;
  onOpenTenant: () => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation("tenants");
  const setup = useQuery(setupStateQueryOptions);
  const microsoftSignIn = setup.data?.microsoftSignIn ?? false;

  const failed = result.admins.filter((admin) => admin.result === null);
  const members = result.admins.filter((admin) => admin.result?.status === "member");
  const invited = result.admins.filter(
    (admin): admin is AdminOutcome & { result: Extract<AddMemberResult, { status: "invited" }> } =>
      admin.result?.status === "invited",
  );

  return (
    <div className="flex flex-1 flex-col justify-between overflow-y-auto">
      <div className="space-y-4 px-4 py-6 sm:px-6">
        <div className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Check aria-hidden="true" className="size-5" />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-base font-semibold">
            {t("wizard.success.title", { name: result.tenant.name })}
          </h2>
          <p className="text-sm text-muted-foreground">{t("wizard.success.description")}</p>
        </div>

        {members.length > 0 || invited.length > 0 ? (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">{t("wizard.success.admins.title")}</h3>
            <ul className="space-y-2">
              {members.map((admin) => (
                <li
                  key={admin.email}
                  className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm"
                >
                  <span className="font-medium">{admin.email}</span>
                  <Badge variant="outline">{t(`members.roles.${admin.role}`)}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {t("wizard.success.admins.memberBadge")}
                  </span>
                </li>
              ))}
              {invited.map((admin) => (
                <li
                  key={admin.email}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{admin.email}</span>
                    <Badge variant="outline">{t(`members.roles.${admin.role}`)}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {t("wizard.success.admins.expires", {
                        date:
                          formatDateTime(admin.result.expiresAt, i18n.language) ??
                          t("common:time.unknown"),
                      })}
                    </span>
                  </div>
                  <CopyInvitationLinkButton
                    invitationId={admin.result.invitationId}
                    email={admin.email}
                  />
                </li>
              ))}
            </ul>
            {invited.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("wizard.success.admins.invitedHint")}
              </p>
            ) : null}
            {invited.length > 0 && !microsoftSignIn ? (
              <Alert>
                <Info />
                <AlertDescription>{t("wizard.success.admins.noSignInNotice")}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        ) : null}

        {failed.length > 0 ? (
          <Alert variant="warning">
            <TriangleAlert />
            <AlertDescription>
              {t("wizard.success.adminInviteFailed", {
                count: failed.length,
                emails: failed.map((admin) => admin.email).join(", "),
              })}
            </AlertDescription>
          </Alert>
        ) : null}
      </div>
      {/* Stacked below the sheet's own w-full breakpoint (the shadcn default
          for SheetFooter), row-aligned from sm: up — three buttons at once
          need the labels' full width on a phone, or "Connect a source now"
          scrolls off screen instead of stacking. */}
      <SheetFooter className="flex-col-reverse gap-2 border-t sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={onClose}>
          {t("wizard.close")}
        </Button>
        <Button variant="outline" onClick={onOpenTenant}>
          {t("wizard.success.openTenant")}
        </Button>
        <Button onClick={onConnectSource}>{t("wizard.success.connectSource")}</Button>
      </SheetFooter>
    </div>
  );
}
