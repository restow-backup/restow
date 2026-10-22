import * as React from "react";
import { useTranslation } from "react-i18next";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CommandBlock } from "@/features/archive/command-block";

import type { JournalSetup } from "./api";
import { journalPowerShell, ndrProblem } from "./powershell";

/**
 * The journal setup as Exchange Online PowerShell commands to copy (docs/ARCHIVE.md
 * "Exchange-Online-Journaling einrichten"): the administrator names the mailbox for
 * undeliverable journal reports, and the block holds the connector, that mailbox and the
 * journal rule for this tenant's address. Nothing runs here; the commands are only text.
 */
export function JournalPowerShell({ setup }: { setup: JournalSetup }) {
  const { t } = useTranslation("archive");
  const [ndr, setNdr] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const inputId = React.useId();
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;

  if (!setup.address || !setup.hostname) {
    return null;
  }
  const problem = ndrProblem(ndr, { address: setup.address, hostname: setup.hostname });
  const shown = touched || ndr.trim() !== "" ? problem : null;
  const script =
    problem === null
      ? journalPowerShell({
          address: setup.address,
          journalHost: setup.hostname,
          ndrAddress: ndr.trim(),
          appName: t("common:app.name"),
        })
      : null;

  return (
    <div className="space-y-3" data-slot="journal-powershell">
      <div className="space-y-0.5">
        <h4 className="text-sm font-medium">{t("journal.powershell.title")}</h4>
        <p className="text-muted-foreground text-sm">{t("journal.powershell.intro")}</p>
      </div>
      <div className="grid max-w-md gap-1">
        <Label htmlFor={inputId}>{t("journal.powershell.ndrLabel")}</Label>
        <Input
          id={inputId}
          type="email"
          autoComplete="off"
          spellCheck={false}
          value={ndr}
          placeholder={t("journal.powershell.ndrPlaceholder")}
          onChange={(event) => setNdr(event.target.value)}
          onBlur={() => setTouched(true)}
          aria-invalid={shown ? true : undefined}
          aria-describedby={shown ? `${hintId} ${errorId}` : hintId}
        />
        <p id={hintId} className="text-muted-foreground text-xs">
          {t("journal.powershell.ndrHint")}
        </p>
        {shown ? (
          <p id={errorId} role="alert" className="text-destructive text-xs">
            {t(`journal.powershell.ndrProblem.${shown}`)}
          </p>
        ) : null}
      </div>
      {script ? (
        <CommandBlock
          id="journal-powershell-script"
          label={t("journal.powershell.blockLabel")}
          value={script}
        />
      ) : (
        <p className="text-muted-foreground text-xs" data-slot="journal-powershell-waiting">
          {t("journal.powershell.needsNdr")}
        </p>
      )}
    </div>
  );
}
