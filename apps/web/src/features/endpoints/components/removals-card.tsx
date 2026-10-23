import { Link } from "@tanstack/react-router";
import { FolderOpen, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes, formatDateTime } from "@/lib/format";

import type { EndpointRemoval } from "../api.js";
import { useRemovals } from "../hooks.js";
import { fileRestoreTo } from "../paths.js";

/** The sentence that says where a removal stands and when its backups go. */
export function removalStateKey(removal: EndpointRemoval): {
  key: string;
  date: string | null;
} {
  switch (removal.state) {
    case "held":
      return {
        key: removal.heldBy === "suspicion" ? "removals.held.suspicion" : "removals.held.legal",
        date: null,
      };
    case "deferred":
      return removal.lockedUntil
        ? { key: "removals.deferred", date: removal.lockedUntil }
        : { key: "removals.deferredUnknown", date: null };
    default:
      return removal.mode === "expire" && removal.expiresAt
        ? { key: "removals.expires", date: removal.expiresAt }
        : { key: "removals.deleting", date: null };
  }
}

/**
 * Removed machines whose backups are still stored (#65): they are in no other list, so this is
 * where an admin sees when their backups go, and what holds or locks them. Shown only while there
 * is one, and only to who may remove machines.
 */
export function RemovalsCard({ canRemove }: { canRemove: boolean }) {
  const { t, i18n } = useTranslation("endpoints");
  const removals = useRemovals(canRemove);
  const items = removals.data ?? [];
  if (!canRemove || items.length === 0) {
    return null;
  }
  return (
    <Card data-slot="removals">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Trash2 aria-hidden="true" className="size-4" />
          {t("removals.title", { count: items.length })}
        </CardTitle>
        <CardDescription>{t("removals.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y text-sm">
          {items.map((removal) => {
            const state = removalStateKey(removal);
            const name = removal.displayName?.trim() || removal.hostname;
            return (
              <li
                key={removal.id}
                className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="min-w-0 break-words font-medium">{name}</span>
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-muted-foreground">
                    {t(state.key, {
                      date: state.date ? formatDateTime(state.date, i18n.language) : "",
                    })}
                    {removal.repositoryBytes
                      ? ` · ${formatBytes(removal.repositoryBytes, i18n.language)}`
                      : ""}
                  </span>
                  <Link
                    {...fileRestoreTo(removal.id)}
                    search={fileRestoreTo(removal.id).search as never}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                    aria-label={t("removals.restoreFilesFor", { name })}
                    data-slot="removal-restore"
                  >
                    <FolderOpen aria-hidden="true" />
                    {t("removals.restoreFiles")}
                  </Link>
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
