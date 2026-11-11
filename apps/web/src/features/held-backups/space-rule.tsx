import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { apiFetch, errorMessageKey } from "@/lib/api";
import { formatBytes } from "@/lib/format";

import "@/features/warnings/i18n";

/**
 * The space a storage target keeps free for everything else on it (#99, docs/STORAGE.md
 * "Unusually large runs"): a share of its size between a minimum and a maximum. Set for the
 * installation (Installation › Database), a tenant (Warnings, "Size check") and one of a tenant's
 * own targets (its card on the storage page). The texts live under `warnings:held.space`.
 */

const GIB = 1024 ** 3;

export interface SpaceRule {
  enabled: boolean;
  percent: number;
  minBytes: number;
  maxBytes: number;
}

export type SpaceOverride = Partial<SpaceRule>;

/** What the forms send: sizes in GiB. */
export interface SpaceInput {
  enabled?: boolean;
  percent?: number;
  minGib?: number;
  maxGib?: number;
}

export interface SpaceRuleView {
  override: SpaceOverride | null;
  effective: SpaceRule;
}

export interface TargetSpaceRule extends SpaceRuleView {
  targetId: string;
  name: string | null;
  role: string;
}

export const spaceRuleKeys = {
  installation: ["installation", "space-rule"] as const,
  targets: (tenantId: string | null) => ["tenant", tenantId, "run-size", "targets"] as const,
};

export function fetchInstallationSpaceRule(): Promise<SpaceRuleView> {
  return apiFetch<SpaceRuleView>("/updates/space-rule");
}

export function saveInstallationSpaceRule(space: SpaceInput | null): Promise<SpaceRuleView> {
  return apiFetch<SpaceRuleView>("/updates/space-rule", { method: "PUT", body: { space } });
}

export function fetchTargetSpaceRules(): Promise<TargetSpaceRule[]> {
  return apiFetch<TargetSpaceRule[]>("/run-size/targets");
}

export function saveTargetSpaceRule(
  targetId: string,
  space: SpaceInput | null,
): Promise<TargetSpaceRule[]> {
  return apiFetch<TargetSpaceRule[]>(`/run-size/targets/${encodeURIComponent(targetId)}`, {
    method: "PUT",
    body: { space },
  });
}

/** "5 % of the target, at least 20 GiB, at most 500 GiB", or "off". */
export function useSpaceRuleText() {
  const { t, i18n } = useTranslation("warnings");
  const language = i18n.resolvedLanguage ?? i18n.language;
  return (rule: SpaceRule) =>
    rule.enabled
      ? t("held.space.summary", {
          percent: rule.percent,
          min: formatBytes(rule.minBytes, language),
          max: formatBytes(rule.maxBytes, language),
        })
      : t("held.space.off");
}

/**
 * What a form changed from the rule it started from, alone (null: nothing). Only that becomes the
 * level's own: what was left as it was keeps following the level below.
 */
export function spaceChanges(input: SpaceInput, rule: SpaceRule | undefined): SpaceInput | null {
  if (!rule) {
    return input;
  }
  const changes: SpaceInput = {};
  if (input.enabled !== undefined && input.enabled !== rule.enabled)
    changes.enabled = input.enabled;
  if (input.percent !== undefined && input.percent !== rule.percent)
    changes.percent = input.percent;
  if (input.minGib !== undefined && Math.round(input.minGib * GIB) !== rule.minBytes) {
    changes.minGib = input.minGib;
  }
  if (input.maxGib !== undefined && Math.round(input.maxGib * GIB) !== rule.maxBytes) {
    changes.maxGib = input.maxGib;
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

function number(value: string): number {
  return Number(value.trim().replace(",", "."));
}

/** The four fields of a space rule; reports a valid input (or null) as it changes. */
export function SpaceRuleFields({
  rule,
  disabled,
  onChange,
}: {
  rule: SpaceRule;
  disabled: boolean;
  onChange: (input: SpaceInput | null) => void;
}) {
  const { t } = useTranslation("warnings");
  const [form, setForm] = React.useState({
    on: rule.enabled,
    percent: String(rule.percent),
    minGib: String(rule.minBytes / GIB),
    maxGib: String(rule.maxBytes / GIB),
  });
  const ids = {
    on: React.useId(),
    percent: React.useId(),
    minGib: React.useId(),
    maxGib: React.useId(),
  };
  React.useEffect(() => {
    setForm({
      on: rule.enabled,
      percent: String(rule.percent),
      minGib: String(rule.minBytes / GIB),
      maxGib: String(rule.maxBytes / GIB),
    });
  }, [rule]);
  React.useEffect(() => {
    const percent = number(form.percent);
    const minGib = number(form.minGib);
    const maxGib = number(form.maxGib);
    const valid =
      Number.isFinite(percent) &&
      percent >= 0 &&
      percent <= 50 &&
      Number.isFinite(minGib) &&
      minGib >= 0 &&
      Number.isFinite(maxGib) &&
      maxGib >= minGib;
    onChange(valid ? { enabled: form.on, percent, minGib, maxGib } : null);
  }, [form, onChange]);
  const field = (key: "percent" | "minGib" | "maxGib") => ({
    id: ids[key],
    value: form[key],
    disabled: disabled || !form.on,
    inputMode: "decimal" as const,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      setForm((current) => ({ ...current, [key]: event.target.value })),
  });
  return (
    <div className="grid gap-3" data-slot="space-rule-fields">
      <div className="flex items-center gap-2">
        <Checkbox
          id={ids.on}
          checked={form.on}
          disabled={disabled}
          onCheckedChange={(checked) =>
            setForm((current) => ({ ...current, on: checked === true }))
          }
        />
        <Label htmlFor={ids.on}>{t("held.space.enabled")}</Label>
      </div>
      <div className="grid gap-1">
        <Label htmlFor={ids.percent}>{t("held.space.percent")}</Label>
        <Input {...field("percent")} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={ids.minGib}>{t("held.space.minGib")}</Label>
        <Input {...field("minGib")} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={ids.maxGib}>{t("held.space.maxGib")}</Label>
        <Input {...field("maxGib")} />
      </div>
    </div>
  );
}

/** A dialog around {@link SpaceRuleFields}: save, or go back to the level below. */
export function SpaceRuleDialog({
  open,
  title,
  description,
  rule,
  canEdit,
  hasOverride,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  title: string;
  description: string;
  rule: SpaceRule;
  canEdit: boolean;
  hasOverride: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (space: SpaceInput | null) => Promise<unknown>;
}) {
  const { t } = useTranslation("warnings");
  const [input, setInput] = React.useState<SpaceInput | null>(null);
  const save = useMutation({
    mutationFn: onSave,
    onSuccess: () => {
      toast.success(t("held.toast.saved"));
      onOpenChange(false);
    },
    onError: (error) => toast.error(t(`common:${errorMessageKey(error)}`)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="space-rule-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <SpaceRuleFields rule={rule} disabled={!canEdit} onChange={setInput} />
        <DialogFooter>
          {hasOverride ? (
            <Button
              variant="ghost"
              disabled={!canEdit || save.isPending}
              onClick={() => save.mutate(null)}
            >
              {t("held.space.reset")}
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("held.cancel")}
          </Button>
          <Button
            disabled={!canEdit || input === null || save.isPending}
            onClick={() => {
              const changes = input ? spaceChanges(input, rule) : null;
              if (changes) {
                save.mutate(changes);
              } else {
                onOpenChange(false);
              }
            }}
          >
            {t("held.settings.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One of the tenant's own storage targets: what it keeps free, and the dialog to change it (its
 * card on the storage page). Nothing for the installation's shared default target.
 */
export function TargetSpaceRuleLine({
  targetId,
  tenantId,
  canEdit,
}: {
  targetId: string;
  tenantId: string | null;
  canEdit: boolean;
}) {
  const { t } = useTranslation("warnings");
  const text = useSpaceRuleText();
  const client = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const rules = useQuery({
    queryKey: spaceRuleKeys.targets(tenantId),
    queryFn: fetchTargetSpaceRules,
    enabled: tenantId !== null,
  });
  const rule = rules.data?.find((candidate) => candidate.targetId === targetId);
  if (!rule) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-slot="target-space-rule">
      <span className="text-muted-foreground">{t("held.space.targetLine")}</span>
      <span>{text(rule.effective)}</span>
      {rule.override ? (
        <span className="text-xs text-muted-foreground">{t("held.space.own")}</span>
      ) : null}
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        {t("held.space.change")}
      </Button>
      <SpaceRuleDialog
        open={open}
        title={t("held.space.targetTitle")}
        description={t("held.space.targetDescription")}
        rule={rule.effective}
        canEdit={canEdit}
        hasOverride={rule.override !== null}
        onOpenChange={setOpen}
        onSave={async (space) => {
          const next = await saveTargetSpaceRule(targetId, space);
          client.setQueryData(spaceRuleKeys.targets(tenantId), next);
        }}
      />
    </div>
  );
}

/** Installation › Database: what every target keeps free unless a tenant or a target says else. */
export function InstallationSpaceRuleCard({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation("warnings");
  const text = useSpaceRuleText();
  const client = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const rule = useQuery({
    queryKey: spaceRuleKeys.installation,
    queryFn: fetchInstallationSpaceRule,
  });
  if (!rule.data) {
    return null;
  }
  return (
    <div className="space-y-1 text-sm" data-slot="installation-space-rule">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t("held.space.installationTitle")}</span>
        <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
          {t("held.space.change")}
        </Button>
      </div>
      <p className="text-muted-foreground">{text(rule.data.effective)}</p>
      <p className="text-xs text-muted-foreground">{t("held.space.installationHint")}</p>
      <SpaceRuleDialog
        open={open}
        title={t("held.space.installationTitle")}
        description={t("held.space.installationDescription")}
        rule={rule.data.effective}
        canEdit={canEdit}
        hasOverride={rule.data.override !== null}
        onOpenChange={setOpen}
        onSave={async (space) => {
          client.setQueryData(spaceRuleKeys.installation, await saveInstallationSpaceRule(space));
        }}
      />
    </div>
  );
}
