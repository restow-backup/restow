import { Link } from "@tanstack/react-router";
import { Info, Plus, Send, Settings as SettingsIcon, Trash2, TriangleAlert } from "lucide-react";
import * as React from "react";
import { type FieldError, type UseFormReturn, useFieldArray } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { settingsTo } from "@/features/settings/paths";
import { sectionSearch } from "@/features/settings/presenters";

import { Field, messageId } from "@/components/forms/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

import {
  NAME_MAX_LENGTH,
  OFFERED_NOTIFICATION_CATEGORIES,
  type TenantWizardValues,
  emptyRecipient,
  fieldMessageKey,
} from "../../forms";
import { useSendNotificationTestMail } from "../../hooks";
import {
  MAIL_NOT_CONFIGURED_PROBLEM,
  mailTestFailureKey,
  notificationTestErrorKey,
} from "../../presenters";
import type { NotificationCategory } from "../../types";

interface StepProps {
  form: UseFormReturn<TenantWizardValues>;
}

/** Step 3: notification recipients and categories, plus proving the mail transport. */
export function NotificationsStep({ form }: StepProps) {
  const { t } = useTranslation("tenants");
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "notificationRecipients",
  });
  const { errors } = form.formState;
  const recipients = form.watch("notificationRecipients");
  const listError = fieldMessageKey(errors.notificationRecipients as FieldError | undefined);

  function toggleCategory(index: number, category: NotificationCategory, checked: boolean) {
    const current = recipients[index]?.categories ?? [];
    const next = checked ? [...current, category] : current.filter((c) => c !== category);
    form.setValue(`notificationRecipients.${index}.categories`, next, { shouldDirty: true });
  }

  return (
    <div className="space-y-4">
      <Alert>
        <Info />
        <AlertDescription>{t("wizard.notifications.deliveryNotice")}</AlertDescription>
      </Alert>

      {listError ? (
        <p className="text-sm text-destructive" role="alert">
          {t(listError)}
        </p>
      ) : fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("wizard.notifications.empty")}</p>
      ) : null}

      {fields.map((field, index) => {
        const rowErrors = errors.notificationRecipients?.[index];
        const message = (name: "email" | "name") => {
          const key = fieldMessageKey(rowErrors?.[name]);
          const max = name === "name" ? NAME_MAX_LENGTH : undefined;
          return key ? t(key, { max }) : undefined;
        };
        const email = recipients[index]?.email.trim();
        const categories = recipients[index]?.categories ?? [];
        return (
          <Card key={field.id} className="py-0">
            <CardContent className="space-y-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field
                    id={`wizard-recipient-${index}-email`}
                    label={t("wizard.notifications.email")}
                    error={message("email")}
                  >
                    <Input
                      id={`wizard-recipient-${index}-email`}
                      type="email"
                      autoComplete="email"
                      aria-invalid={rowErrors?.email !== undefined}
                      aria-describedby={messageId(`wizard-recipient-${index}-email`)}
                      {...form.register(`notificationRecipients.${index}.email`)}
                    />
                  </Field>
                  <Field
                    id={`wizard-recipient-${index}-name`}
                    label={t("wizard.notifications.name")}
                    error={message("name")}
                  >
                    <Input
                      id={`wizard-recipient-${index}-name`}
                      autoComplete="name"
                      placeholder={t("wizard.notifications.namePlaceholder")}
                      aria-invalid={rowErrors?.name !== undefined}
                      aria-describedby={messageId(`wizard-recipient-${index}-name`)}
                      {...form.register(`notificationRecipients.${index}.name`)}
                    />
                  </Field>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => remove(index)}
                  aria-label={
                    email
                      ? t("wizard.notifications.remove", { email })
                      : t("wizard.notifications.removeUnnamed")
                  }
                >
                  <Trash2 />
                </Button>
              </div>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {OFFERED_NOTIFICATION_CATEGORIES.map((category) => {
                  const id = `wizard-recipient-${index}-${category}`;
                  return (
                    <div key={category} className="flex items-center gap-2">
                      <Checkbox
                        id={id}
                        checked={categories.includes(category)}
                        onCheckedChange={(checked) =>
                          toggleCategory(index, category, checked === true)
                        }
                      />
                      <Label htmlFor={id} className="font-normal">
                        {t(`wizard.notifications.categories.${category}`)}
                      </Label>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        );
      })}
      <Button type="button" variant="outline" onClick={() => append(emptyRecipient())}>
        <Plus />
        {t("wizard.notifications.add")}
      </Button>

      <TestMailCard />
    </div>
  );
}

function TestMailCard() {
  const { t } = useTranslation("tenants");
  const [to, setTo] = React.useState("");
  const test = useSendNotificationTestMail();
  const canSend = to.trim().length > 0 && !test.isPending;

  // A new recipient invalidates whatever the last attempt showed: sending
  // again is the retry, so the button stays the only control, but its result
  // must not linger once it no longer answers the address on screen.
  function updateTo(value: string) {
    setTo(value);
    if (test.data || test.error) {
      test.reset();
    }
  }

  function send() {
    if (canSend) {
      test.mutate(to.trim());
    }
  }

  // The wizard's form treats Enter in a text field as "advance to the next
  // step" (tenant-wizard.tsx), which would otherwise swallow this field's
  // Enter and skip straight to Administrators instead of sending the test
  // mail. Stopping propagation here keeps that handler from ever seeing the
  // key, so Enter does the one useful thing in this field: send.
  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    send();
  }

  const notConfigured =
    test.error instanceof ApiError && test.error.problem?.type === MAIL_NOT_CONFIGURED_PROBLEM;

  return (
    <Card className="border-dashed py-0">
      <CardContent className="space-y-3 p-4">
        <h3 className="text-sm font-medium">{t("wizard.notifications.testMail.title")}</h3>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Field
            id="wizard-test-mail-recipient"
            label={t("wizard.notifications.testMail.recipient")}
            className="flex-1"
          >
            <Input
              id="wizard-test-mail-recipient"
              type="email"
              autoComplete="email"
              placeholder={t("wizard.notifications.testMail.recipientPlaceholder")}
              value={to}
              onChange={(event) => updateTo(event.target.value)}
              onKeyDown={onKeyDown}
            />
          </Field>
          <Button
            type="button"
            variant="outline"
            disabled={!canSend}
            loading={test.isPending}
            onClick={send}
          >
            <Send />
            {t("wizard.notifications.testMail.send")}
          </Button>
        </div>
        {test.data ? (
          test.data.ok ? (
            <Alert>
              <Info />
              <AlertDescription>
                {t("wizard.notifications.testMail.success", {
                  recipient: test.data.recipient,
                  transport: test.data.transport,
                })}
              </AlertDescription>
            </Alert>
          ) : (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertDescription>
                {t(mailTestFailureKey(test.data.failure?.reason ?? "transport_error"), {
                  detail: test.data.failure?.detail ?? "",
                })}
              </AlertDescription>
            </Alert>
          )
        ) : null}
        {test.error ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span>{t(notificationTestErrorKey(test.error).key)}</span>
              {notConfigured ? (
                <Link
                  to={settingsTo()}
                  search={sectionSearch("mail") as never}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}
                >
                  <SettingsIcon />
                  {t("wizard.notifications.testMail.openMailSettings")}
                </Link>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
