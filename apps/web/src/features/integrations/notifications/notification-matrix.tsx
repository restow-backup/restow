import { Bell, ChevronDown, Mail, Webhook as WebhookIcon } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import type { MatrixChannel, NotificationMatrix, ReportEvent } from "@/features/reports/api";

import { useNotificationMatrix, useSaveNotificationMatrix } from "../hooks";
import { integrationErrorKey } from "../presenters";
import {
  applyPreset,
  CHANNEL_PRESETS,
  type ChannelPreset,
  changedChannels,
  channelKey,
  channelSubtitle,
  channelTitle,
  draftFrom,
  groupedRows,
  LEVEL_VARIANT,
  type MatrixDraft,
  type MatrixRow,
  presetOf,
  toggleCell,
} from "./matrix-presenters";

/**
 * Integrations › Notifications: one matrix per tenant. The events are the rows, grouped and
 * marked by severity; the channels are the columns (the bell, every webhook, every notification
 * recipient); a cell says whether the channel gets the event. Each column has quick choices
 * (errors only, errors and warnings, everything). Changes stay a draft until saved, so a few
 * clicks become one save.
 *
 * Keyboard: every cell is a checkbox in the tab order, and the arrow keys move between the cells
 * of the matrix like in a grid. On a phone the matrix shows one channel at a time, chosen above
 * the list.
 */
export function NotificationMatrixPanel() {
  const { t } = useTranslation("integrations");
  const matrix = useNotificationMatrix();
  if (matrix.isPending) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (matrix.isError || !matrix.data) {
    return (
      <ErrorState
        title={t("matrix.loadError")}
        error={matrix.error}
        onRetry={() => void matrix.refetch()}
        retrying={matrix.isFetching}
      />
    );
  }
  // Keyed by what the server holds: after a save the draft starts from it.
  return <MatrixEditor key={matrixStamp(matrix.data)} matrix={matrix.data} />;
}

function matrixStamp(matrix: NotificationMatrix): string {
  return matrix.channels
    .map((channel) => `${channelKey(channel)}=${channel.events.join(",")}`)
    .join("|");
}

function MatrixEditor({ matrix }: { matrix: NotificationMatrix }) {
  const { t } = useTranslation("integrations");
  const save = useSaveNotificationMatrix();
  const [draft, setDraft] = React.useState<MatrixDraft>(() => draftFrom(matrix));
  const rows = matrix.events;
  const groups = React.useMemo(() => groupedRows(rows), [rows]);
  const changes = changedChannels(matrix, draft);
  const dirty = changes.length > 0;

  const toggle = (key: string, event: ReportEvent, on: boolean) =>
    setDraft((current) => toggleCell(current, key, event, on, rows));
  const preset = (key: string, choice: ChannelPreset) =>
    setDraft((current) => applyPreset(current, key, choice, rows));

  async function onSave() {
    try {
      await save.mutateAsync({ channels: changes });
      toast.success(t("matrix.saved"));
    } catch (error) {
      toast.error(t(integrationErrorKey(error)));
    }
  }

  return (
    <Card data-slot="notification-matrix">
      <CardHeader>
        <CardTitle className="text-base">{t("matrix.title")}</CardTitle>
        <CardDescription>{t("matrix.description")}</CardDescription>
        <LevelLegend />
      </CardHeader>
      <CardContent className="space-y-4">
        {matrix.channels.length === 1 ? (
          <p className="text-sm text-muted-foreground" data-slot="matrix-only-bell">
            {t("matrix.onlyBell")}
          </p>
        ) : null}
        <PhoneView
          matrix={matrix}
          groups={groups}
          draft={draft}
          rows={rows}
          onToggle={toggle}
          onPreset={preset}
        />
        <GridView
          matrix={matrix}
          groups={groups}
          draft={draft}
          rows={rows}
          onToggle={toggle}
          onPreset={preset}
        />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
          {dirty ? (
            <p className="text-xs text-muted-foreground sm:mr-auto" role="status">
              {t("matrix.unsaved", { count: changes.length })}
            </p>
          ) : null}
          <Button
            type="button"
            variant="outline"
            disabled={!dirty || save.isPending}
            onClick={() => setDraft(draftFrom(matrix))}
          >
            {t("matrix.discard")}
          </Button>
          <Button
            type="button"
            disabled={!dirty}
            loading={save.isPending}
            onClick={() => void onSave()}
          >
            {t("matrix.save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function LevelLegend() {
  const { t } = useTranslation("integrations");
  return (
    <ul className="flex flex-wrap gap-2 pt-1" aria-label={t("matrix.legend")}>
      {(["error", "warning", "info"] as const).map((level) => (
        <li key={level}>
          <Badge variant={LEVEL_VARIANT[level]}>{t(`matrix.levels.${level}`)}</Badge>
        </li>
      ))}
    </ul>
  );
}

interface ViewProps {
  matrix: NotificationMatrix;
  groups: { group: string; rows: MatrixRow[] }[];
  draft: MatrixDraft;
  rows: readonly MatrixRow[];
  onToggle: (key: string, event: ReportEvent, on: boolean) => void;
  onPreset: (key: string, preset: ChannelPreset) => void;
}

function ChannelIcon({ channel }: { channel: MatrixChannel }) {
  const Icon = channel.kind === "bell" ? Bell : channel.kind === "webhook" ? WebhookIcon : Mail;
  return <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />;
}

/** The quick choices of one column, with the one it matches marked. */
function PresetMenu({
  channel,
  events,
  rows,
  onPreset,
}: {
  channel: MatrixChannel;
  events: readonly ReportEvent[];
  rows: readonly MatrixRow[];
  onPreset: (preset: ChannelPreset) => void;
}) {
  const { t } = useTranslation("integrations");
  const current = presetOf(events, rows);
  const title = channelTitle(channel, t);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs font-normal"
          aria-label={t("matrix.presetFor", { channel: title })}
        >
          {current ? t(`matrix.presets.${current}`) : t("matrix.presets.custom")}
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel className="text-xs">{title}</DropdownMenuLabel>
        {CHANNEL_PRESETS.map((preset) => (
          <DropdownMenuItem key={preset} onSelect={() => onPreset(preset)}>
            {t(`matrix.presets.${preset}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EventLabel({ row }: { row: MatrixRow }) {
  const { t } = useTranslation("integrations");
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-sm" title={t(`reports:eventHints.${row.name}`)}>
        {t(`reports:events.${row.name}`)}
      </span>
      <Badge variant={LEVEL_VARIANT[row.level]} className="text-[11px]">
        {t(`matrix.levels.${row.level}`)}
      </Badge>
    </span>
  );
}

/** Arrow keys move between the cells of the grid (row and column from the cell's data). */
function moveFocus(event: React.KeyboardEvent<HTMLElement>) {
  const moves: Record<string, [number, number]> = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1],
  };
  const move = moves[event.key];
  const cell = event.currentTarget;
  if (!move) return;
  const row = Number(cell.dataset.row) + move[0];
  const column = Number(cell.dataset.column) + move[1];
  const grid = cell.closest("[data-slot=matrix-grid]");
  const next = grid?.querySelector<HTMLElement>(`[data-row="${row}"][data-column="${column}"]`);
  if (next) {
    event.preventDefault();
    next.focus();
  }
}

/** Wider screens: the whole matrix, events down, channels across. */
function GridView({ matrix, groups, draft, rows, onToggle, onPreset }: ViewProps) {
  const { t } = useTranslation("integrations");
  let index = -1;
  return (
    <div className="hidden overflow-x-auto sm:block" data-slot="matrix-grid">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{t("matrix.caption")}</caption>
        <thead>
          <tr className="border-b">
            <th scope="col" className="py-2 pr-4 text-left align-bottom font-medium">
              {t("matrix.event")}
            </th>
            {matrix.channels.map((channel) => {
              const key = channelKey(channel);
              return (
                <th
                  key={key}
                  scope="col"
                  className="min-w-32 px-2 py-2 text-left align-bottom font-normal"
                  data-slot="matrix-channel"
                >
                  <span className="flex items-center gap-1.5 font-medium">
                    <ChannelIcon channel={channel} />
                    <span className="max-w-40 truncate" title={channelTitle(channel, t)}>
                      {channelTitle(channel, t)}
                    </span>
                  </span>
                  <span className="block max-w-40 truncate text-xs text-muted-foreground">
                    {channelSubtitle(channel, t)}
                    {channel.kind === "webhook" && !channel.active
                      ? ` · ${t("matrix.paused")}`
                      : null}
                  </span>
                  <PresetMenu
                    channel={channel}
                    events={draft[key] ?? []}
                    rows={rows}
                    onPreset={(preset) => onPreset(key, preset)}
                  />
                </th>
              );
            })}
          </tr>
        </thead>
        {groups.map(({ group, rows: groupRows }) => (
          <tbody key={group}>
            <tr>
              <th
                scope="colgroup"
                colSpan={matrix.channels.length + 1}
                className="pt-4 pb-1 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase"
              >
                {t(`reports:eventGroups.${group}`)}
              </th>
            </tr>
            {groupRows.map((row) => {
              index += 1;
              const rowIndex = index;
              return (
                <tr key={row.name} className="border-b border-border/60 hover:bg-muted/40">
                  <th scope="row" className="py-2 pr-4 text-left font-normal">
                    <EventLabel row={row} />
                  </th>
                  {matrix.channels.map((channel, column) => {
                    const key = channelKey(channel);
                    const on = (draft[key] ?? []).includes(row.name);
                    return (
                      <td key={key} className="px-2 py-2">
                        <Checkbox
                          checked={on}
                          onCheckedChange={(checked) => onToggle(key, row.name, checked === true)}
                          onKeyDown={moveFocus}
                          data-row={rowIndex}
                          data-column={column}
                          aria-label={t("matrix.cell", {
                            event: t(`reports:events.${row.name}`),
                            channel: channelTitle(channel, t),
                          })}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
    </div>
  );
}

/** A phone: one channel at a time, its events as a list. */
function PhoneView({ matrix, groups, draft, rows, onToggle, onPreset }: ViewProps) {
  const { t } = useTranslation("integrations");
  const [selected, setSelected] = React.useState(() =>
    channelKey(matrix.channels[0] ?? { kind: "bell", id: "bell" }),
  );
  const channel =
    matrix.channels.find((candidate) => channelKey(candidate) === selected) ?? matrix.channels[0];
  if (!channel) return null;
  const key = channelKey(channel);
  const events = draft[key] ?? [];
  const current = presetOf(events, rows);
  return (
    <div className="space-y-4 sm:hidden" data-slot="matrix-phone">
      <div className="space-y-1.5">
        <label htmlFor="matrix-channel" className="text-sm font-medium">
          {t("matrix.channel")}
        </label>
        <Select value={key} onValueChange={setSelected}>
          <SelectTrigger id="matrix-channel" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {matrix.channels.map((candidate) => (
              <SelectItem key={channelKey(candidate)} value={channelKey(candidate)}>
                {channelTitle(candidate, t)} · {channelSubtitle(candidate, t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <fieldset className="flex flex-wrap gap-2">
        <legend className="sr-only">{t("matrix.presetsLabel")}</legend>
        {CHANNEL_PRESETS.map((preset) => (
          <Button
            key={preset}
            type="button"
            size="sm"
            variant={current === preset ? "secondary" : "outline"}
            aria-pressed={current === preset}
            onClick={() => onPreset(key, preset)}
          >
            {t(`matrix.presets.${preset}`)}
          </Button>
        ))}
      </fieldset>
      {groups.map(({ group, rows: groupRows }) => (
        <fieldset key={group} className="space-y-2">
          <legend className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t(`reports:eventGroups.${group}`)}
          </legend>
          <ul className="space-y-2">
            {groupRows.map((row) => {
              const id = `matrix-phone-${row.name.replace(".", "-")}`;
              return (
                <li key={row.name} className="flex items-start gap-2.5">
                  <Checkbox
                    id={id}
                    className="mt-0.5"
                    checked={events.includes(row.name)}
                    onCheckedChange={(checked) => onToggle(key, row.name, checked === true)}
                  />
                  <label htmlFor={id} className="cursor-pointer">
                    <EventLabel row={row} />
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      ))}
    </div>
  );
}
