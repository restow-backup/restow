import { TriangleAlert } from "lucide-react";
import * as React from "react";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "@/components/ui/sonner";
import { useSession } from "@/lib/session";

import { NAME_MAX_LENGTH } from "../forms";
import { useCreateOwnOrganisation, useMarkOwnOrganisation } from "../hooks";
import { type OwnOrganisationChoice, ownOrganisationError } from "../presenters";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Create the operator's own organisation from its name. The slug follows the
 * name on the server. Afterwards the session works in it, as it does after
 * the setup wizard created it.
 */
export function CreateOwnOrganisationDialog({ open, onOpenChange }: DialogProps) {
  const { t } = useTranslation("tenants");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("ownOrganisation.create.title")}</DialogTitle>
          <DialogDescription>{t("ownOrganisation.create.description")}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open: every opening starts empty. */}
        <CreateForm onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function CreateForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation("tenants");
  const { setActiveTenant } = useSession();
  const create = useCreateOwnOrganisation();
  const [name, setName] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const trimmed = name.trim();
  const missing = trimmed.length === 0;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (missing || create.isPending) {
      return;
    }
    create.mutate(
      { name: trimmed },
      {
        onSuccess: (tenant) => {
          setActiveTenant(tenant.id);
          toast.success(t("ownOrganisation.toasts.ready", { name: tenant.name }));
          onDone();
        },
      },
    );
  };

  const error = create.error ? ownOrganisationError(create.error) : null;

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field
        id="own-organisation-name"
        label={t("ownOrganisation.create.nameLabel")}
        error={touched && missing ? t("common:validation.required") : undefined}
      >
        <Input
          id="own-organisation-name"
          autoComplete="organization"
          maxLength={NAME_MAX_LENGTH}
          placeholder={t("ownOrganisation.create.namePlaceholder")}
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-invalid={touched && missing}
          aria-describedby={messageId("own-organisation-name")}
        />
      </Field>
      {error ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{t(error.key, error.values)}</AlertDescription>
        </Alert>
      ) : null}
      <DialogFooter>
        <Button variant="outline" type="button" onClick={onDone} disabled={create.isPending}>
          {t("common:actions.cancel")}
        </Button>
        <Button type="submit" loading={create.isPending}>
          {t("ownOrganisation.create.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}

interface MarkDialogProps extends DialogProps {
  /** The tenants to choose from (not those being deleted). */
  choices: readonly OwnOrganisationChoice[];
}

/**
 * Mark one of the existing tenants as the operator's own organisation. The
 * tenant itself stays as it is: it is listed first from now on and can no
 * longer be deleted while it is the own organisation.
 */
export function MarkOwnOrganisationDialog({ open, onOpenChange, choices }: MarkDialogProps) {
  const { t } = useTranslation("tenants");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("ownOrganisation.mark.title")}</DialogTitle>
          <DialogDescription>{t("ownOrganisation.mark.description")}</DialogDescription>
        </DialogHeader>
        <MarkForm choices={choices} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function MarkForm({
  choices,
  onDone,
}: { choices: readonly OwnOrganisationChoice[]; onDone: () => void }) {
  const { t } = useTranslation("tenants");
  const { setActiveTenant } = useSession();
  const mark = useMarkOwnOrganisation();
  // A single choice is preselected; with several the person picks deliberately.
  const [selected, setSelected] = React.useState<string>(
    choices.length === 1 ? (choices[0]?.id ?? "") : "",
  );

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const choice = choices.find((candidate) => candidate.id === selected);
    if (!choice || mark.isPending) {
      return;
    }
    mark.mutate(choice.id, {
      onSuccess: (tenant) => {
        setActiveTenant(tenant.id);
        toast.success(t("ownOrganisation.toasts.ready", { name: tenant.name }));
        onDone();
      },
    });
  };

  const error = mark.error ? ownOrganisationError(mark.error) : null;

  return (
    <form onSubmit={submit} className="space-y-4">
      <RadioGroup
        value={selected}
        onValueChange={setSelected}
        aria-label={t("ownOrganisation.mark.choose")}
        className="max-h-72 gap-1 overflow-y-auto"
      >
        {choices.map((choice) => {
          const id = `own-organisation-${choice.id}`;
          return (
            <div key={choice.id} className="flex items-center gap-3 rounded-md px-2 py-2">
              <RadioGroupItem value={choice.id} id={id} />
              <Label htmlFor={id} className="min-w-0 flex-1 flex-wrap gap-x-2 font-normal">
                <span className="break-words font-medium">{choice.name}</span>
                {choice.customerNumber ? (
                  <span className="font-mono text-xs text-muted-foreground">
                    {choice.customerNumber}
                  </span>
                ) : null}
              </Label>
            </div>
          );
        })}
      </RadioGroup>
      {error ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{t(error.key, error.values)}</AlertDescription>
        </Alert>
      ) : null}
      <DialogFooter>
        <Button variant="outline" type="button" onClick={onDone} disabled={mark.isPending}>
          {t("common:actions.cancel")}
        </Button>
        <Button type="submit" disabled={selected === ""} loading={mark.isPending}>
          {t("ownOrganisation.mark.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
