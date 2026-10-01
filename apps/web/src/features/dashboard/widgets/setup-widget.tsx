import {
  ChevronDown,
  Circle,
  CircleCheck,
  ClipboardCheck,
  type LucideIcon,
  TriangleAlert,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { StatusBadge } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

import type { SetupWidget as SetupData, SetupItem } from "../api.js";
import { LinkButton } from "../components/link-button.js";
import { WidgetCard, type WidgetStateProps } from "../components/widget-frame.js";
import { SETUP_ITEM_PATH, to } from "../paths.js";

const STATE_ICON: Readonly<Record<SetupItem["state"], LucideIcon>> = {
  done: CircleCheck,
  open: Circle,
  attention: TriangleAlert,
};

// A step that is done is in order, not proven: the check mark takes the text colour, never green.
const STATE_CLASS: Readonly<Record<SetupItem["state"], string>> = {
  done: "text-foreground",
  open: "text-muted-foreground",
  attention: "text-warning-text",
};

function SetupSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-2 w-full" />
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex items-center gap-3">
          <Skeleton className="size-4 rounded-full" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ))}
    </div>
  );
}

/** A step that is still open or needs attention: why, and the way to it. */
function PendingStep({ item }: { item: SetupItem }) {
  const { t } = useTranslation("dashboard");
  const Icon = STATE_ICON[item.state];
  const hint = item.reason
    ? t(`setup.reasons.${item.reason}`, { defaultValue: "" })
    : t(`setup.items.${item.id}.hint`);

  return (
    <li
      data-item={item.id}
      data-state={item.state}
      className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-start gap-3">
        <Icon
          className={cn("mt-0.5 size-4 shrink-0", STATE_CLASS[item.state])}
          aria-hidden="true"
        />
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">
            {t(`setup.items.${item.id}.label`)}
            <span className="sr-only"> ({t(`setup.state.${item.state}`)})</span>
          </p>
          {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
        </div>
      </div>
      {item.actionable ? (
        <LinkButton to={to(SETUP_ITEM_PATH[item.id])} className="shrink-0 self-start sm:self-auto">
          {t(`setup.items.${item.id}.action`)}
        </LinkButton>
      ) : (
        <StatusBadge tone="muted" className="shrink-0 self-start sm:self-auto">
          {t(item.id === "notificationMail" ? "setup.byProvider" : "setup.byAdmin")}
        </StatusBadge>
      )}
    </li>
  );
}

function SetupList({ data }: { data: SetupData }) {
  const { t, i18n } = useTranslation("dashboard");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const share = data.total === 0 ? 0 : data.done / data.total;
  const progress = t("setup.progress", { done: data.done, total: data.total });
  const pending = data.items.filter((item) => item.state !== "done");
  const done = data.items.filter((item) => item.state === "done");
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{progress}</span>
          <span className="font-medium tabular-nums">{formatPercent(share, language)}</span>
        </div>
        <Progress value={Math.round(share * 100)} aria-label={progress} />
      </div>
      {pending.length > 0 ? (
        <ul className="divide-y">
          {pending.map((item) => (
            <PendingStep key={item.id} item={item} />
          ))}
        </ul>
      ) : null}
      {done.length > 0 ? (
        <ul
          aria-label={t("setup.doneSteps")}
          className="flex flex-wrap gap-x-5 gap-y-2 border-t pt-3 text-sm text-muted-foreground"
        >
          {done.map((item) => (
            <li
              key={item.id}
              data-item={item.id}
              data-state="done"
              className="flex items-center gap-1.5"
            >
              <CircleCheck className="size-4 shrink-0 text-foreground" aria-hidden="true" />
              {t(`setup.items.${item.id}.label`)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Collapsed once every step is done: one line that confirms it, with the
 * list one click away.
 */
function CompleteSetup({ data }: { data: SetupData }) {
  const { t } = useTranslation("dashboard");
  const [open, setOpen] = React.useState(false);
  return (
    <Card data-widget="setup" data-state="complete" className="gap-0 py-3">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center justify-between gap-3 px-6">
          <p className="flex items-center gap-2 text-sm">
            <CircleCheck className="size-4 text-foreground" aria-hidden="true" />
            <span className="font-medium">{t("setup.complete.title")}</span>
            <span className="hidden text-muted-foreground sm:inline">
              {t("setup.complete.description", { total: data.total })}
            </span>
          </p>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" aria-expanded={open}>
              {open ? t("setup.complete.hide") : t("setup.complete.show")}
              <ChevronDown
                aria-hidden="true"
                className={cn("transition-transform duration-200", open && "rotate-180")}
              />
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="px-6 pt-4">
          <SetupList data={data} />
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

/**
 * The steps from a fresh tenant to backups proven restorable, judged from the
 * data. Each step links to its page; steps the viewer cannot act on are shown
 * as information.
 */
export function SetupWidget(props: WidgetStateProps<SetupData>) {
  const { t } = useTranslation("dashboard");
  if (props.view.kind === "ready" && props.view.data.complete) {
    return <CompleteSetup data={props.view.data} />;
  }
  return (
    <WidgetCard
      id="setup"
      {...props}
      title={t("setup.title")}
      description={t("setup.description")}
      icon={ClipboardCheck}
      skeleton={<SetupSkeleton />}
    >
      {(data) => <SetupList data={data} />}
    </WidgetCard>
  );
}
