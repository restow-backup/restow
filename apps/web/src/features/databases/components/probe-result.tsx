import { KeyRound, Lock, LockOpen, TriangleAlert } from "lucide-react";

import { CopyButton, StatusBadge } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import type { DbCapability, DbProbe, DbRights } from "../api.js";
import type { DbFormat } from "../hooks.js";
import { capabilityView, codeKey, ENGINE_LABEL } from "../presenters.js";

const CAPABILITIES: readonly DbCapability[] = ["backup", "verifyOnInstance", "pitr"];

/**
 * What "Test connection" found (docs/DATABASES.md 3.2): the engine and version, the TLS
 * certificate (its fingerprint is what the connection stores), the databases, and what this user
 * allows, with the SQL that grants the rest to a backup user.
 */
export function ProbeResult({ probe, format }: { probe: DbProbe; format: DbFormat }) {
  const { t } = format;
  return (
    <div className="space-y-4" data-slot="probe-result">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t("probe.engine")}</dt>
        <dd data-slot="probe-engine">
          {probe.engine ? ENGINE_LABEL[probe.engine] : t("probe.engineUnknown")}
          {probe.serverVersion ? ` ${probe.serverVersion}` : ""}
          {probe.port ? (
            <span className="text-muted-foreground"> {t("probe.port", { port: probe.port })}</span>
          ) : null}
        </dd>
        {probe.tls ? (
          <>
            <dt className="text-muted-foreground">{t("probe.tls")}</dt>
            <dd>
              <TlsFacts tls={probe.tls} format={format} />
            </dd>
          </>
        ) : null}
      </dl>
      {probe.error ? (
        <Alert variant={probe.error.code === "db_engine_unsupported" ? "info" : "destructive"}>
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>{t(codeKey(probe.error.code))}</AlertTitle>
          {probe.error.message ? (
            <AlertDescription className="font-mono text-xs break-words">
              {probe.error.message}
            </AlertDescription>
          ) : null}
        </Alert>
      ) : null}
      {probe.rights ? <RightsMatrix rights={probe.rights} format={format} /> : null}
      {probe.databases.length > 0 ? (
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {t("probe.databases", { count: probe.databases.length })}
          </p>
          <ul className="flex flex-wrap gap-1.5 text-sm" data-slot="probe-databases">
            {probe.databases.map((database) => (
              <li key={database.name}>
                <StatusBadge tone={database.accessible ? "neutral" : "warning"}>
                  {database.name}
                  {database.sizeBytes !== null ? ` · ${format.bytes(database.sizeBytes)}` : ""}
                </StatusBadge>
              </li>
            ))}
          </ul>
          {!probe.identityKnown ? (
            <p className="text-xs text-muted-foreground">{t("probe.identityUnknown")}</p>
          ) : null}
          {probe.engine === "mysql" || probe.engine === "mariadb" ? (
            <p className="text-xs text-muted-foreground">{t("probe.schemasByName")}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function TlsFacts({ tls, format }: { tls: NonNullable<DbProbe["tls"]>; format: DbFormat }) {
  const { t } = format;
  if (!tls.used) {
    return (
      <span className="inline-flex items-center gap-1.5" data-slot="probe-tls">
        <LockOpen className="size-4 text-warning-text" aria-hidden="true" />
        {tls.offered === false ? t("probe.tlsNotOffered") : t("probe.tlsNotUsed")}
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-0.5" data-slot="probe-tls">
      <span className="inline-flex items-center gap-1.5">
        <Lock className="size-4" aria-hidden="true" />
        {t("probe.tlsUsed")}
      </span>
      {tls.fingerprintSha256 ? (
        <span className="flex items-start gap-1">
          <code className="font-mono text-xs break-all" data-slot="probe-fingerprint">
            {tls.fingerprintSha256}
          </code>
          <CopyButton value={tls.fingerprintSha256} label={t("probe.copyFingerprint")} />
        </span>
      ) : null}
      {tls.subject ? (
        <span className="text-xs text-muted-foreground">
          {t("probe.certificate", { subject: tls.subject, issuer: tls.issuer ?? "" })}
        </span>
      ) : null}
    </span>
  );
}

export function RightsMatrix({ rights, format }: { rights: DbRights; format: DbFormat }) {
  const { t } = format;
  const missing = CAPABILITIES.some((capability) =>
    ["missing", "partial"].includes(rights.capabilities[capability].state),
  );
  return (
    <div className="space-y-2" data-slot="rights-matrix">
      <p className="text-sm font-medium">{t("rights.title")}</p>
      <Table scrollLabel={t("rights.title")}>
        <TableHeader>
          <TableRow>
            <TableHead>{t("rights.capability")}</TableHead>
            <TableHead>{t("rights.status")}</TableHead>
            <TableHead>{t("rights.missing")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {CAPABILITIES.map((capability) => {
            const verdict = rights.capabilities[capability];
            const view = capabilityView(verdict.state);
            return (
              <TableRow key={capability} data-capability={capability}>
                <TableCell>{t(`rights.capabilities.${capability}`)}</TableCell>
                <TableCell>
                  <StatusBadge tone={view.tone}>{t(view.key)}</StatusBadge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {verdict.missing.length > 0 ? (
                    <code className="font-mono">{verdict.missing.join(", ")}</code>
                  ) : null}
                  {verdict.note ? (
                    <span className="block">{t(`rights.notes.${verdict.note}`)}</span>
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {rights.admin ? (
        <Alert>
          <KeyRound aria-hidden="true" />
          <AlertTitle>{t("rights.admin.title")}</AlertTitle>
          <AlertDescription>
            {t("rights.admin.description", { rights: rights.adminExtras.join(", ") })}
          </AlertDescription>
        </Alert>
      ) : null}
      {rights.grantSql && (missing || rights.admin) ? (
        <div className="space-y-1" data-slot="grant-sql">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm">
              {missing ? t("rights.grant.missing") : t("rights.grant.recommended")}
            </p>
            <CopyButton value={rights.grantSql} label={t("rights.grant.copy")} />
          </div>
          <pre className="overflow-x-auto rounded-md border bg-muted p-3 font-mono text-xs">
            {rights.grantSql}
          </pre>
          <p className="text-xs text-muted-foreground">{t("rights.grant.savesAnyway")}</p>
        </div>
      ) : null}
    </div>
  );
}
