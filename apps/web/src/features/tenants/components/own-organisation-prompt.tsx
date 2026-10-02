import { Link } from "@tanstack/react-router";
import { Building2, UserPlus } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import "../i18n";
import { tenantsListTo } from "../paths";
import type { OwnOrganisationPrompt as Prompt } from "../presenters";
import { CreateOwnOrganisationDialog, MarkOwnOrganisationDialog } from "./own-organisation-dialogs";

interface OwnOrganisationPromptProps {
  prompt: Prompt;
  /** `empty` fills the page when there is no tenant at all; `banner` sits above the overview. */
  variant: "empty" | "banner";
}

/**
 * What the dashboard asks a provider admin about the own organisation
 * (presenters.ts `ownOrganisationPrompt`): to set it up (create it, or choose
 * an existing one), or, once it exists on an installation with several
 * tenants and no customer yet, to add the first customer.
 */
export function OwnOrganisationPrompt({ prompt, variant }: OwnOrganisationPromptProps) {
  const { t } = useTranslation("tenants");
  const [dialog, setDialog] = React.useState<"create" | "mark" | null>(null);

  if (prompt.kind === "addCustomer") {
    const link = (
      <Link
        to={tenantsListTo()}
        search={{ new: "1" } as never}
        className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
      >
        <UserPlus />
        {t("ownOrganisation.prompt.addCustomer.action")}
      </Link>
    );
    return variant === "empty" ? (
      <EmptyState
        icon={UserPlus}
        title={t("ownOrganisation.prompt.addCustomer.title")}
        description={t("ownOrganisation.prompt.addCustomer.description")}
        actions={link}
      />
    ) : (
      <Alert variant="info" data-prompt="add-customer">
        <UserPlus />
        <AlertTitle>{t("ownOrganisation.prompt.addCustomer.title")}</AlertTitle>
        <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <span>{t("ownOrganisation.prompt.addCustomer.description")}</span>
          {link}
        </AlertDescription>
      </Alert>
    );
  }

  const description = prompt.canManage
    ? prompt.existing.length > 0
      ? t("ownOrganisation.prompt.setUp.description")
      : t("ownOrganisation.prompt.setUp.descriptionCreateOnly")
    : t("ownOrganisation.prompt.setUp.readOnly");
  const actions = prompt.canManage ? (
    <>
      {prompt.canCreate ? (
        <Button size="sm" onClick={() => setDialog("create")}>
          <Building2 />
          {t("ownOrganisation.actions.create")}
        </Button>
      ) : null}
      {prompt.existing.length > 0 ? (
        <Button
          size="sm"
          variant={prompt.canCreate ? "outline" : "default"}
          onClick={() => setDialog("mark")}
        >
          {t("ownOrganisation.actions.mark")}
        </Button>
      ) : null}
    </>
  ) : null;

  return (
    <>
      {variant === "empty" ? (
        <EmptyState
          icon={Building2}
          title={t("ownOrganisation.prompt.setUp.title")}
          description={description}
          actions={actions}
        />
      ) : (
        <Alert variant="info" data-prompt="set-up">
          <Building2 />
          <AlertTitle>{t("ownOrganisation.prompt.setUp.title")}</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{description}</span>
            {actions ? <span className="flex flex-wrap gap-2">{actions}</span> : null}
          </AlertDescription>
        </Alert>
      )}
      {prompt.canManage ? (
        <>
          <CreateOwnOrganisationDialog
            open={dialog === "create"}
            onOpenChange={(open) => !open && setDialog(null)}
          />
          <MarkOwnOrganisationDialog
            open={dialog === "mark"}
            onOpenChange={(open) => !open && setDialog(null)}
            choices={prompt.existing}
          />
        </>
      ) : null}
    </>
  );
}
