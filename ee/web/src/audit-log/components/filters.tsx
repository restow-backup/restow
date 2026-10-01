import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { TenantSummary } from "@/lib/api";
import { type AuditActionCount, INSTALLATION_CHAIN } from "../api";
import type { AuditFormat } from "../hooks";
import type { AuditSearch } from "../search";
import { ActionFilter } from "./action-filter";

/** Select value standing for "no filter" (Radix selects need a non-empty value). */
const ALL = "__all__";
/** How long a search box waits for the typing to stop. */
const TYPING_DELAY_MS = 350;

export function AuditFilters({
  search,
  showTenantFilter,
  tenants,
  actions,
  filtered,
  format,
  onChange,
  onClear,
}: {
  search: AuditSearch;
  showTenantFilter: boolean;
  tenants: readonly TenantSummary[];
  actions: readonly AuditActionCount[];
  filtered: boolean;
  format: AuditFormat;
  onChange: (change: Partial<AuditSearch>) => void;
  onClear: () => void;
}) {
  const { t } = format;
  return (
    <div className="flex flex-wrap items-end gap-3">
      {showTenantFilter ? (
        <TenantFilter
          value={search.tenant}
          tenants={tenants}
          format={format}
          onChange={(tenant) => onChange({ tenant })}
        />
      ) : null}
      <div className="space-y-1.5">
        <FilterLabel id="audit-filter-action-label" htmlFor="audit-filter-action">
          {t("filters.action")}
        </FilterLabel>
        <ActionFilter
          id="audit-filter-action"
          labelId="audit-filter-action-label"
          value={search.action}
          actions={actions}
          format={format}
          onChange={(action) => onChange({ action })}
        />
      </div>
      <SearchField
        id="audit-filter-actor"
        label={t("filters.actor")}
        placeholder={t("filters.actorPlaceholder")}
        value={search.actor}
        onCommit={(actor) => onChange({ actor })}
      />
      <SearchField
        id="audit-filter-target"
        label={t("filters.target")}
        placeholder={t("filters.targetPlaceholder")}
        value={search.target}
        onCommit={(target) => onChange({ target })}
      />
      <DateField
        id="audit-filter-from"
        label={t("filters.from")}
        value={search.from}
        max={search.to}
        onChange={(from) => onChange({ from })}
      />
      <DateField
        id="audit-filter-to"
        label={t("filters.to")}
        value={search.to}
        min={search.from}
        onChange={(to) => onChange({ to })}
      />
      {filtered ? (
        <Button variant="ghost" size="sm" className="h-9" onClick={onClear}>
          {t("filters.clear")}
        </Button>
      ) : null}
    </div>
  );
}

function FilterLabel({
  id,
  htmlFor,
  children,
}: {
  id?: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <Label id={id} htmlFor={htmlFor} className="text-xs text-muted-foreground">
      {children}
    </Label>
  );
}

function TenantFilter({
  value,
  tenants,
  format,
  onChange,
}: {
  value: string | undefined;
  tenants: readonly TenantSummary[];
  format: AuditFormat;
  onChange: (tenant: string | undefined) => void;
}) {
  const { t } = format;
  const sorted = [...tenants].sort((a, b) => a.name.localeCompare(b.name));
  // A linked tenant this browser does not list (yet) still shows as selected.
  const unlisted =
    value && value !== INSTALLATION_CHAIN && !tenants.some((tenant) => tenant.id === value)
      ? value
      : null;
  return (
    <div className="space-y-1.5">
      <FilterLabel htmlFor="audit-filter-tenant">{t("filters.tenant")}</FilterLabel>
      <Select
        value={value ?? ALL}
        onValueChange={(next) => onChange(next === ALL ? undefined : next)}
      >
        <SelectTrigger id="audit-filter-tenant" className="max-w-full min-w-52">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t("filters.allTenants")}</SelectItem>
          <SelectItem value={INSTALLATION_CHAIN}>{t("filters.installation")}</SelectItem>
          {unlisted ? <SelectItem value={unlisted}>{unlisted}</SelectItem> : null}
          {sorted.map((tenant) => (
            <SelectItem key={tenant.id} value={tenant.id}>
              {tenant.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** A search box that commits once typing pauses, and follows outside changes. */
function SearchField({
  id,
  label,
  placeholder,
  value,
  onCommit,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string | undefined;
  onCommit: (value: string | undefined) => void;
}) {
  const [draft, setDraft] = React.useState(value ?? "");
  const commit = React.useRef(onCommit);
  commit.current = onCommit;

  React.useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  React.useEffect(() => {
    const next = draft.trim();
    if (next === (value ?? "")) {
      return;
    }
    const timer = setTimeout(() => commit.current(next || undefined), TYPING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, value]);

  return (
    <div className="space-y-1.5">
      <FilterLabel htmlFor={id}>{label}</FilterLabel>
      <Input
        id={id}
        type="search"
        className="w-56"
        placeholder={placeholder}
        value={draft}
        autoComplete="off"
        onChange={(event) => setDraft(event.target.value)}
      />
    </div>
  );
}

function DateField({
  id,
  label,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  value: string | undefined;
  min?: string;
  max?: string;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <div className="space-y-1.5">
      <FilterLabel htmlFor={id}>{label}</FilterLabel>
      <Input
        id={id}
        type="date"
        className="w-40"
        value={value ?? ""}
        min={min}
        max={max}
        onChange={(event) => onChange(event.target.value || undefined)}
      />
    </div>
  );
}
