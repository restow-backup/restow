import { useMutation } from "@tanstack/react-query";
import { ChevronDown, Plus, Server } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { CopyButton } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import { type CreatedPveToken, type ExistingPveToken, createToken } from "./api.js";
import { PVE_NAMESPACE } from "./i18n.js";

/** `user@realm!name`, as the API accepts it (apps/api/src/features/pve/schemas.ts). */
export const PVE_TOKEN_ID_RE = /^[A-Za-z0-9._-]+@[A-Za-z][A-Za-z0-9._-]+![A-Za-z][A-Za-z0-9._-]+$/;
const PVE_TOKEN_SECRET_RE = /^[A-Za-z0-9._-]{16,128}$/;
/** The user the installer sets up and the documentation names. */
const EXPECTED_USER = "restow@pve";

/** What the form for an existing PVE API token says about its input. */
export function existingTokenState(tokenId: string, secret: string) {
  const id = tokenId.trim();
  const idValid = PVE_TOKEN_ID_RE.test(id);
  return {
    idValid,
    secretValid: PVE_TOKEN_SECRET_RE.test(secret.trim()),
    // Allowed, but not what the documentation sets up.
    unexpectedUser: idValid && id.slice(0, id.indexOf("!")) !== EXPECTED_USER,
  };
}

/**
 * Connect Proxmox VE: one ready-to-run command per node, with that node's
 * one-time enrollment token in it. The installer sets up the PVE side and
 * creates the node's own API token; optionally the admin hands over an
 * existing PVE API token instead. Every further node gets a new command.
 */
export function ConnectDialog() {
  const { t, i18n } = useTranslation(PVE_NAMESPACE);
  const [open, setOpen] = React.useState(false);
  const [commands, setCommands] = React.useState<CreatedPveToken[]>([]);
  const [useExisting, setUseExisting] = React.useState(false);
  const [tokenId, setTokenId] = React.useState("");
  const [secret, setSecret] = React.useState("");
  const [submitted, setSubmitted] = React.useState(false);
  const mutation = useMutation({
    mutationFn: (pveToken?: ExistingPveToken) => createToken(pveToken),
    onSuccess: (created) => setCommands((list) => [...list, created]),
  });

  const close = (next: boolean) => {
    setOpen(next);
    if (!next) {
      // Nothing of it outlives the dialog, the secret least of all.
      setCommands([]);
      setUseExisting(false);
      setTokenId("");
      setSecret("");
      setSubmitted(false);
      mutation.reset();
    }
  };

  const state = existingTokenState(tokenId, secret);
  const create = () => {
    if (!useExisting) {
      mutation.mutate(undefined);
      return;
    }
    setSubmitted(true);
    if (state.idValid && state.secretValid) {
      mutation.mutate({ id: tokenId.trim(), secret: secret.trim() });
    }
  };

  // The next commands go without the entered PVE API token: the installer creates its own.
  const withoutToken = () => {
    setUseExisting(false);
    setTokenId("");
    setSecret("");
    setSubmitted(false);
    mutation.mutate(undefined);
  };

  const language = i18n.resolvedLanguage ?? i18n.language;
  const started = commands.length > 0;
  return (
    <Dialog open={open} onOpenChange={close}>
      <Button type="button" size="sm" onClick={() => setOpen(true)} data-slot="pve-connect">
        <Server aria-hidden="true" />
        {t("connect.button")}
      </Button>
      <DialogContent className="max-w-3xl">
        <DialogHeader className="min-w-0">
          <DialogTitle>{t("connect.title")}</DialogTitle>
          <DialogDescription>{t("connect.description")}</DialogDescription>
        </DialogHeader>
        {started ? (
          <ol className="min-w-0 space-y-4 text-sm" data-slot="pve-commands">
            {commands.map((created, index) => (
              <li key={created.id} className="min-w-0 space-y-2">
                <p className="font-medium">{t("connect.node", { number: index + 1 })}</p>
                <div className="flex min-w-0 items-start gap-1 rounded-md border border-border bg-muted/50 pl-3">
                  <code
                    className="min-w-0 flex-1 py-2 font-mono text-xs break-all whitespace-pre-wrap"
                    data-slot="pve-command"
                  >
                    {created.nodeCommand}
                  </code>
                  <CopyButton value={created.nodeCommand} label={t("connect.copy")} />
                </div>
                <p className="text-muted-foreground">
                  {t("connect.runHint", {
                    expires: formatDateTime(created.expiresAt, language) ?? "",
                  })}
                </p>
                {created.pveTokenId ? (
                  // Easy to overlook otherwise: this command brings the token entered above.
                  <p
                    className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2"
                    data-slot="pve-uses-token"
                  >
                    {t("connect.usesToken", { tokenId: created.pveTokenId })}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <Collapsible
            open={useExisting}
            onOpenChange={setUseExisting}
            className="min-w-0 space-y-3 text-sm"
          >
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="link"
                className="h-auto px-0 whitespace-normal"
                data-slot="pve-existing-toggle"
              >
                <ChevronDown
                  aria-hidden="true"
                  className={cn("transition-transform", useExisting ? "rotate-180" : null)}
                />
                {t("connect.existingToggle")}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3" data-slot="pve-existing-form">
              <p className="text-muted-foreground">{t("connect.existingHint")}</p>
              <div className="space-y-1.5">
                <Label htmlFor="pve-token-id">{t("connect.tokenId")}</Label>
                <Input
                  id="pve-token-id"
                  value={tokenId}
                  onChange={(event) => setTokenId(event.target.value)}
                  placeholder="restow@pve!restow"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={(submitted && !state.idValid) || undefined}
                  aria-describedby="pve-token-id-help"
                />
                <p id="pve-token-id-help" className="text-muted-foreground">
                  {submitted && !state.idValid ? (
                    <span className="text-destructive">{t("connect.tokenIdInvalid")}</span>
                  ) : state.unexpectedUser ? (
                    <span data-slot="pve-token-unexpected">{t("connect.tokenIdUnexpected")}</span>
                  ) : null}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pve-token-secret">{t("connect.secret")}</Label>
                <Input
                  id="pve-token-secret"
                  type="password"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={(submitted && !state.secretValid) || undefined}
                  aria-describedby="pve-token-secret-help"
                />
                <p id="pve-token-secret-help" className="text-destructive">
                  {submitted && !state.secretValid ? t("connect.secretInvalid") : null}
                </p>
              </div>
              <p className="text-muted-foreground">{t("connect.existingSecurity")}</p>
            </CollapsibleContent>
          </Collapsible>
        )}
        {started ? (
          <p className="text-sm text-muted-foreground">{t("connect.anotherHint")}</p>
        ) : null}
        <DialogFooter className="gap-2">
          {started ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={create}
                disabled={mutation.isPending}
                data-slot="pve-another"
              >
                <Plus aria-hidden="true" />
                {t("connect.another")}
              </Button>
              {useExisting ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={withoutToken}
                  disabled={mutation.isPending}
                  data-slot="pve-without-token"
                >
                  {t("connect.withoutToken")}
                </Button>
              ) : null}
              <Button type="button" onClick={() => close(false)}>
                {t("connect.close")}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              onClick={create}
              disabled={mutation.isPending}
              data-slot="pve-create"
            >
              {t("connect.create")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
