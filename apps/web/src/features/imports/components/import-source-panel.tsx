import { Link } from "@tanstack/react-router";
import { FileInput, History } from "lucide-react";
import { useTranslation } from "react-i18next";

import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { IMPORT_PATHS, importTo } from "../paths";

/**
 * The body of the source detail page for the source of kind `import`: what it
 * is, how many imported mailboxes it holds and the way into the wizard and the
 * imports history. There is no connection to edit or test.
 */
export function ImportSourcePanel({ mailboxes }: { mailboxes: number }) {
  const { t } = useTranslation("imports");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("sourcePanel.title")}</CardTitle>
        <CardDescription>{t("sourcePanel.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm">
          <span className="text-2xl font-semibold tabular-nums">{mailboxes}</span>{" "}
          <span className="text-muted-foreground">
            {t("sourcePanel.mailboxes", { count: mailboxes })}
          </span>
        </p>
        <div className="flex flex-wrap gap-2">
          <Link to={importTo(IMPORT_PATHS.wizard)} className={buttonVariants({ size: "sm" })}>
            <FileInput />
            {t("list.new")}
          </Link>
          <Link
            to={importTo(IMPORT_PATHS.list)}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <History />
            {t("sourcePanel.history")}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
