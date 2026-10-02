import { Search, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog, ErrorState, StatusBadge } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PIN_FIRST,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import type { JobCandidate, JobKind } from "../api.js";
import { type SelectedMember, selectedOfCandidate } from "../form.js";
import { useJobCandidates } from "../hooks.js";
import { MEMBER_KIND_ICON } from "../presenters.js";

export interface PickerValue {
  selected: SelectedMember[];
  /** Ids of the selected objects or machines that are taken from another job. */
  moves: string[];
}

export interface MemberPickerProps {
  idPrefix: string;
  kind: JobKind;
  /** The job being edited, so that its own members do not read as "in another job". */
  jobId?: string;
  value: PickerValue;
  onChange: (next: PickerValue) => void;
  disabled?: boolean;
}

/** Whether an object or machine belongs to a job other than this one. */
function takenBy(job: SelectedMember["job"], jobId: string | undefined) {
  return job !== null && job.id !== jobId ? job : null;
}

/**
 * The objects (mail) or machines (machine jobs) a job covers, picked from a
 * searchable table with a box in front of each. One that already belongs to another
 * job says so ("In Servers hourly") and is taken over only after a confirmation
 * ("Move here"): it then leaves the other job. The same picker serves the job
 * editor and "Add" on the scope tab.
 */
export function MemberPicker({
  idPrefix,
  kind,
  jobId,
  value,
  onChange,
  disabled = false,
}: MemberPickerProps) {
  const { t } = useTranslation("backupjobs");
  const [search, setSearch] = React.useState("");
  const [onlySelected, setOnlySelected] = React.useState(false);
  const [moving, setMoving] = React.useState<JobCandidate | null>(null);
  const candidates = useJobCandidates(kind, search, !onlySelected);
  const items = candidates.data?.items ?? [];
  const selectedIds = React.useMemo(
    () => new Set(value.selected.map((member) => member.id)),
    [value.selected],
  );
  const moveIds = React.useMemo(() => new Set(value.moves), [value.moves]);

  // Names of preselected objects (an address that came with ids) fill in as the list that knows them loads.
  const { selected, moves } = value;
  React.useEffect(() => {
    if (!candidates.data || !selected.some((member) => member.name === null)) {
      return;
    }
    const known = new Map(candidates.data.items.map((item) => [item.targetId, item]));
    let changed = false;
    const next = selected.map((member) => {
      const found = member.name === null ? known.get(member.id) : undefined;
      if (!found) {
        return member;
      }
      changed = true;
      return {
        ...selectedOfCandidate(found),
        ...(member.overrides ? { overrides: member.overrides } : {}),
      };
    });
    if (changed) {
      onChange({ selected: next, moves });
    }
  }, [candidates.data, selected, moves, onChange]);

  const rows: SelectedMember[] = onlySelected
    ? value.selected.filter((member) =>
        search.trim() === ""
          ? true
          : `${member.name ?? ""} ${member.detail ?? ""}`
              .toLowerCase()
              .includes(search.trim().toLowerCase()),
      )
    : items.map(selectedOfCandidate);

  const free = rows.filter((row) => takenBy(row.job, jobId) === null);
  const allChecked = free.length > 0 && free.every((row) => selectedIds.has(row.id));
  const someChecked = free.some((row) => selectedIds.has(row.id));

  const toggle = (row: SelectedMember, checked: boolean) => {
    if (checked) {
      if (selectedIds.has(row.id)) return;
      onChange({
        selected: [...value.selected, { ...row, job: takenBy(row.job, jobId) }],
        moves: value.moves,
      });
    } else {
      onChange({
        selected: value.selected.filter((member) => member.id !== row.id),
        moves: value.moves.filter((id) => id !== row.id),
      });
    }
  };

  const toggleAll = (checked: boolean) => {
    if (checked) {
      const added = free.filter((row) => !selectedIds.has(row.id));
      onChange({ selected: [...value.selected, ...added], moves: value.moves });
    } else {
      const drop = new Set(free.map((row) => row.id));
      onChange({
        selected: value.selected.filter((member) => !drop.has(member.id)),
        moves: value.moves.filter((id) => !drop.has(id)),
      });
    }
  };

  const confirmMove = (candidate: JobCandidate) => {
    const row = selectedOfCandidate(candidate);
    onChange({
      selected: selectedIds.has(row.id) ? value.selected : [...value.selected, row],
      moves: moveIds.has(row.id) ? value.moves : [...value.moves, row.id],
    });
  };

  const keepElsewhere = (row: SelectedMember) => {
    onChange({
      selected: value.selected.filter((member) => member.id !== row.id),
      moves: value.moves.filter((id) => id !== row.id),
    });
  };

  const total = candidates.data?.total ?? 0;
  const searchId = `${idPrefix}-search`;
  return (
    <div className="space-y-3" data-slot="member-picker">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id={searchId}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                // Enter in the search field filters; it must not save the form around it.
                event.preventDefault();
              }
            }}
            placeholder={t(`picker.search.${kind}`)}
            aria-label={t(`picker.search.${kind}`)}
            autoComplete="off"
            className="pl-8"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-pressed={onlySelected}
          onClick={() => setOnlySelected((current) => !current)}
        >
          {t("picker.showSelected", { count: value.selected.length })}
        </Button>
      </div>

      {!onlySelected && candidates.isError ? (
        <ErrorState
          title={t("picker.loadError")}
          error={candidates.error}
          onRetry={() => void candidates.refetch()}
          retrying={candidates.isFetching}
        />
      ) : !onlySelected && candidates.isPending ? (
        <div aria-busy="true" className="space-y-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : (
        <div className="max-h-80 overflow-auto rounded-md border" data-slot="member-picker-list">
          <Table
            scrollLabel={t(`picker.table.${kind}`)}
            aria-busy={candidates.isFetching || undefined}
          >
            <TableHeader>
              <TableRow>
                <TableHead className="w-10 pl-3">
                  <Checkbox
                    checked={allChecked ? true : someChecked ? "indeterminate" : false}
                    disabled={disabled || free.length === 0}
                    onCheckedChange={(checked) => toggleAll(checked === true)}
                    aria-label={t("picker.selectAll")}
                  />
                </TableHead>
                <TableHead pin={PIN_FIRST}>{t("picker.columns.name")}</TableHead>
                <TableHead className="hidden sm:table-cell">{t("picker.columns.kind")}</TableHead>
                <TableHead>{t("picker.columns.job")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                    {onlySelected ? t("picker.noneSelected") : t(`picker.empty.${kind}`)}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => {
                  const other = takenBy(row.job, jobId);
                  const checked = selectedIds.has(row.id);
                  const moved = moveIds.has(row.id);
                  const Icon = row.kind ? MEMBER_KIND_ICON[row.kind] : null;
                  const name = row.name ?? t("scope.unresolved");
                  return (
                    <TableRow key={row.id} data-state={checked ? "selected" : undefined}>
                      <TableCell className="w-10 pl-3">
                        <Checkbox
                          checked={checked}
                          disabled={disabled || (other !== null && !moved && !checked)}
                          onCheckedChange={(next) =>
                            other !== null && next === true
                              ? setMoving(candidateOf(row))
                              : toggle(row, next === true)
                          }
                          aria-label={t("picker.select", { name })}
                        />
                      </TableCell>
                      <TableCell pin={PIN_FIRST} className="max-w-0 min-w-40">
                        <div className="flex min-w-0 items-start gap-2">
                          {Icon ? (
                            <Icon
                              aria-hidden="true"
                              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                            />
                          ) : null}
                          <div className="min-w-0">
                            <span className="block truncate font-medium" title={name}>
                              {name}
                            </span>
                            {row.detail ? (
                              <span
                                className="block truncate text-xs text-muted-foreground"
                                title={row.detail}
                              >
                                {row.detail}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap sm:table-cell">
                        {row.kind ? t(`scope.kindNames.${row.kind}`) : null}
                      </TableCell>
                      <TableCell>
                        {other ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <StatusBadge
                              tone={moved ? "info" : "warning"}
                              icon={moved ? undefined : TriangleAlert}
                            >
                              {moved
                                ? t("picker.moves", { job: other.name })
                                : t("picker.inJob", { job: other.name })}
                            </StatusBadge>
                            {moved ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                disabled={disabled}
                                onClick={() => keepElsewhere(row)}
                              >
                                {t("picker.keepThere")}
                              </Button>
                            ) : (
                              <Button
                                type="button"
                                variant="outline"
                                size="xs"
                                disabled={disabled}
                                aria-label={t("picker.moveHereFor", { name })}
                                onClick={() => setMoving(candidateOf(row))}
                              >
                                {t("picker.moveHere")}
                              </Button>
                            )}
                          </div>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-xs text-muted-foreground" aria-live="polite">
        {onlySelected
          ? t("picker.selectedCount", { count: value.selected.length })
          : total > items.length
            ? t("picker.partial", { shown: items.length, total })
            : t("picker.selectedCount", { count: value.selected.length })}
      </p>

      <ConfirmDialog
        open={moving !== null}
        onOpenChange={(open) => {
          if (!open) setMoving(null);
        }}
        title={t("picker.moveTitle", { name: moving?.name ?? "" })}
        description={<p>{t("picker.moveDescription", { job: moving?.job?.name ?? "" })}</p>}
        confirmLabel={t("picker.moveConfirm")}
        onConfirm={() => {
          if (moving) {
            confirmMove(moving);
          }
          setMoving(null);
        }}
      />
    </div>
  );
}

/** A selected member as the candidate it came from (for the move question). */
function candidateOf(row: SelectedMember): JobCandidate {
  return {
    targetId: row.id,
    kind: row.kind ?? "mailbox",
    name: row.name ?? "",
    detail: row.detail,
    status: "active",
    job: row.job,
  };
}
