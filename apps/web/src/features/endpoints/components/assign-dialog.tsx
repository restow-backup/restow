import { Check, Search, UserRound, UserX } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
import { useDebouncedValue, usePeopleSearch } from "@/features/directory/hooks";
import type { DirectoryPerson } from "@/features/directory/types";
import { useTenantWriteBlock } from "@/features/tenant-page/access";
import { cn } from "@/lib/utils";

import type { EndpointAssignee, EndpointSummary } from "../api.js";
import { useAssignEndpoint } from "../hooks.js";
import { assigneeName, endpointErrorKey } from "../presenters.js";

/** A machine as the assignment dialog needs it. */
export interface AssignTarget {
  id: string;
  name: string;
  assignedTo: EndpointAssignee | null;
}

/**
 * Whether the viewer may assign machines: closed in the public demo and for a provider role below
 * Administrator (the tenant page's rule), with the sentence that says why.
 */
export function useAssignAccess(): { closed: boolean; reason: string | undefined } {
  const { t } = useTranslation("endpoints");
  const block = useTenantWriteBlock();
  return { closed: block !== null, reason: block ? t(`assign.blocked.${block}`) : undefined };
}

/**
 * The person a machine is assigned to with the button that changes it (the facts of the machine's
 * overview and its settings). Closed for a revoked machine and where the viewer may not change it,
 * with the reason as the button's description.
 */
export function AssignmentField({
  endpoint,
  name,
}: {
  endpoint: Pick<EndpointSummary, "id" | "status" | "assignedTo">;
  name: string;
}) {
  const { t } = useTranslation("endpoints");
  const access = useAssignAccess();
  const [open, setOpen] = React.useState(false);
  const reasonId = React.useId();
  const person = endpoint.assignedTo ?? null;
  const revoked = endpoint.status === "revoked";
  const reason = revoked ? t("list.rowActions.revoked") : access.reason;
  const closed = revoked || access.closed;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1" data-slot="assignment">
      {person ? (
        <span className="min-w-0">
          <span className="font-medium">{assigneeName(person)}</span>
          {person.displayName ? (
            <span className="text-muted-foreground"> · {person.email}</span>
          ) : null}
        </span>
      ) : (
        <span className="text-muted-foreground">{t("facts.assignedNobody")}</span>
      )}
      <Button
        variant="link"
        size="sm"
        className="h-auto p-0"
        onClick={() => setOpen(true)}
        disabled={closed}
        aria-describedby={closed && reason ? reasonId : undefined}
        title={closed ? reason : undefined}
      >
        {person ? t("assign.change") : t("assign.action")}
      </Button>
      {closed && reason ? (
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      ) : null}
      {open ? (
        <AssignDialog
          open
          onOpenChange={setOpen}
          target={{ id: endpoint.id, name, assignedTo: person }}
        />
      ) : null}
    </span>
  );
}

/**
 * Assign a machine to a person of the tenant's protection directory (the people synced from
 * Microsoft 365 or added by hand, not the accounts that sign in here), or remove the assignment.
 * The search asks the server; choosing a person saves at once.
 */
export function AssignDialog({
  open,
  onOpenChange,
  target,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: AssignTarget;
}) {
  const { t } = useTranslation("endpoints");
  const [text, setText] = React.useState("");
  const search = useDebouncedValue(text.trim(), 250);
  const people = usePeopleSearch(search, open);
  const assign = useAssignEndpoint();
  const listId = React.useId();
  const current = target.assignedTo;

  const save = (person: DirectoryPerson | null) => {
    assign.mutate(
      { endpointId: target.id, userId: person?.id ?? null },
      {
        onSuccess: () => {
          toast.success(
            person
              ? t("assign.toast.assigned", { name: target.name, person: assigneeName(person) })
              : t("assign.toast.removed", { name: target.name }),
          );
          onOpenChange(false);
        },
      },
    );
  };

  const results = people.data?.items ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-slot="assign-dialog">
        <DialogHeader>
          <DialogTitle>{t("assign.title", { name: target.name })}</DialogTitle>
          <DialogDescription>{t("assign.description")}</DialogDescription>
        </DialogHeader>

        {current ? (
          <div className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div className="flex min-w-0 items-center gap-3">
              <UserRound className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{t("assign.current")}</p>
                <p className="truncate text-sm font-medium">{assigneeName(current)}</p>
                {current.displayName ? (
                  <p className="truncate text-xs text-muted-foreground">{current.email}</p>
                ) : null}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => save(null)}
              disabled={assign.isPending}
              data-action="unassign"
            >
              <UserX aria-hidden="true" />
              {t("assign.remove")}
            </Button>
          </div>
        ) : null}

        <div className="space-y-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={t("assign.search")}
              aria-label={t("assign.search")}
              aria-controls={listId}
              className="pl-9"
              autoComplete="off"
              autoFocus
            />
          </div>
          <div
            id={listId}
            className="max-h-64 overflow-y-auto rounded-md border"
            aria-busy={people.isFetching || undefined}
            data-slot="assign-people"
          >
            {people.isError ? (
              <Alert variant="destructive" className="rounded-none border-0">
                <AlertDescription>
                  {t("assign.loadError")} {t(endpointErrorKey(people.error))}
                </AlertDescription>
              </Alert>
            ) : people.isPending ? (
              <div className="flex justify-center p-4">
                <Spinner />
              </div>
            ) : results.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">
                {search ? t("assign.noMatch") : t("assign.empty")}
              </p>
            ) : (
              <ul className="divide-y">
                {results.map((person) => {
                  const chosen = current?.id === person.id;
                  return (
                    <li key={person.id}>
                      <button
                        type="button"
                        className={cn(
                          "flex w-full items-center justify-between gap-3 px-3 py-2 text-left outline-none hover:bg-muted/60 focus-visible:bg-muted/60 disabled:opacity-60",
                          chosen && "bg-muted/40",
                        )}
                        onClick={() => save(person)}
                        disabled={assign.isPending || chosen}
                        aria-current={chosen || undefined}
                        data-person={person.id}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">
                            {assigneeName(person)}
                          </span>
                          {person.displayName ? (
                            <span className="block truncate text-xs text-muted-foreground">
                              {person.email}
                            </span>
                          ) : null}
                        </span>
                        {chosen ? (
                          <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {people.data?.more ? (
            <p className="text-xs text-muted-foreground">{t("assign.more")}</p>
          ) : null}
        </div>

        {assign.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{t(endpointErrorKey(assign.error))}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("assign.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
