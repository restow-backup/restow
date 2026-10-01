import { Info } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { messageId } from "@/components/forms/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { errorMessageKey } from "@/lib/api";
import { cn } from "@/lib/utils";

import { GroupPicker, type PickedGroup } from "./group-picker";
import { useSaveRules } from "./hooks";
import {
  formatExclusionText,
  parseExclusionText,
  rulesComplete,
  sameRules,
  syncResultKey,
} from "./presenters";
import { Textarea } from "./textarea";
import type { DirectorySource, ProtectionRules } from "./types";

const DEFAULT_RULES: ProtectionRules = {
  mode: "all",
  groupId: null,
  groupName: null,
  exclude: [],
  includeSharedMailboxes: true,
};

interface RulesSheetProps {
  source: DirectorySource;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Edit the protection rules of one Microsoft 365 source. */
export function RulesSheet({ source, open, onOpenChange }: RulesSheetProps) {
  const { t } = useTranslation("directory");
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="border-b border-border p-6 pr-12">
          <SheetTitle className="text-lg">{t("rules.title")}</SheetTitle>
          <SheetDescription>{t("rules.description", { source: source.name })}</SheetDescription>
        </SheetHeader>
        {open ? <RulesForm source={source} onDone={() => onOpenChange(false)} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function RulesForm({ source, onDone }: { source: DirectorySource; onDone: () => void }) {
  const { t } = useTranslation("directory");
  const { t: tc } = useTranslation();
  const saved = source.rules ?? DEFAULT_RULES;
  const save = useSaveRules();

  const [mode, setMode] = React.useState(saved.mode);
  const [group, setGroup] = React.useState<PickedGroup | null>(
    saved.groupId ? { id: saved.groupId, name: saved.groupName } : null,
  );
  const [includeShared, setIncludeShared] = React.useState(saved.includeSharedMailboxes);
  const [excludeText, setExcludeText] = React.useState(formatExclusionText(saved.exclude));
  const [attempted, setAttempted] = React.useState(false);

  const draft: ProtectionRules = {
    mode,
    groupId: mode === "group" ? (group?.id ?? null) : null,
    groupName: mode === "group" ? (group?.name ?? null) : null,
    exclude: parseExclusionText(excludeText),
    includeSharedMailboxes: includeShared,
  };
  const complete = rulesComplete(draft);
  const changed = !sameRules(draft, saved) || draft.groupName !== saved.groupName;
  const groupInvalid = attempted && !complete;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (!complete) {
      return;
    }
    try {
      const result = await save.mutateAsync({ sourceId: source.id, rules: draft });
      toast.success(t("rules.saved"), { description: t(syncResultKey(result.sync)) });
      onDone();
    } catch (error) {
      toast.error(t("rules.failed"), { description: tc(errorMessageKey(error)) });
    }
  };

  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => void submit(event)}>
      <div className="flex-1 space-y-6 overflow-y-auto p-6">
        <fieldset className="space-y-3">
          <legend className="mb-3 text-sm font-medium">{t("rules.mode.label")}</legend>
          <ModeOption
            value="all"
            checked={mode === "all"}
            onSelect={setMode}
            title={t("rules.mode.all")}
            hint={t("rules.mode.allHint")}
          />
          <ModeOption
            value="group"
            checked={mode === "group"}
            onSelect={setMode}
            title={t("rules.mode.group")}
            hint={t("rules.mode.groupHint")}
          />
          <ModeOption
            value="selected"
            checked={mode === "selected"}
            onSelect={setMode}
            title={t("rules.mode.selected")}
            hint={t("rules.mode.selectedHint")}
          />
        </fieldset>

        {mode === "selected" ? (
          <Alert variant="info">
            <Info />
            <AlertDescription>{t("rules.selectedHint")}</AlertDescription>
          </Alert>
        ) : null}

        {mode === "group" ? (
          <div className="space-y-1.5">
            <Label htmlFor="rules-group">{t("rules.group.label")}</Label>
            <GroupPicker
              id="rules-group"
              sourceId={source.id}
              value={group}
              onChange={setGroup}
              invalid={groupInvalid}
              describedBy={groupInvalid ? messageId("rules-group") : undefined}
            />
            {groupInvalid ? (
              <p id={messageId("rules-group")} role="alert" className="text-xs text-destructive">
                {t("rules.group.required")}
              </p>
            ) : null}
          </div>
        ) : null}

        {mode === "selected" ? null : (
          <>
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <Label htmlFor="rules-shared">{t("rules.shared.label")}</Label>
                <p id={messageId("rules-shared")} className="text-xs text-muted-foreground">
                  {t("rules.shared.hint")}
                </p>
              </div>
              <Switch
                id="rules-shared"
                checked={includeShared}
                onCheckedChange={setIncludeShared}
                aria-describedby={messageId("rules-shared")}
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <Label htmlFor="rules-exclude">{t("rules.exclude.label")}</Label>
                <span className="text-xs text-muted-foreground">
                  {t("rules.exclude.count", { count: draft.exclude.length })}
                </span>
              </div>
              <Textarea
                id="rules-exclude"
                value={excludeText}
                onChange={(event) => setExcludeText(event.target.value)}
                placeholder={t("rules.exclude.placeholder")}
                aria-describedby={messageId("rules-exclude")}
                rows={6}
                spellCheck={false}
                className="font-mono text-xs"
              />
              <p id={messageId("rules-exclude")} className="text-xs text-muted-foreground">
                {t("rules.exclude.hint")}
              </p>
            </div>
          </>
        )}

        <Alert variant="info">
          <Info />
          <AlertDescription>{t("rules.precedence")}</AlertDescription>
        </Alert>
      </div>

      <div className="flex flex-col-reverse gap-2 border-t border-border p-6 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={onDone} disabled={save.isPending}>
          {tc("actions.cancel")}
        </Button>
        <Button type="submit" loading={save.isPending} disabled={!changed}>
          {t("rules.save")}
        </Button>
      </div>
    </form>
  );
}

function ModeOption({
  value,
  checked,
  onSelect,
  title,
  hint,
}: {
  value: ProtectionRules["mode"];
  checked: boolean;
  onSelect: (mode: ProtectionRules["mode"]) => void;
  title: string;
  hint: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors",
        checked ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50",
      )}
    >
      <input
        type="radio"
        name="rules-mode"
        value={value}
        checked={checked}
        onChange={() => onSelect(value)}
        className="mt-1 size-4 accent-primary"
      />
      <span className="space-y-0.5">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}
