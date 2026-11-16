import { useTranslation } from "react-i18next";

/** The command that makes another host a worker node of an existing installation. */
export const JOIN_COMMAND =
  "sudo bash install.sh --join https://<existing installation> --join-token <token> --node-name <name>";

/**
 * Option 3 of the first question: a worker for an existing installation. A worker node runs
 * neither this web interface nor the api, so the wizard does not set it up: install.sh --join
 * does, on the new host, with a join token from Installation › Cluster of the existing
 * installation. This host should not be set up as an installation of its own.
 */
export function WorkerStep() {
  const { t } = useTranslation("setup");

  return (
    <div className="space-y-4 text-sm">
      <p className="text-muted-foreground">{t("workerInfo.notHere")}</p>
      <ol className="list-decimal space-y-2 pl-5 text-muted-foreground">
        <li>{t("workerInfo.steps.cluster")}</li>
        <li>{t("workerInfo.steps.database")}</li>
        <li>{t("workerInfo.steps.token")}</li>
        <li>{t("workerInfo.steps.run")}</li>
      </ol>
      <pre className="overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs text-foreground">
        {JOIN_COMMAND}
      </pre>
      <p className="text-muted-foreground">{t("workerInfo.requirements")}</p>
      <p className="rounded-md border border-dashed p-3 text-muted-foreground">
        {t("workerInfo.replication")}
      </p>
    </div>
  );
}
