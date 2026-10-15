import { ChevronRight, Folder, FolderOpen, Loader2 } from "lucide-react";
import * as React from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { FailureExplanation } from "@/features/failures";
import { cn } from "@/lib/utils";

import { useShareFormat, useShareSource } from "../hooks.js";
import { shareErrorKey } from "../presenters.js";

export interface FolderPickerProps {
  shareId: string;
  /** Pick several folders (include folders) or one (a target folder). */
  mode: "many" | "one";
  /** The picked folders, relative to the share root, without slashes at either end. */
  value: readonly string[];
  onChange: (next: string[]) => void;
  className?: string;
}

function join(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/**
 * A live browser of the share's folders (docs/FILESHARES.md 12.5, 12.6): one level at a time,
 * read by the runner from the share as it is now (`GET /file-shares/:id/source`). In `many`
 * mode every folder has a box (a ticked folder includes everything below it); in `one` mode a
 * folder is picked with "Use this folder", the root included.
 */
export function FolderPicker({ shareId, mode, value, onChange, className }: FolderPickerProps) {
  const format = useShareFormat();
  const { t } = format;
  const [path, setPath] = React.useState("");
  const listing = useShareSource(shareId, path);
  const segments = path ? path.split("/") : [];
  const folders = (listing.data?.entries ?? []).filter(
    (entry) => entry.type === "dir" && entry.invalidName !== true,
  );
  const toggle = (folder: string) => {
    if (value.includes(folder)) {
      onChange(value.filter((item) => item !== folder));
    } else {
      // A folder below a ticked one is covered already; a ticked parent replaces its children.
      onChange([...value.filter((item) => !item.startsWith(`${folder}/`)), folder]);
    }
  };
  const covered = (folder: string) => value.some((item) => folder.startsWith(`${item}/`));

  return (
    <div className={cn("rounded-md border", className)} data-slot="folder-picker">
      <nav
        aria-label={t("picker.path")}
        className="flex flex-wrap items-center gap-0.5 border-b px-2 py-1.5 text-sm"
      >
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          onClick={() => setPath("")}
          type="button"
        >
          <FolderOpen aria-hidden="true" />
          {t("picker.root")}
        </Button>
        {segments.map((segment, index) => {
          const target = segments.slice(0, index + 1).join("/");
          return (
            <span key={target} className="flex items-center gap-0.5">
              <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                type="button"
                onClick={() => setPath(target)}
              >
                {segment}
              </Button>
            </span>
          );
        })}
      </nav>
      {listing.isPending ? (
        <div className="space-y-2 p-3" aria-busy="true">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-full" />
        </div>
      ) : listing.isError ? (
        <Alert variant="destructive" className="m-3 w-auto">
          <AlertDescription>{t(shareErrorKey(listing.error))}</AlertDescription>
        </Alert>
      ) : listing.data && !listing.data.ok ? (
        <div className="p-3">
          <FailureExplanation
            failure={listing.data.failure}
            message={listing.data.detail}
            subject={{ kind: "none" }}
            fileShareId={shareId}
          />
        </div>
      ) : (
        <ul className="max-h-64 divide-y overflow-y-auto" data-slot="folder-list">
          {mode === "one" ? (
            <li className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
              <span className="text-muted-foreground">
                {path ? t("picker.thisFolder", { path }) : t("picker.rootFolder")}
              </span>
              <Button
                type="button"
                size="sm"
                variant={value[0] === path ? "secondary" : "outline"}
                onClick={() => onChange([path])}
                data-action="use-folder"
              >
                {value[0] === path ? t("picker.chosen") : t("picker.use")}
              </Button>
            </li>
          ) : null}
          {folders.length === 0 ? (
            <li className="px-3 py-3 text-sm text-muted-foreground">{t("picker.noFolders")}</li>
          ) : (
            folders.map((entry) => {
              const full = join(path, entry.name);
              const isCovered = covered(full);
              return (
                <li key={full} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                  {mode === "many" ? (
                    <Checkbox
                      checked={value.includes(full) || isCovered}
                      disabled={isCovered}
                      onCheckedChange={() => toggle(full)}
                      aria-label={t("picker.include", { name: entry.name })}
                    />
                  ) : null}
                  <Folder className="size-4 text-primary" aria-hidden="true" />
                  <button
                    type="button"
                    className="truncate text-left hover:underline"
                    onClick={() => setPath(full)}
                    title={full}
                  >
                    {entry.name}
                  </button>
                </li>
              );
            })
          )}
          {listing.data?.truncated ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">{t("picker.truncated")}</li>
          ) : null}
        </ul>
      )}
      {listing.isFetching && !listing.isPending ? (
        <p className="flex items-center gap-1 px-3 py-1 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          {t("picker.reading")}
        </p>
      ) : null}
    </div>
  );
}
