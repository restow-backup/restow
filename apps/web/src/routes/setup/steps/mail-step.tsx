import { Controller, type UseFormReturn, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { PasswordInput } from "@/components/forms/password-input";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { MailTransport, SmtpSecurity } from "@/lib/api";
import { validationKey } from "@/lib/form";
import { DEFAULT_SMTP_PORT, type SetupFormValues } from "@/routes/setup/schema";

interface MailStepProps {
  form: UseFormReturn<SetupFormValues>;
}

const SECURITY_OPTIONS: readonly SmtpSecurity[] = ["starttls", "tls", "none"];

export function MailStep({ form }: MailStepProps) {
  const { t } = useTranslation("setup");
  const { t: tc } = useTranslation();

  const transport = useWatch({ control: form.control, name: "mail.transport" });
  const skipped = useWatch({ control: form.control, name: "mail.skipped" });
  const errors = form.formState.errors.mail;

  const message = (error: Parameters<typeof validationKey>[0]) => {
    const key = validationKey(error);
    return key ? tc(key) : undefined;
  };

  return (
    <div className="space-y-5">
      <div className="space-y-1 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
        <p>{t("mail.skip.explanation")}</p>
        {skipped ? <p className="font-medium text-foreground">{t("mail.skip.skipped")}</p> : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="mail-transport">{t("mail.transport.label")}</Label>
        <Controller
          control={form.control}
          name="mail.transport"
          render={({ field }) => (
            <Select
              value={field.value}
              onValueChange={(value) => field.onChange(value as MailTransport)}
            >
              <SelectTrigger
                id="mail-transport"
                className="w-full"
                aria-label={t("mail.transport.label")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="smtp">{t("mail.transport.smtp")}</SelectItem>
                <SelectItem value="graph">{t("mail.transport.graph")}</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
      </div>

      {transport === "smtp" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="smtp-host" label={t("mail.smtp.host")} error={message(errors?.smtp?.host)}>
            <Input
              id="smtp-host"
              autoComplete="off"
              placeholder={t("mail.smtp.hostPlaceholder")}
              aria-invalid={errors?.smtp?.host !== undefined}
              aria-describedby={messageId("smtp-host")}
              {...form.register("mail.smtp.host")}
            />
          </Field>

          <div className="grid grid-cols-[1fr_auto] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="smtp-security">{t("mail.smtp.security")}</Label>
              <Controller
                control={form.control}
                name="mail.smtp.security"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={(value) => {
                      const security = value as SmtpSecurity;
                      const currentPort = form.getValues("mail.smtp.port");
                      const wasDefault = Object.values(DEFAULT_SMTP_PORT).includes(currentPort);
                      field.onChange(security);
                      // Follow the conventional port unless the user typed their own.
                      if (wasDefault || !currentPort) {
                        form.setValue("mail.smtp.port", DEFAULT_SMTP_PORT[security]);
                      }
                    }}
                  >
                    <SelectTrigger
                      id="smtp-security"
                      className="w-full"
                      aria-label={t("mail.smtp.security")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SECURITY_OPTIONS.map((option) => (
                        <SelectItem key={option} value={option}>
                          {t(`mail.smtp.securityOptions.${option}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <Field
              id="smtp-port"
              label={t("mail.smtp.port")}
              error={message(errors?.smtp?.port)}
              className="w-24"
            >
              <Input
                id="smtp-port"
                inputMode="numeric"
                autoComplete="off"
                aria-invalid={errors?.smtp?.port !== undefined}
                aria-describedby={messageId("smtp-port")}
                {...form.register("mail.smtp.port")}
              />
            </Field>
          </div>

          <Field
            id="smtp-username"
            label={t("mail.smtp.username")}
            hint={t("mail.smtp.usernameHint")}
            error={message(errors?.smtp?.username)}
          >
            <Input
              id="smtp-username"
              autoComplete="off"
              aria-describedby={messageId("smtp-username")}
              {...form.register("mail.smtp.username")}
            />
          </Field>

          <Field
            id="smtp-password"
            label={t("mail.smtp.password")}
            hint={t("mail.smtp.passwordHint")}
            error={message(errors?.smtp?.password)}
          >
            <PasswordInput
              id="smtp-password"
              autoComplete="off"
              aria-describedby={messageId("smtp-password")}
              {...form.register("mail.smtp.password")}
            />
          </Field>

          <Field
            id="smtp-from"
            label={t("mail.smtp.from")}
            error={message(errors?.smtp?.from)}
            className="sm:col-span-2"
          >
            <Input
              id="smtp-from"
              type="email"
              autoComplete="off"
              placeholder={t("mail.smtp.fromPlaceholder")}
              aria-invalid={errors?.smtp?.from !== undefined}
              aria-describedby={messageId("smtp-from")}
              {...form.register("mail.smtp.from")}
            />
          </Field>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            {t("mail.graph.hint")}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="graph-sender"
              label={t("mail.graph.sender")}
              error={message(errors?.graph?.sender)}
            >
              <Input
                id="graph-sender"
                type="email"
                autoComplete="off"
                placeholder={t("mail.graph.senderPlaceholder")}
                aria-invalid={errors?.graph?.sender !== undefined}
                aria-describedby={messageId("graph-sender")}
                {...form.register("mail.graph.sender")}
              />
            </Field>
            <Field
              id="graph-tenant"
              label={t("mail.graph.tenantId")}
              error={message(errors?.graph?.tenantId)}
            >
              <Input
                id="graph-tenant"
                autoComplete="off"
                placeholder={t("mail.graph.tenantIdPlaceholder")}
                aria-describedby={messageId("graph-tenant")}
                {...form.register("mail.graph.tenantId")}
              />
            </Field>
          </div>
        </div>
      )}

      <Controller
        control={form.control}
        name="sendTest"
        render={({ field }) => (
          <div className="flex items-start gap-3 rounded-md border border-border p-3">
            <Checkbox
              id="send-test"
              checked={field.value}
              onCheckedChange={(checked) => field.onChange(checked === true)}
              className="mt-0.5"
            />
            <div className="space-y-0.5">
              <Label htmlFor="send-test" className="cursor-pointer">
                {t("mail.sendTest.label")}
              </Label>
              <p className="text-xs text-muted-foreground">{t("mail.sendTest.hint")}</p>
            </div>
          </div>
        )}
      />
    </div>
  );
}
