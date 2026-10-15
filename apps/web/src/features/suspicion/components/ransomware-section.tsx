import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { providerMay } from "@/lib/provider-role";
import { useSession } from "@/lib/session";

import "../i18n";
import type { RansomwareSettings } from "../api";
import { useRansomwareSettings, useSaveRansomwareSettings } from "../hooks";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

type Group =
  | "changeRate"
  | "deletions"
  | "renames"
  | "names"
  | "entropy"
  | "compressibility"
  | "retentionHold";

/** One number of the form: where it lives, how it is shown (percent, GiB) and its label. */
interface Field {
  group: Group | null;
  key: string;
  label: string;
  /** Shown times this factor (100 for a share in percent, 1/GiB for bytes). */
  scale?: number;
  step?: number;
}

const GROUPS: readonly {
  group: Group;
  title: string;
  hint?: string;
  /** The label of the group's switch (default: "Check"). */
  switchLabel?: string;
  fields: Field[];
}[] = [
  {
    group: "changeRate",
    title: "settings.changeRate",
    hint: "settings.changeRateHint",
    fields: [
      { group: "changeRate", key: "madFactor", label: "settings.madFactor", step: 0.5 },
      { group: "changeRate", key: "minRatio", label: "settings.minRatio", step: 0.5 },
      { group: "changeRate", key: "minItems", label: "settings.minItems" },
      { group: "changeRate", key: "minBytes", label: "settings.minBytesGib", scale: 1 / GIB },
    ],
  },
  {
    group: "deletions",
    title: "settings.deletions",
    fields: [
      { group: "deletions", key: "minFiles", label: "settings.deletionsMinFiles" },
      { group: "deletions", key: "minShare", label: "settings.deletionsMinShare", scale: 100 },
    ],
  },
  {
    group: "renames",
    title: "settings.renames",
    fields: [
      { group: "renames", key: "minFiles", label: "settings.renamesMinFiles" },
      {
        group: "renames",
        key: "minShare",
        label: "settings.renamesMinShare",
        scale: 100,
        step: 0.1,
      },
    ],
  },
  {
    group: "names",
    title: "settings.names",
    fields: [
      { group: "names", key: "minExtensionFiles", label: "settings.minExtensionFiles" },
      { group: "names", key: "minNoteCopies", label: "settings.minNoteCopies" },
    ],
  },
  {
    group: "entropy",
    title: "settings.entropy",
    fields: [
      { group: "entropy", key: "minSamples", label: "settings.minSamples" },
      { group: "entropy", key: "highBits", label: "settings.highBits", step: 0.01 },
      { group: "entropy", key: "minHighShare", label: "settings.minHighShare", scale: 100 },
    ],
  },
  {
    group: "compressibility",
    title: "settings.compressibility",
    hint: "settings.compressibilityHint",
    fields: [
      {
        group: "compressibility",
        key: "minBytes",
        label: "settings.compressibilityMinBytesMib",
        scale: 1 / MIB,
      },
      {
        group: "compressibility",
        key: "madFactor",
        label: "settings.compressibilityMadFactor",
        step: 0.5,
      },
      {
        group: "compressibility",
        key: "compressionMinRatio",
        label: "settings.compressionMinRatio",
        scale: 100,
      },
      {
        group: "compressibility",
        key: "compressionMinRise",
        label: "settings.compressionMinRise",
        scale: 100,
      },
      {
        group: "compressibility",
        key: "dedupMinRatio",
        label: "settings.dedupMinRatio",
        scale: 100,
      },
      { group: "compressibility", key: "dedupMinRise", label: "settings.dedupMinRise", scale: 100 },
    ],
  },
  {
    group: "retentionHold",
    title: "settings.retentionHold",
    hint: "settings.retentionHoldHint",
    switchLabel: "settings.retentionHoldEnabled",
    fields: [{ group: "retentionHold", key: "reminderDays", label: "settings.reminderDays" }],
  },
];

function read(settings: RansomwareSettings, field: Field): number {
  const source = (field.group ? settings[field.group] : settings) as unknown as Record<
    string,
    number
  >;
  const value = source[field.key] ?? 0;
  return Math.round(value * (field.scale ?? 1) * 1000) / 1000;
}

/** The thresholds the server takes as whole numbers only. */
const WHOLE = new Set([
  "baselineRuns",
  "minBaselineRuns",
  "minItems",
  "minBytes",
  "minFiles",
  "minExtensionFiles",
  "minNoteCopies",
  "minSamples",
  "reminderDays",
]);

function write(settings: RansomwareSettings, field: Field, shown: number): RansomwareSettings {
  const raw = shown / (field.scale ?? 1);
  const value = WHOLE.has(field.key) ? Math.round(raw) : raw;
  if (!field.group) {
    return { ...settings, [field.key]: value };
  }
  return { ...settings, [field.group]: { ...settings[field.group], [field.key]: value } };
}

/**
 * Installation > Ransomware detection (docs/RANSOMWARE.md): whether restore points are judged at
 * all, and the thresholds of each signal. Every provider admin reads them, the owner changes
 * them; "Back to the defaults" stores nothing, so later defaults apply.
 */
export function RansomwareSection() {
  const { t } = useTranslation("suspicion");
  const session = useSession();
  const canChange = providerMay(session, "owner");
  const query = useRansomwareSettings();
  const save = useSaveRansomwareSettings();
  const [draft, setDraft] = React.useState<RansomwareSettings | null>(null);
  const id = React.useId();

  React.useEffect(() => {
    if (query.data) {
      setDraft(query.data.settings);
    }
  }, [query.data]);

  if (query.isPending) {
    return <Skeleton className="h-64 w-full" aria-busy="true" />;
  }
  if (query.isError || !query.data || !draft) {
    return (
      <ErrorState
        title={t("settings.loadFailed")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }

  const submit = (next: Partial<RansomwareSettings>) =>
    save.mutate(next, {
      onSuccess: () => toast(t("settings.saved")),
      onError: () => toast.error(t("settings.saveFailed")),
    });

  const numberField = (field: Field) => {
    const fieldId = `${id}-${field.group ?? "base"}-${field.key}`;
    return (
      <div key={fieldId} className="min-w-0 space-y-1">
        <Label htmlFor={fieldId}>{t(field.label)}</Label>
        <Input
          id={fieldId}
          type="number"
          inputMode="decimal"
          step={field.step ?? 1}
          disabled={!canChange}
          value={read(draft, field)}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (Number.isFinite(value)) {
              setDraft(write(draft, field, value));
            }
          }}
        />
      </div>
    );
  };

  return (
    <div className="space-y-4" data-slot="ransomware-settings">
      <Card>
        <CardHeader>
          <CardTitle>{t("settings.title")}</CardTitle>
          <CardDescription>{t("settings.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Switch
              id={`${id}-enabled`}
              checked={draft.enabled}
              disabled={!canChange}
              onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
            />
            <Label htmlFor={`${id}-enabled`}>{t("settings.enabled")}</Label>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("settings.signaturesVersion", { version: query.data.signaturesVersion })}
          </p>
          {canChange ? null : (
            <p className="text-sm text-muted-foreground">{t("settings.readOnly")}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("settings.baseline")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {numberField({ group: null, key: "baselineRuns", label: "settings.baselineRuns" })}
          {numberField({ group: null, key: "minBaselineRuns", label: "settings.minBaselineRuns" })}
        </CardContent>
      </Card>

      {GROUPS.map((entry) => (
        <Card key={entry.group}>
          <CardHeader>
            <CardTitle className="text-base">{t(entry.title)}</CardTitle>
            {entry.hint ? <CardDescription>{t(entry.hint)}</CardDescription> : null}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <Switch
                id={`${id}-${entry.group}-enabled`}
                checked={draft[entry.group].enabled}
                disabled={!canChange}
                onCheckedChange={(enabled) =>
                  setDraft({ ...draft, [entry.group]: { ...draft[entry.group], enabled } })
                }
              />
              <Label htmlFor={`${id}-${entry.group}-enabled`}>
                {t(entry.switchLabel ?? "settings.signalEnabled")}
              </Label>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">{entry.fields.map(numberField)}</div>
          </CardContent>
        </Card>
      ))}

      {canChange ? (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => submit(draft)} loading={save.isPending}>
            {t("settings.save")}
          </Button>
          <Button variant="outline" onClick={() => submit({})} disabled={save.isPending}>
            {t("settings.reset")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
