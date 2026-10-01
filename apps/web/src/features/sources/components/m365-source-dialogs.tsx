import { useNavigate } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { zodResolver } from "@/lib/form";
import {
  type M365EditValues,
  type M365FormValues,
  emptyM365Form,
  fieldMessageKey,
  m365EditSchema,
  m365FormSchema,
  toCreateM365Input,
  toUpdateM365Input,
} from "../forms";
import { sourceDetailTo } from "../paths";
import { problemField, sourceErrorKey } from "../presenters";
import type { SourceDto } from "../types";
import { useCreateSource, useUpdateSource } from "../use-sources";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function SubmitError({ error }: { error: unknown }) {
  const { t: tc } = useTranslation();
  if (!error) {
    return null;
  }
  return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertDescription>{tc(sourceErrorKey(error))}</AlertDescription>
    </Alert>
  );
}

/** Add a Microsoft 365 tenant; the next step (admin consent) happens on its page. */
export function CreateM365Dialog({ open, onOpenChange }: DialogProps) {
  const { t } = useTranslation("sources");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("form.m365.title")}</DialogTitle>
          <DialogDescription>{t("form.m365.description")}</DialogDescription>
        </DialogHeader>
        <CreateM365Form onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function CreateM365Form({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation("sources");
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const create = useCreateSource();
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const form = useForm<M365FormValues>({
    resolver: zodResolver(m365FormSchema),
    defaultValues: emptyM365Form,
  });
  const scopeMode = useWatch({ control: form.control, name: "scopeMode" });
  const errors = form.formState.errors;
  const message = (name: keyof M365FormValues) => {
    const key = fieldMessageKey(errors[name]);
    return key ? tc(key) : undefined;
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      const created = await create.mutateAsync(toCreateM365Input(values));
      toast.success(t("toasts.created"));
      onDone();
      await navigate({ to: sourceDetailTo(created.id) });
    } catch (error) {
      if (problemField(error) === "name") {
        form.setError("name", { message: sourceErrorKey(error) }, { shouldFocus: true });
      } else {
        setSubmitError(error);
      }
    }
  });

  return (
    <>
      <form id="m365-create-form" onSubmit={onSubmit} noValidate className="space-y-4">
        <Field id="m365-name" label={t("form.name")} error={message("name")}>
          <Input
            id="m365-name"
            autoComplete="off"
            placeholder={t("form.namePlaceholderM365")}
            aria-invalid={errors.name !== undefined}
            aria-describedby={messageId("m365-name")}
            {...form.register("name")}
          />
        </Field>

        <Field
          id="m365-tenant"
          label={t("form.m365.tenantHint")}
          hint={t("form.m365.tenantHintHelp")}
          error={message("entraTenantHint")}
        >
          <Input
            id="m365-tenant"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("form.m365.tenantHintPlaceholder")}
            aria-invalid={errors.entraTenantHint !== undefined}
            aria-describedby={messageId("m365-tenant")}
            {...form.register("entraTenantHint")}
          />
        </Field>

        <div className="space-y-1.5">
          <Label htmlFor="m365-scope">{t("form.m365.scope")}</Label>
          <Controller
            control={form.control}
            name="scopeMode"
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={(value) => field.onChange(value as M365FormValues["scopeMode"])}
              >
                <SelectTrigger
                  id="m365-scope"
                  className="w-full"
                  aria-describedby="m365-scope-hint"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("form.m365.scopeAll")}</SelectItem>
                  <SelectItem value="group">{t("form.m365.scopeGroup")}</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
          <p id="m365-scope-hint" className="text-xs text-muted-foreground">
            {t("form.m365.scopeLater")}
          </p>
        </div>

        {scopeMode === "group" ? (
          <Field
            id="m365-group"
            label={t("form.m365.groupId")}
            hint={t("form.m365.groupIdHelp")}
            error={message("groupId")}
          >
            <Input
              id="m365-group"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              aria-invalid={errors.groupId !== undefined}
              aria-describedby={messageId("m365-group")}
              {...form.register("groupId")}
            />
          </Field>
        ) : null}

        <SubmitError error={submitError} />
      </form>

      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={form.formState.isSubmitting}>
          {tc("actions.cancel")}
        </Button>
        <Button type="submit" form="m365-create-form" loading={form.formState.isSubmitting}>
          {t("actions.create")}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Rename a Microsoft 365 source; the consent target is editable until it is connected. */
export function EditM365Dialog({
  open,
  onOpenChange,
  source,
}: DialogProps & { source: SourceDto }) {
  const { t } = useTranslation("sources");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("form.m365.editTitle")}</DialogTitle>
          <DialogDescription>{t("form.m365.editDescription")}</DialogDescription>
        </DialogHeader>
        <EditM365Form source={source} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function EditM365Form({ source, onDone }: { source: SourceDto; onDone: () => void }) {
  const { t } = useTranslation("sources");
  const { t: tc } = useTranslation();
  const update = useUpdateSource(source.id);
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const connected = Boolean(source.m365?.entraTenantId);
  const current = {
    name: source.name,
    entraTenantHint: source.m365?.entraTenantHint ?? null,
    connected,
  };
  const form = useForm<M365EditValues>({
    resolver: zodResolver(m365EditSchema),
    // A connected source keeps its tenant; the field is display-only then.
    defaultValues: {
      name: source.name,
      entraTenantHint: connected ? "" : (source.m365?.entraTenantHint ?? ""),
    },
  });
  const errors = form.formState.errors;
  const message = (name: keyof M365EditValues) => {
    const key = fieldMessageKey(errors[name]);
    return key ? tc(key) : undefined;
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setSubmitError(null);
    const patch = toUpdateM365Input(values, current);
    if (Object.keys(patch).length === 0) {
      onDone();
      return;
    }
    try {
      await update.mutateAsync(patch);
      toast.success(t("toasts.updated"));
      onDone();
    } catch (error) {
      if (problemField(error) === "name") {
        form.setError("name", { message: sourceErrorKey(error) }, { shouldFocus: true });
      } else {
        setSubmitError(error);
      }
    }
  });

  return (
    <>
      <form id="m365-edit-form" onSubmit={onSubmit} noValidate className="space-y-4">
        <Field id="m365-edit-name" label={t("form.name")} error={message("name")}>
          <Input
            id="m365-edit-name"
            autoComplete="off"
            aria-invalid={errors.name !== undefined}
            aria-describedby={messageId("m365-edit-name")}
            {...form.register("name")}
          />
        </Field>
        <Field
          id="m365-edit-tenant"
          label={t("form.m365.tenantHint")}
          hint={connected ? t("form.m365.tenantHintLocked") : t("form.m365.tenantHintHelp")}
          error={message("entraTenantHint")}
        >
          {connected ? (
            <Input
              id="m365-edit-tenant"
              readOnly
              value={source.m365?.entraTenantId ?? ""}
              className="font-mono text-muted-foreground"
              aria-describedby={messageId("m365-edit-tenant")}
            />
          ) : (
            <Input
              id="m365-edit-tenant"
              autoComplete="off"
              spellCheck={false}
              placeholder={t("form.m365.tenantHintPlaceholder")}
              aria-invalid={errors.entraTenantHint !== undefined}
              aria-describedby={messageId("m365-edit-tenant")}
              {...form.register("entraTenantHint")}
            />
          )}
        </Field>
        <SubmitError error={submitError} />
      </form>

      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={form.formState.isSubmitting}>
          {tc("actions.cancel")}
        </Button>
        <Button type="submit" form="m365-edit-form" loading={form.formState.isSubmitting}>
          {tc("actions.save")}
        </Button>
      </DialogFooter>
    </>
  );
}
