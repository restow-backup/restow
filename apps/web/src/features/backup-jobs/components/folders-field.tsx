import { FolderTree as FolderTreeIcon, Plus, X } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { messageId } from "@/components/forms/field";
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
import { Skeleton } from "@/components/ui/skeleton";
import { useEndpoint, useSnapshots } from "@/features/endpoints/hooks";
import { formatDateTime } from "@/lib/format";

import { LIMITS } from "../api.js";
import { addFolder, normalizePath, pathProblem, removeFolder, toggleFolder } from "../folders.js";
import { FolderTree } from "./folder-tree.js";

export interface BrowsableMachine {
  id: string;
  /** Null until the list that knows the name has loaded. */
  name: string | null;
}

export interface FoldersFieldProps {
  idPrefix: string;
  paths: readonly string[];
  onChange: (paths: string[]) => void;
  /** The machines whose backups the tree can read: the ones in the scope. */
  machines: readonly BrowsableMachine[];
  /** What is wrong with the folders (the checks or the server), shown under the field. */
  error?: string;
  disabled?: boolean;
}

/**
 * The folders a machine job backs up: a tree to tick (from the newest backup of
 * a machine of the scope), a field to type a path into, and the chosen folders as
 * chips that can be taken out again. Typing is always possible.
 */
export function FoldersField({
  idPrefix,
  paths,
  onChange,
  machines,
  error,
  disabled = false,
}: FoldersFieldProps) {
  const { t } = useTranslation("backupjobs");
  const [typed, setTyped] = React.useState("");
  const [typedProblem, setTypedProblem] = React.useState<string | null>(null);
  const [browsing, setBrowsing] = React.useState(false);
  const inputId = `${idPrefix}-path`;
  const panelId = `${idPrefix}-browser`;

  const add = () => {
    const text = typed.trim();
    if (text === "") {
      return;
    }
    const problem = pathProblem(text);
    if (problem) {
      setTypedProblem(t(`problems.form.paths.${problem}`, { value: text, max: LIMITS.pathLength }));
      return;
    }
    if (paths.length >= LIMITS.paths && !paths.includes(normalizePath(text))) {
      setTypedProblem(t("problems.form.paths.tooMany", { max: LIMITS.paths }));
      return;
    }
    onChange(addFolder(paths, text));
    setTyped("");
    setTypedProblem(null);
  };

  const message = error ?? typedProblem;
  return (
    <div className="space-y-3" data-slot="folders-field">
      <div className="space-y-1.5">
        <Label htmlFor={inputId}>{t("folders.label")}</Label>
        {paths.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" aria-label={t("folders.chosen")}>
            {paths.map((path) => (
              <li
                key={path}
                className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/40 py-0.5 pr-0.5 pl-2 font-mono text-xs"
              >
                <span className="min-w-0 break-all" title={path}>
                  {path}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  disabled={disabled}
                  aria-label={t("folders.remove", { path })}
                  onClick={() => onChange(removeFolder(paths, path))}
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("folders.none")}</p>
        )}
      </div>

      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-48 flex-1">
          <Input
            id={inputId}
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value);
              setTypedProblem(null);
            }}
            onKeyDown={(event) => {
              // Enter adds the path; it must not save the whole form.
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
            disabled={disabled}
            placeholder={t("folders.typePlaceholder")}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-sm"
            aria-invalid={Boolean(message) || undefined}
            aria-describedby={messageId(inputId)}
          />
        </div>
        <Button type="button" variant="outline" disabled={disabled} onClick={add}>
          <Plus aria-hidden="true" />
          {t("folders.add")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          aria-expanded={browsing}
          aria-controls={panelId}
          onClick={() => setBrowsing((open) => !open)}
        >
          <FolderTreeIcon aria-hidden="true" />
          {browsing ? t("folders.hideTree") : t("folders.showTree")}
        </Button>
      </div>
      <p
        id={messageId(inputId)}
        role={message ? "alert" : undefined}
        className={message ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
      >
        {message ?? t("folders.hint")}
      </p>

      <div id={panelId} hidden={!browsing}>
        {browsing ? (
          <FolderBrowser
            idPrefix={idPrefix}
            machines={machines}
            paths={paths}
            onToggle={(path) => onChange(toggleFolder(paths, path))}
            disabled={disabled}
          />
        ) : null}
      </div>
    </div>
  );
}

interface FolderBrowserProps {
  idPrefix: string;
  machines: readonly BrowsableMachine[];
  paths: readonly string[];
  onToggle: (path: string) => void;
  disabled: boolean;
}

/** The tree with the choice of the machine it reads and a line that says where the folders come from. */
function FolderBrowser({ idPrefix, machines, paths, onToggle, disabled }: FolderBrowserProps) {
  const { t, i18n } = useTranslation("backupjobs");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const [chosen, setChosen] = React.useState<string | null>(null);
  // The machine the person picked, else the first one of the scope (the list may change under the picker).
  const machine = machines.find((candidate) => candidate.id === chosen) ?? machines[0] ?? null;
  const machineId = machine?.id ?? "";
  const machineName = machine?.name ?? t("scope.unresolved");
  const snapshots = useSnapshots(machineId, machine !== null);
  const latest = snapshots.data
    ? [...snapshots.data].sort((a, b) => Date.parse(b.time) - Date.parse(a.time))[0]
    : undefined;
  const withoutBackup = snapshots.isSuccess && latest === undefined;
  const detail = useEndpoint(machineId, machine !== null && withoutBackup);
  const selectId = `${idPrefix}-machine`;

  if (machine === null) {
    return (
      <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
        {t("folders.noMachine")}
      </p>
    );
  }

  let body: React.ReactNode;
  if (snapshots.isPending || (withoutBackup && detail.isPending)) {
    body = (
      <div aria-busy="true" className="space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-2/3" />
      </div>
    );
  } else if (snapshots.isError) {
    body = (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span role="alert" className="text-destructive-text">
          {t("folders.snapshotsError")}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={() => void snapshots.refetch()}>
          {t("folders.tree.retry")}
        </Button>
      </div>
    );
  } else {
    body = (
      <>
        <p className="text-xs text-muted-foreground" data-slot="folder-source">
          {latest
            ? t("folders.source.backup", {
                machine: machineName,
                time: formatDateTime(latest.time, language) ?? latest.time,
              })
            : t("folders.source.none", { machine: machineName })}{" "}
          {t("folders.tree.keys")}
        </p>
        <FolderTree
          key={`${machineId}:${latest?.id ?? "none"}`}
          machineId={machineId}
          snapshotId={latest?.id ?? null}
          roots={detail.data?.config.paths ?? []}
          selected={paths}
          onToggle={disabled ? () => undefined : onToggle}
          label={t("folders.tree.label", { machine: machineName })}
        />
      </>
    );
  }

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-3" data-slot="folder-browser">
      {machines.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={selectId} className="text-sm">
            {t("folders.machine")}
          </Label>
          <Select value={machineId} onValueChange={setChosen}>
            <SelectTrigger id={selectId} className="w-full sm:w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {machines.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.name ?? t("scope.unresolved")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {body}
    </div>
  );
}
