import { Check, HardDrive, Inbox, Server, Users } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { EmptyState, RelativeTime, StatusBadge } from "@/components/kit";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ObjectKind, SnapshotObject } from "@/features/restore/api";
import { ObjectIcon, objectLabel } from "@/features/restore/explorer/entry-icon";
import {
  type AccountTypeFilter,
  accountAddress,
  accountKeywords,
  matchesAccountType,
  sortAccounts,
} from "@/features/restore/lib/accounts";
import { StateBadge } from "@/features/verify/components/status";
import { cn } from "@/lib/utils";

const TYPE_ICONS: Record<ObjectKind, typeof Inbox> = {
  mailbox: Inbox,
  onedrive: HardDrive,
  imap: Server,
};

/**
 * The string identifying an account to cmdk, for both its fuzzy filter and
 * the controlled highlight above: label plus the (never shown) external id,
 * which keeps it unique even when two accounts share a display name.
 */
function commandValueOf(object: SnapshotObject): string {
  return `${objectLabel(object)} ${object.externalId}`;
}

interface AccountListProps {
  objects: readonly SnapshotObject[];
  value: string | null;
  onChange: (objectId: string) => void;
}

/**
 * The explorer's account pane: a searchable, keyboard-navigable list of every
 * mailbox, OneDrive and IMAP account of the tenant, with a type filter and
 * each account's protection and readiness status. Display names only, never
 * the raw id.
 */
export function AccountList({ objects, value, onChange }: AccountListProps) {
  const { t } = useTranslation("restore");
  const [typeFilter, setTypeFilter] = React.useState<AccountTypeFilter>("all");

  const filtered = React.useMemo(
    () => sortAccounts(objects.filter((object) => matchesAccountType(object, typeFilter))),
    [objects, typeFilter],
  );

  // cmdk highlights its own current item independently of `value` (the
  // *active* account) — left uncontrolled, it defaults to the first row,
  // so the first row and the active account could both look selected at
  // once. Controlling it keeps cmdk's highlight following the active
  // account, while still letting the user move it with the arrow keys
  // (cmdk reports those moves back through `onValueChange`).
  const [highlighted, setHighlighted] = React.useState("");
  React.useEffect(() => {
    const active = filtered.find((object) => object.id === value);
    setHighlighted(active ? commandValueOf(active) : "");
  }, [value, filtered]);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="border-b border-border px-3 py-2.5">
        <h2 className="text-sm font-semibold">{t("explorer.accounts.title")}</h2>
      </div>
      <div className="border-b border-border p-2">
        <Select
          value={typeFilter}
          onValueChange={(next) => setTypeFilter(next as AccountTypeFilter)}
        >
          <SelectTrigger size="sm" className="w-full" aria-label={t("explorer.accounts.typeLabel")}>
            <SelectValue>
              {typeFilter === "all"
                ? t("explorer.accounts.typeAll")
                : t(`explorer.accounts.types.${typeFilter}`)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              <Users />
              {t("explorer.accounts.typeAll")}
            </SelectItem>
            {(Object.keys(TYPE_ICONS) as ObjectKind[]).map((kind) => {
              const Icon = TYPE_ICONS[kind];
              return (
                <SelectItem key={kind} value={kind}>
                  <Icon />
                  {t(`explorer.accounts.types.${kind}`)}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>
      <Command
        className="min-h-0 flex-1 bg-transparent"
        loop
        // cmdk gives its own hidden `<label>` (built from this `label` prop)
        // to the input via `aria-labelledby`, which wins over any `aria-label`
        // `CommandInput` is given below — so the input's accessible name has
        // to be set *here*, not on `CommandInput` itself, or it silently
        // becomes this pane's own heading ("Accounts") instead of what the
        // search field actually does.
        label={t("explorer.accounts.searchLabel")}
        value={highlighted}
        onValueChange={setHighlighted}
      >
        <CommandInput placeholder={t("explorer.accounts.searchPlaceholder")} />
        <CommandList className="max-h-none flex-1">
          <CommandEmpty>
            <EmptyState
              icon={Users}
              title={t("explorer.accounts.empty")}
              description={t("explorer.accounts.emptyDescription")}
              variant="plain"
            />
          </CommandEmpty>
          <CommandGroup>
            {filtered.map((object) => (
              <AccountItem
                key={object.id}
                object={object}
                active={object.id === value}
                onSelect={() => onChange(object.id)}
              />
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  );
}

function AccountItem({
  object,
  active,
  onSelect,
}: {
  object: SnapshotObject;
  active: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation("restore");
  const label = objectLabel(object);
  const address = accountAddress(object);

  return (
    <CommandItem
      value={commandValueOf(object)}
      keywords={accountKeywords(object)}
      onSelect={onSelect}
      aria-current={active ? "true" : undefined}
      className={cn("items-start gap-2 py-2", active && "bg-accent text-accent-foreground")}
    >
      <ObjectIcon kind={object.kind} className="mt-0.5" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex items-baseline gap-1.5 text-sm font-medium">
          <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
          {object.own ? (
            <span className="shrink-0 text-xs font-normal text-muted-foreground">
              · {t("explorer.object.own")}
            </span>
          ) : null}
        </p>
        <p className="truncate text-xs text-muted-foreground" data-slot="account-address">
          {t(`explorer.object.kinds.${object.kind}`)}
          {address ? ` · ${address}` : ""}
        </p>
        <AccountStatus object={object} />
      </div>
      {active ? <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" /> : null}
    </CommandItem>
  );
}

/**
 * Protected/excluded/orphaned, the readiness of the newest backup, the last
 * backup time, or "no restore point yet". An orphaned account (its mailbox
 * or drive is gone from the source, e.g. a deleted user) still keeps every
 * restore point it ever made, so its readiness and last-backup time are
 * exactly as relevant as for an active one — only the badge in front differs.
 */
function AccountStatus({ object }: { object: SnapshotObject }) {
  const { t } = useTranslation("restore");

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      {object.status === "orphaned" ? (
        <StatusBadge tone="warning">{t("explorer.object.orphaned")}</StatusBadge>
      ) : object.sourceKind === "import" ? (
        // Nothing is backed up from an imported mailbox: it is imported, never "not protected".
        <StatusBadge tone="info">{t("explorer.accounts.imported")}</StatusBadge>
      ) : (
        // Protected is a state (in scope, backed up), not a proof: neutral. The readiness
        // badge below carries the green of a passed restore check.
        <StatusBadge tone={object.status === "active" ? "neutral" : "muted"}>
          {t(
            object.status === "active"
              ? "explorer.accounts.protected"
              : "explorer.accounts.excluded",
          )}
        </StatusBadge>
      )}
      {object.snapshotCount === 0 ? (
        <StatusBadge tone="muted">{t("explorer.restorePoint.none")}</StatusBadge>
      ) : (
        <>
          {object.sourceKind === "import" ? null : <StateBadge state={object.readiness} />}
          <span className="text-muted-foreground">
            {t(
              object.sourceKind === "import"
                ? "explorer.accounts.lastImport"
                : "explorer.accounts.lastBackup",
            )}{" "}
            <RelativeTime value={object.latestSnapshotAt} focusable={false} />
          </span>
        </>
      )}
    </div>
  );
}
