import { Ban, Clock } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  PIN_FIRST,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { KEY_STATUS_VARIANT, expiresSoon, scopeKey } from "../presenters";
import { API_SCOPES, type ApiKey, type ApiScope } from "../types";
import { useIntegrationsFormat } from "../use-format";

const VISIBLE_SCOPES = 3;

interface ApiKeyTableProps {
  keys: ApiKey[];
  onRevoke: (key: ApiKey) => void;
}

/** Keys with what they may do, when they were last used and whether they still work. */
export function ApiKeyTable({ keys, onRevoke }: ApiKeyTableProps) {
  const { t } = useTranslation("integrations");
  return (
    <Table className="min-w-[56rem]" scrollLabel={t("apiKeys.title")}>
      <TableHeader>
        <TableRow>
          <TableHead pin={PIN_FIRST}>{t("apiKeys.columns.name")}</TableHead>
          <TableHead>{t("apiKeys.columns.key")}</TableHead>
          <TableHead>{t("apiKeys.columns.scopes")}</TableHead>
          <TableHead>{t("apiKeys.columns.lastUsed")}</TableHead>
          <TableHead>{t("apiKeys.columns.expires")}</TableHead>
          <TableHead>{t("apiKeys.columns.status")}</TableHead>
          <TableHead className="text-right">
            <span className="sr-only">{t("apiKeys.columns.actions")}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {keys.map((key) => (
          <ApiKeyRow key={key.id} apiKey={key} onRevoke={onRevoke} />
        ))}
      </TableBody>
    </Table>
  );
}

function ApiKeyRow({ apiKey, onRevoke }: { apiKey: ApiKey; onRevoke: (key: ApiKey) => void }) {
  const { t, relative, dateTime } = useIntegrationsFormat();
  const revoked = apiKey.status === "revoked";
  const soon = expiresSoon(apiKey, new Date());
  return (
    <TableRow className={revoked ? "text-muted-foreground" : undefined}>
      <TableCell pin={PIN_FIRST} className="min-w-40">
        <div className="font-medium">{apiKey.name}</div>
        <div
          className="text-xs text-muted-foreground"
          title={dateTime(apiKey.createdAt) ?? undefined}
        >
          {relative(apiKey.createdAt)}
          {apiKey.createdBy
            ? ` · ${t("apiKeys.createdBy", { name: apiKey.createdBy.name || apiKey.createdBy.email })}`
            : null}
        </div>
      </TableCell>
      <TableCell>
        <code className="whitespace-nowrap rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
          {apiKey.prefix}…
        </code>
      </TableCell>
      <TableCell>
        <ScopeBadges scopes={apiKey.scopes} />
      </TableCell>
      <TableCell className="whitespace-nowrap text-sm">
        {apiKey.lastUsedAt ? (
          <span title={dateTime(apiKey.lastUsedAt) ?? undefined}>
            {relative(apiKey.lastUsedAt)}
          </span>
        ) : (
          <span className="text-muted-foreground">{t("apiKeys.neverUsed")}</span>
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap text-sm">
        {apiKey.expiresAt ? (
          <span title={dateTime(apiKey.expiresAt) ?? undefined}>{dateTime(apiKey.expiresAt)}</span>
        ) : (
          <span className="text-muted-foreground">{t("apiKeys.noExpiry")}</span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1">
          <Badge variant={KEY_STATUS_VARIANT[apiKey.status]}>
            {t(`apiKeys.status.${apiKey.status}`)}
          </Badge>
          {soon ? (
            <Badge variant="warning">
              <Clock aria-hidden="true" />
              {t("apiKeys.expiresSoon")}
            </Badge>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="text-right">
        {revoked ? null : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRevoke(apiKey)}
            aria-label={t("apiKeys.revokeLabel", { name: apiKey.name })}
          >
            <Ban aria-hidden="true" />
            {t("apiKeys.revoke")}
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

/** The first few scopes as badges; the rest behind a "+n" with the full list on hover or focus. */
function ScopeBadges({ scopes }: { scopes: ApiScope[] }) {
  const { t } = useTranslation("integrations");
  if (scopes.length === API_SCOPES.length) {
    return <Badge variant="secondary">{t("apiKeys.allScopes")}</Badge>;
  }
  const shown = scopes.slice(0, VISIBLE_SCOPES);
  const hidden = scopes.slice(VISIBLE_SCOPES);
  return (
    <div className="flex max-w-72 flex-wrap gap-1">
      {shown.map((scope) => (
        <Badge key={scope} variant="outline" title={scope}>
          {t(`scopes.${scopeKey(scope)}.label`)}
        </Badge>
      ))}
      {hidden.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="rounded-md border border-border px-2 py-0.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("apiKeys.moreScopes", { count: hidden.length })}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {hidden.map((scope) => t(`scopes.${scopeKey(scope)}.label`)).join(", ")}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
