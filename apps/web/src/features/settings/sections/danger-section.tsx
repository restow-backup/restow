import { TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/sonner";
import type { InstallationSettings } from "../api";
import { ConfirmDialog } from "../components/confirm-dialog";
import { useRemoveMailConfiguration } from "../hooks";
import { settingsErrorKey } from "../presenters";

/** Irreversible installation actions, each behind a confirmation. */
export function DangerSection({ settings }: { settings: InstallationSettings }) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const remove = useRemoveMailConfiguration();
  const [confirming, setConfirming] = React.useState(false);
  const configured = settings.mail.transport !== null;

  const confirm = () => {
    remove.mutate(undefined, {
      onSuccess: () => {
        toast.success(t("toasts.mailRemoved"));
        setConfirming(false);
      },
      onError: (error) => {
        toast.error(tc(settingsErrorKey(error)));
        setConfirming(false);
      },
    });
  };

  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <TriangleAlert className="size-4" aria-hidden="true" />
          {t("danger.title")}
        </CardTitle>
        <CardDescription>{t("danger.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4 rounded-lg border border-destructive/30 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <p className="text-sm font-medium">{t("danger.removeMail.title")}</p>
            <p className="text-sm text-muted-foreground">
              {configured
                ? t("danger.removeMail.description")
                : t("danger.removeMail.notConfigured")}
            </p>
          </div>
          <Button
            variant="destructive"
            className="shrink-0"
            disabled={!configured}
            onClick={() => setConfirming(true)}
          >
            {t("danger.removeMail.action")}
          </Button>
        </div>
      </CardContent>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("danger.removeMail.confirmTitle")}
        description={t("danger.removeMail.confirmDescription")}
        confirmLabel={t("danger.removeMail.confirm")}
        destructive
        pending={remove.isPending}
        onConfirm={confirm}
      />
    </Card>
  );
}
