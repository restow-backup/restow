import { TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { ConfirmDialog } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessageKey } from "@/lib/api";
import { formatBytes, formatInteger } from "@/lib/format";

import type { RetentionPolicy, RetentionPreset, RetentionPreviewRequest } from "../api.js";
import {
  useCreateRetentionPolicy,
  useRetentionPreview,
  useUpdateRetentionPolicy,
} from "../hooks.js";
import {
  type DraftField,
  PRESET_ORDER,
  type RetentionDraft,
  type ScopeMode,
  checkDraft,
  draftFromPolicy,
  fieldProblem,
  inputFromDraft,
  isStricterChange,
  newDraft,
  patchFromDraft,
  previewInputFromDraft,
} from "../presenters.js";
import { ObjectPicker } from "./object-picker.js";
import { TierEditor } from "./tier-editor.js";

export interface PolicySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The policy to edit; null creates a new one. */
  policy: RetentionPolicy | null;
  /** The recommended default rule, offered as the starting preset for a new policy. */
  recommendedPreset: RetentionPreset;
  onSaved: (change: "created" | "updated", item: RetentionPolicy) => void;
}

/** Create or edit a retention policy: name, rule, scope, previewed before saving. */
export function PolicySheet({
  open,
  onOpenChange,
  policy,
  recommendedPreset,
  onSaved,
}: PolicySheetProps) {
  const { t } = useTranslation("retention");
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="border-b border-border p-6 pr-12">
          <SheetTitle className="text-lg">
            {policy ? t("form.editTitle") : t("form.createTitle")}
          </SheetTitle>
          <SheetDescription>{t("form.description")}</SheetDescription>
        </SheetHeader>
        {open ? (
          <PolicyForm
            key={policy?.id ?? "new"}
            policy={policy}
            recommendedPreset={recommendedPreset}
            onDone={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

interface PolicyFormProps {
  policy: RetentionPolicy | null;
  recommendedPreset: RetentionPreset;
  onDone: () => void;
  onSaved: PolicySheetProps["onSaved"];
}

function formFieldOf(apiField: string): DraftField {
  if (apiField === "protectedObjectIds") {
    return "objects";
  }
  if (apiField === "tiers") {
    return "tiers";
  }
  return "name";
}

function PolicyForm({ policy, recommendedPreset, onDone, onSaved }: PolicyFormProps) {
  const { t, i18n } = useTranslation("retention");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const [draft, setDraft] = React.useState<RetentionDraft>(() =>
    policy ? draftFromPolicy(policy) : newDraft(recommendedPreset),
  );
  const [attempted, setAttempted] = React.useState(false);
  const [confirmingStricter, setConfirmingStricter] = React.useState(false);
  const create = useCreateRetentionPolicy();
  const update = useUpdateRetentionPolicy();
  const saving = create.isPending || update.isPending;
  const formId = React.useId();
  const ids = (name: string) => `${formId}-${name}`;

  const set = <K extends keyof RetentionDraft>(key: K, value: RetentionDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const check = checkDraft(draft);
  const previewRequest: RetentionPreviewRequest | null = check.ok
    ? { id: policy?.id, ...previewInputFromDraft(draft) }
    : null;
  const preview = useRetentionPreview(previewRequest);
  // Whether `preview.data` can be trusted as the current draft's own answer:
  // not a stale placeholder from the previous draft, not still loading, not
  // failed. Submit waits for this before deciding whether a confirmation is
  // needed — see the comment on submit() below.
  const previewReady = check.ok && preview.isCurrent;

  const saveError = create.error ?? update.error;
  const saveProblem = fieldProblem(saveError);
  const previewProblem = previewRequest ? fieldProblem(preview.error) : null;
  const problem = saveProblem ?? previewProblem;
  const problemField = problem ? formFieldOf(problem.field) : null;
  // A preview failure the policy itself did not cause (network, server
  // error): the cause is not "fix the policy above", so it gets its own
  // message and a retry instead of being folded into the field-problem text.
  const previewFailed = Boolean(previewRequest && preview.error && !previewProblem);

  const errorFor = (field: DraftField): string | undefined => {
    if (problem && problemField === field) {
      return t(problem.key);
    }
    if (!check.ok && check.field === field && attempted) {
      return check.reason === "required" ? t(`validation.required.${field}`) : t("problems.gap");
    }
    return undefined;
  };

  const persist = async (): Promise<void> => {
    if (!check.ok) {
      return;
    }
    try {
      if (policy) {
        const patch = patchFromDraft(policy, draft);
        if (Object.keys(patch).length > 0) {
          onSaved("updated", await update.mutateAsync({ id: policy.id, patch }));
        }
      } else {
        onSaved("created", await create.mutateAsync(inputFromDraft(draft)));
      }
      onDone();
    } catch {
      // Shown by the form: field problems at their field, anything else above the buttons.
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (!check.ok) {
      return;
    }
    // The preview must be the current draft's own settled answer before it
    // decides whether a confirmation is needed: a stale placeholder (still
    // showing the previous draft's result while this one debounces), an
    // in-flight fetch or a failed one must never be read as "nothing to
    // remove" — the Save button stays disabled until then (see below), so
    // this only guards the moment submit fires right as it flips ready.
    if (!previewReady) {
      return;
    }
    if (isStricterChange(preview.data?.restorePoints)) {
      setConfirmingStricter(true);
      return;
    }
    void persist();
  };

  const nonFieldError = saveError && !saveProblem ? saveError : null;

  return (
    <>
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit} noValidate>
        <div className="flex-1 space-y-6 overflow-y-auto p-6">
          <Field id={ids("name")} label={t("form.name")} error={errorFor("name")}>
            <Input
              id={ids("name")}
              value={draft.name}
              onChange={(event) => set("name", event.target.value)}
              placeholder={t("form.namePlaceholder")}
              aria-invalid={Boolean(errorFor("name")) || undefined}
              aria-describedby={messageId(ids("name"))}
            />
          </Field>

          <Field id={ids("preset")} label={t("form.preset")}>
            <Select
              value={draft.preset}
              onValueChange={(value) => set("preset", value as RetentionPreset)}
            >
              <SelectTrigger id={ids("preset")} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRESET_ORDER.map((preset) => (
                  <SelectItem key={preset} value={preset}>
                    {t(`presets.${preset}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {draft.preset === "custom" ? (
            <div className="space-y-1.5">
              <Label id={ids("tiers-label")}>{t("form.tiersTitle")}</Label>
              <p className="text-xs text-muted-foreground">{t("form.tiersHint")}</p>
              <TierEditor
                id={ids("tiers")}
                value={draft.tiers}
                onChange={(tiers) => set("tiers", tiers)}
                invalid={Boolean(errorFor("tiers"))}
                describedBy={messageId(ids("tiers"))}
              />
              {errorFor("tiers") ? (
                <p id={messageId(ids("tiers"))} role="alert" className="text-xs text-destructive">
                  {errorFor("tiers")}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-3">
            <Label id={ids("scope-label")}>{t("form.scope")}</Label>
            <RadioGroup
              aria-labelledby={ids("scope-label")}
              value={draft.scope}
              onValueChange={(value) => set("scope", value as ScopeMode)}
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem id={ids("scope-tenant")} value="tenant" />
                <Label htmlFor={ids("scope-tenant")} className="font-normal">
                  {t("form.scopeTenant")}
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem id={ids("scope-objects")} value="objects" />
                <Label htmlFor={ids("scope-objects")} className="font-normal">
                  {t("form.scopeObjects")}
                </Label>
              </div>
            </RadioGroup>
            {draft.scope === "objects" ? (
              <ObjectPicker
                id={ids("objects")}
                value={draft.objects}
                onChange={(objects) => set("objects", objects)}
                invalid={Boolean(errorFor("objects"))}
                describedBy={messageId(ids("objects"))}
              />
            ) : null}
            {errorFor("objects") ? (
              <p id={messageId(ids("objects"))} role="alert" className="text-xs text-destructive">
                {errorFor("objects")}
              </p>
            ) : null}
          </div>

          <PreviewPanel
            id={ids("preview")}
            loading={check.ok && (preview.isPending || preview.isPlaceholderData)}
            refused={problem !== null && problem === previewProblem}
            failed={previewFailed}
            onRetry={() => void preview.refetch()}
            data={preview.data}
            language={language}
          />

          {nonFieldError ? (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden="true" />
              <AlertDescription>{t(`common:${errorMessageKey(nonFieldError)}`)}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <SheetFooter className="flex-row justify-end gap-2 border-t border-border p-4">
          <Button variant="outline" onClick={onDone} disabled={saving}>
            {t("actions.cancel")}
          </Button>
          <Button type="submit" loading={saving} disabled={check.ok && !previewReady}>
            {policy ? t("actions.save") : t("actions.create")}
          </Button>
        </SheetFooter>
      </form>

      {/* Outside the form: the dialog's own submit must not bubble into the sheet's form. */}
      <ConfirmDialog
        open={confirmingStricter}
        onOpenChange={setConfirmingStricter}
        title={t("confirm.stricterTitle")}
        description={t("confirm.stricterDescription", { count: preview.data?.restorePoints ?? 0 })}
        confirmLabel={t("confirm.stricterConfirm")}
        onConfirm={async () => {
          setConfirmingStricter(false);
          await persist();
        }}
      />
    </>
  );
}

interface PreviewPanelProps {
  id: string;
  loading: boolean;
  refused: boolean;
  /** The preview call itself failed (network, server error) — not the policy's fault. */
  failed: boolean;
  onRetry: () => void;
  data:
    | { objects: number; restorePoints: number; bytesLogical: number; heldRestorePoints: number }
    | undefined;
  language: string;
}

/** What the next retention run would remove if this draft were saved, as it stands. */
function PreviewPanel({
  id,
  loading,
  refused,
  failed,
  onRetry,
  data,
  language,
}: PreviewPanelProps) {
  const { t } = useTranslation("retention");
  return (
    <section
      aria-labelledby={id}
      aria-busy={loading || undefined}
      className="rounded-lg border bg-muted/40 p-4"
    >
      <h3 id={id} className="text-sm font-medium">
        {t("form.previewTitle")}
      </h3>
      {refused ? (
        <p className="mt-2 text-sm text-muted-foreground">{t("form.previewRefused")}</p>
      ) : failed ? (
        <div className="mt-2 flex items-center justify-between gap-3">
          <p role="alert" className="text-sm text-destructive">
            {t("form.previewError")}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {t("actions.refresh")}
          </Button>
        </div>
      ) : loading && !data ? (
        <div className="mt-2 space-y-2" aria-hidden="true">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-32" />
        </div>
      ) : !data ? (
        <p className="mt-2 text-sm text-muted-foreground">{t("form.previewRefused")}</p>
      ) : (
        <div className={loading ? "mt-2 space-y-1.5 opacity-60" : "mt-2 space-y-1.5"}>
          {data.restorePoints === 0 ? (
            <p className="text-sm text-muted-foreground">{t("form.previewNone")}</p>
          ) : (
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">{t("form.previewObjects")}</dt>
              <dd className="text-right font-medium tabular-nums">
                {formatInteger(data.objects, language)}
              </dd>
              <dt className="text-muted-foreground">{t("form.previewRestorePoints")}</dt>
              <dd className="text-right font-medium tabular-nums">
                {formatInteger(data.restorePoints, language)}
              </dd>
              <dt className="text-muted-foreground">{t("form.previewBytes")}</dt>
              <dd className="text-right font-medium tabular-nums">
                {formatBytes(data.bytesLogical, language)}
              </dd>
            </dl>
          )}
          {data.heldRestorePoints > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("form.previewHeld", { count: data.heldRestorePoints })}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
