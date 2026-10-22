/**
 * The Exchange Online PowerShell commands an administrator runs to check whether deleted
 * mail of a Microsoft 365 tenant is kept by a hold, before confirming that for a source
 * (`PUT /archive/capture/holds/:sourceId`, docs/MICROSOFT.md "Holds").
 *
 * Microsoft Graph v1.0 has no way to read litigation hold or retention policy coverage of a
 * mailbox (the spike in docs/MICROSOFT.md), so the hold is confirmed by an administrator and
 * these read-only commands are what the archive page shows to check it. Every command
 * only reads; none takes input, so nothing needs quoting. The texts explaining each one
 * belong to the UI (`archive:capture.holds.checks.<id>`), the commands are the same in
 * every language.
 */

/** Where a command runs: Exchange Online PowerShell, or Security & Compliance PowerShell. */
export type HoldCheckShell = "exchange" | "compliance";

export interface HoldCheckCommand {
  /** Stable id; the UI's text for it is `archive:capture.holds.checks.<id>`. */
  readonly id: string;
  readonly shell: HoldCheckShell;
  readonly command: string;
}

export const HOLD_CHECK_COMMANDS: readonly HoldCheckCommand[] = [
  { id: "connect_exchange", shell: "exchange", command: "Connect-ExchangeOnline" },
  {
    id: "litigation_hold",
    shell: "exchange",
    command:
      "Get-Mailbox -ResultSize Unlimited | Select-Object UserPrincipalName, LitigationHoldEnabled, LitigationHoldDuration, InPlaceHolds",
  },
  {
    id: "mailboxes_without_hold",
    shell: "exchange",
    command:
      "Get-Mailbox -ResultSize Unlimited | Where-Object { -not $_.LitigationHoldEnabled -and $_.InPlaceHolds.Count -eq 0 } | Select-Object UserPrincipalName",
  },
  {
    id: "organization_holds",
    shell: "exchange",
    command: "Get-OrganizationConfig | Select-Object -ExpandProperty InPlaceHolds",
  },
  { id: "connect_compliance", shell: "compliance", command: "Connect-IPPSSession" },
  {
    id: "retention_policies",
    shell: "compliance",
    command:
      "Get-RetentionCompliancePolicy -DistributionDetail | Where-Object { $_.ExchangeLocation } | Select-Object Name, Enabled, Mode, DistributionStatus, ExchangeLocation, ExchangeLocationException",
  },
  {
    id: "retention_rules",
    shell: "compliance",
    command:
      "Get-RetentionComplianceRule | Select-Object Policy, Name, RetentionDuration, RetentionComplianceAction",
  },
];

/** The check commands, in the order they are run. */
export function holdCheckCommands(): readonly HoldCheckCommand[] {
  return HOLD_CHECK_COMMANDS;
}
