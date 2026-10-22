import { Forward, Plus, RotateCw, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog, CopyButton, RelativeTime, StatusBadge } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import {
  PIN_FIRST,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CommandBlock } from "@/features/archive/command-block";
import "@/features/archive/i18n";
import { FORWARDING_SECTION_ANCHOR } from "@/features/archive/paths";
import { errorMessageKey } from "@/lib/api";

import { useJournalScope, useJournalSetup } from "../journal/hooks";
import type { ForwardingAccount, ForwardingStatus } from "./api";
import { useCreateForwardAddress, useForwarding, useRotateForwardAddress } from "./hooks";
import {
  type ForwardTarget,
  mailcowBccEntries,
  POSTFIX_MAP_PATH,
  postfixBccMap,
  postfixMainCf,
  postfixReload,
  sieveRedirect,
} from "./instructions";

/** Copies arriving are running capture (Lapis), not proof; a silent address is amber. */
export const FORWARDING_TONE = {
  receiving: "info",
  stale: "warning",
  no_copies: "muted",
  no_address: "muted",
} as const satisfies Record<ForwardingStatus, string>;

type Provider = "postfix" | "mailcow" | "sieve" | "google";
const PROVIDERS: readonly Provider[] = ["postfix", "mailcow", "sieve", "google"];

function accountLabel(account: ForwardingAccount): string {
  return account.displayName && account.displayName !== account.login
    ? `${account.displayName} (${account.login})`
    : account.login;
}

/**
 * Forwarding to the archive on the archive page (slot `archive.sections`, docs/ARCHIVE.md
 * "Erfassungswege"): for each IMAP account whose job chose forwarding, its own archive
 * address (issued on request, copied, renewed with a question first) and whether copies
 * arrive; then how to set the copy up at the provider: Postfix and mailcow BCC maps, a
 * Sieve `redirect :copy`, or a Google Workspace routing rule to the tenant's address.
 * Rendered for a tenant administrator on an edition with the receiver.
 */
export function ForwardingSection() {
  const { t } = useTranslation("archive");
  const { enabled, canManage, licensed } = useJournalScope();
  const [cursors, setCursors] = React.useState<string[]>([]);
  const page = useForwarding(cursors.at(-1) ?? null);

  if (!enabled || !canManage || !licensed) {
    return null;
  }
  const accounts = page.data?.items ?? [];

  return (
    <section
      id={FORWARDING_SECTION_ANCHOR}
      className="scroll-mt-6 space-y-4 rounded-md border p-4"
      aria-labelledby="forwarding-title"
      data-slot="forwarding-section"
    >
      <div className="space-y-1">
        <h3 id="forwarding-title" className="flex items-center gap-2 font-medium">
          <Forward aria-hidden="true" className="size-4" />
          {t("forwarding.title")}
        </h3>
        <p className="text-muted-foreground text-sm">{t("forwarding.description")}</p>
      </div>

      {page.isError ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            {t(`common:${errorMessageKey(page.error)}`)}
            <Button variant="outline" size="sm" onClick={() => void page.refetch()}>
              {t("common:actions.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : !page.data ? (
        <Skeleton className="h-24 w-full" aria-busy="true" />
      ) : accounts.length === 0 && cursors.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-slot="forwarding-empty">
          {t("forwarding.empty")}
        </p>
      ) : (
        <>
          {page.data.hostnameIssue ? (
            <Alert variant="warning">
              <TriangleAlert aria-hidden="true" />
              <AlertDescription>
                {t(
                  page.data.hostnameIssue === "missing"
                    ? "journal.address.hostMissing"
                    : "journal.address.hostInvalid",
                )}
              </AlertDescription>
            </Alert>
          ) : null}
          <AccountsTable accounts={accounts} />
          {cursors.length > 0 || page.data.nextCursor ? (
            <nav aria-label={t("forwarding.pages")} className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={cursors.length === 0 || page.isFetching}
                onClick={() => setCursors((current) => current.slice(0, -1))}
              >
                {t("capture.mailboxes.previous")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!page.data.nextCursor || page.isFetching}
                onClick={() => {
                  const next = page.data?.nextCursor;
                  if (next) setCursors((current) => [...current, next]);
                }}
              >
                {t("capture.mailboxes.next")}
              </Button>
            </nav>
          ) : null}
          <ProviderInstructions accounts={accounts} />
        </>
      )}
    </section>
  );
}

function AccountsTable({ accounts }: { accounts: readonly ForwardingAccount[] }) {
  const { t } = useTranslation("archive");
  const create = useCreateForwardAddress();
  const rotate = useRotateForwardAddress();

  return (
    <Table className="min-w-[44rem]" scrollLabel={t("forwarding.accounts")}>
      <TableHeader>
        <TableRow>
          <TableHead pin={PIN_FIRST}>{t("forwarding.account")}</TableHead>
          <TableHead>{t("forwarding.address")}</TableHead>
          <TableHead>{t("forwarding.status")}</TableHead>
          <TableHead>{t("forwarding.lastCopy")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {accounts.map((account) => (
          <TableRow key={account.objectId} data-slot="forwarding-account">
            <TableCell pin={PIN_FIRST} className="max-w-64">
              <span className="block truncate font-medium" title={accountLabel(account)}>
                {accountLabel(account)}
              </span>
              {account.captureKind === "google" ? (
                <span className="text-muted-foreground block text-xs">
                  {t("forwarding.googleAccount")}
                </span>
              ) : null}
            </TableCell>
            <TableCell className="min-w-0">
              {account.captureKind === "google" ? (
                <span className="text-muted-foreground text-xs">
                  {t("forwarding.googleUsesTenant")}
                </span>
              ) : account.address ? (
                <div className="flex items-center gap-1">
                  <code className="bg-muted/40 min-w-0 break-all rounded border px-2 py-1 font-mono text-xs select-all">
                    {account.address}
                  </code>
                  <CopyButton
                    value={account.address}
                    label={t("forwarding.copyFor", { account: account.login })}
                  />
                  <ConfirmDialog
                    trigger={
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t("forwarding.rotateFor", { account: account.login })}
                      >
                        <RotateCw aria-hidden="true" />
                      </Button>
                    }
                    title={t("forwarding.rotate.title", { account: account.login })}
                    description={
                      <>
                        <p>{t("forwarding.rotate.description")}</p>
                        <p>{t("forwarding.rotate.consequence")}</p>
                      </>
                    }
                    confirmLabel={t("forwarding.rotate.confirm")}
                    destructive
                    onConfirm={() =>
                      rotate.mutateAsync(account.objectId).then(() => {
                        toast.success(t("forwarding.rotate.done"));
                      })
                    }
                  />
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={create.isPending}
                  onClick={() =>
                    create.mutate(account.objectId, {
                      onError: (error) => toast.error(t(`common:${errorMessageKey(error)}`)),
                    })
                  }
                  aria-label={t("forwarding.createFor", { account: account.login })}
                >
                  <Plus aria-hidden="true" />
                  {t("forwarding.create")}
                </Button>
              )}
            </TableCell>
            <TableCell>
              <StatusBadge
                tone={FORWARDING_TONE[account.status]}
                icon
                live={account.status === "receiving"}
              >
                {t(`forwarding.state.${account.status}`)}
              </StatusBadge>
              {account.counts.last7Days > 0 ? (
                <span className="text-muted-foreground block text-xs tabular-nums">
                  {t("forwarding.counts", {
                    day: account.counts.last24Hours,
                    week: account.counts.last7Days,
                  })}
                </span>
              ) : null}
            </TableCell>
            <TableCell className="whitespace-nowrap text-sm">
              {account.lastCopyAt ? (
                <RelativeTime value={account.lastCopyAt} />
              ) : (
                <span className="text-muted-foreground">{t("capture.never")}</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** How to make the provider send the copies, per kind of mail server. */
function ProviderInstructions({ accounts }: { accounts: readonly ForwardingAccount[] }) {
  const { t } = useTranslation("archive");
  const targets: ForwardTarget[] = accounts.flatMap((account) =>
    account.captureKind !== "google" && account.address
      ? [{ login: account.login, address: account.address }]
      : [],
  );
  const onlyGoogle = accounts.every((account) => account.captureKind === "google");
  const missing = accounts.some(
    (account) => account.captureKind !== "google" && account.address === null,
  );

  return (
    <div className="space-y-2" data-slot="forwarding-instructions">
      <h4 className="text-sm font-medium">{t("forwarding.setup.title")}</h4>
      <Tabs defaultValue={onlyGoogle ? "google" : "postfix"}>
        <TabsList aria-label={t("forwarding.setup.title")}>
          {PROVIDERS.map((provider) => (
            <TabsTrigger key={provider} value={provider}>
              {t(`forwarding.setup.tab.${provider}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        {(["postfix", "mailcow", "sieve"] as const).map((provider) => (
          <TabsContent key={provider} value={provider} className="space-y-3 pt-2">
            <p className="text-muted-foreground text-sm">
              {t(`forwarding.setup.${provider}.intro`)}
            </p>
            {targets.length === 0 ? (
              <p className="text-muted-foreground text-xs" data-slot="forwarding-no-address">
                {t("forwarding.setup.needsAddress")}
              </p>
            ) : (
              <ProviderBlocks provider={provider} targets={targets} />
            )}
            {missing && targets.length > 0 ? (
              <p className="text-muted-foreground text-xs">{t("forwarding.setup.someMissing")}</p>
            ) : null}
          </TabsContent>
        ))}
        <TabsContent value="google" className="space-y-3 pt-2">
          <GoogleRouting />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ProviderBlocks({
  provider,
  targets,
}: {
  provider: "postfix" | "mailcow" | "sieve";
  targets: readonly ForwardTarget[];
}) {
  const { t } = useTranslation("archive");
  if (provider === "postfix") {
    return (
      <>
        <CommandBlock
          id="forwarding-postfix-map"
          label={t("forwarding.setup.postfix.map", { path: POSTFIX_MAP_PATH })}
          value={postfixBccMap(targets)}
        />
        <CommandBlock
          id="forwarding-postfix-main"
          label={t("forwarding.setup.postfix.main")}
          value={postfixMainCf()}
        />
        <CommandBlock
          id="forwarding-postfix-reload"
          label={t("forwarding.setup.postfix.reload")}
          value={postfixReload()}
        />
      </>
    );
  }
  if (provider === "mailcow") {
    return (
      <CommandBlock
        id="forwarding-mailcow"
        label={t("forwarding.setup.mailcow.entries")}
        value={mailcowBccEntries(targets)}
      />
    );
  }
  return (
    <>
      {targets.map((target, index) => (
        <CommandBlock
          key={target.login}
          id={`forwarding-sieve-${index}`}
          label={t("forwarding.setup.sieve.for", { account: target.login })}
          value={sieveRedirect(target.address)}
        />
      ))}
      <p className="text-muted-foreground text-xs">{t("forwarding.setup.sieve.outgoing")}</p>
    </>
  );
}

/**
 * Google Workspace has no per-account forwarding Restow supports (Gmail's own forwarding
 * needs each user to confirm it); a routing rule in the Admin console adds the tenant's
 * journal address as a further recipient of every mail. The address is fetched only once
 * this tab is opened.
 */
function GoogleRouting() {
  const { t } = useTranslation("archive");
  const setup = useJournalSetup();
  const address = setup.data?.address ?? null;
  return (
    <div className="space-y-3" data-slot="forwarding-google">
      <p className="text-muted-foreground text-sm">{t("forwarding.setup.google.intro")}</p>
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        {(["open", "rule", "messages", "recipient", "save"] as const).map((step) => (
          <li key={step}>{t(`forwarding.setup.google.steps.${step}`)}</li>
        ))}
      </ol>
      {address ? (
        <CommandBlock
          id="forwarding-google-address"
          label={t("forwarding.setup.google.address")}
          value={address}
        />
      ) : setup.isPending ? (
        <Skeleton className="h-9 w-full" aria-busy="true" />
      ) : (
        <p className="text-muted-foreground text-xs">{t("forwarding.setup.google.noAddress")}</p>
      )}
    </div>
  );
}
