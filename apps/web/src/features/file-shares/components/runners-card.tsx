import { Info, TriangleAlert } from "lucide-react";
import * as React from "react";

import { Field, messageId } from "@/components/forms/field";
import { ErrorState, StatusBadge } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { useSession } from "@/lib/session";

import type { InstallationShareSettingsValues } from "../api.js";
import "../i18n.js";
import {
  useInstallationShareSettings,
  useShareFormat,
  useUpdateInstallationShareSettings,
} from "../hooks.js";
import { shareErrorKey } from "../presenters.js";

type NumberField =
  | "maxConcurrentRunners"
  | "runnerMemoryMiB"
  | "goMemLimitPercent"
  | "maxRunHours"
  | "defaultReadConcurrency"
  | "defaultShareQuotaGib"
  | "tenantShareQuotaGib";

const BOUNDS: Readonly<Record<NumberField, [number, number]>> = {
  maxConcurrentRunners: [1, 64],
  runnerMemoryMiB: [512, 1_048_576],
  goMemLimitPercent: [50, 90],
  maxRunHours: [1, 336],
  defaultReadConcurrency: [1, 16],
  defaultShareQuotaGib: [0, 1_048_576],
  tenantShareQuotaGib: [0, 1_048_576],
};

const FIELDS = Object.keys(BOUNDS) as NumberField[];

/**
 * The file share runners of the installation (docs/FILESHARES.md 7.4, 12.1), in Installation >
 * Network shares: whether the mounter's runner is ready, how many runs it has, and the limits
 * runs get (concurrency, memory, run time, read concurrency), the default budgets, and the
 * provider owner's switch "Tenants may use private networks".
 */
export function FileShareRunnersCard() {
  const format = useShareFormat();
  const { t } = format;
  const { isProviderAdmin, providerRole, providerAllTenants } = useSession();
  const query = useInstallationShareSettings(isProviderAdmin && providerAllTenants !== false);
  const update = useUpdateInstallationShareSettings();
  const [values, setValues] = React.useState<Record<NumberField, string> | null>(null);
  const owner = (providerRole ?? "owner") === "owner";
  const mayChange = owner || providerRole === "administrator";

  React.useEffect(() => {
    if (query.data && values === null) {
      setValues(
        Object.fromEntries(FIELDS.map((key) => [key, String(query.data.settings[key])])) as Record<
          NumberField,
          string
        >,
      );
    }
  }, [query.data, values]);

  if (!isProviderAdmin) {
    return null;
  }
  if (query.isError) {
    return (
      <ErrorState
        title={t("runners.loadError")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  if (!query.data || values === null) {
    return <Skeleton className="h-40 w-full" aria-busy="true" />;
  }
  const settings = query.data.settings;
  const runner = query.data.runner;
  const problems = Object.fromEntries(
    FIELDS.map((key) => {
      const raw = values[key].trim();
      const [min, max] = BOUNDS[key];
      const ok = /^\d+$/.test(raw) && Number(raw) >= min && Number(raw) <= max;
      return [key, ok ? null : t("runners.range", { min, max })];
    }),
  ) as Record<NumberField, string | null>;
  const invalid = FIELDS.some((key) => problems[key] !== null);
  const changed = FIELDS.filter((key) => Number(values[key]) !== settings[key]);

  const save = (patch: Partial<InstallationShareSettingsValues>) =>
    update.mutate(patch, {
      onSuccess: () => toast.success(t("runners.saved")),
      onError: (error) => toast.error(t(shareErrorKey(error))),
    });

  return (
    <Card data-slot="file-share-runners">
      <CardHeader>
        <CardTitle className="text-base">{t("runners.title")}</CardTitle>
        <CardDescription>{t("runners.description")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2" data-slot="runner-state">
          <StatusBadge tone={runner.available && runner.ready ? "info" : "warning"} icon>
            {runner.available
              ? runner.ready
                ? t("runners.ready", { running: runner.running, limit: runner.limit ?? 0 })
                : t("runners.blocked")
              : t("runners.off")}
          </StatusBadge>
        </div>
        {!runner.available ? (
          <Alert variant="warning">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>
              <p>{t("runners.offHint")}</p>
              <code className="mt-1 block font-mono text-xs">{query.data.enableCommand}</code>
            </AlertDescription>
          </Alert>
        ) : null}
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (invalid || changed.length === 0) return;
            save(Object.fromEntries(changed.map((key) => [key, Number(values[key])])));
          }}
        >
          {FIELDS.map((key) => (
            <Field
              key={key}
              id={`runners-${key}`}
              label={t(`runners.fields.${key}`)}
              hint={t(`runners.hints.${key}`)}
              error={problems[key] ?? undefined}
            >
              <Input
                id={`runners-${key}`}
                inputMode="numeric"
                value={values[key]}
                disabled={!mayChange}
                onChange={(event) =>
                  setValues((current) =>
                    current ? { ...current, [key]: event.target.value } : current,
                  )
                }
                aria-describedby={messageId(`runners-${key}`)}
              />
            </Field>
          ))}
          <p className="flex items-start gap-2 text-xs text-muted-foreground sm:col-span-2">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {t("runners.memoryNote")}
          </p>
          {mayChange ? (
            <div className="sm:col-span-2">
              <Button
                type="submit"
                size="sm"
                disabled={invalid || changed.length === 0}
                loading={update.isPending}
                data-action="save-runners"
              >
                {t("runners.save")}
              </Button>
            </div>
          ) : null}
        </form>
        <div className="flex items-start gap-3 border-t pt-4">
          <Switch
            id="runners-private"
            checked={settings.tenantsMayUsePrivateNetworks}
            disabled={!owner || update.isPending}
            onCheckedChange={(checked) => save({ tenantsMayUsePrivateNetworks: checked === true })}
            data-action="private-networks"
          />
          <div className="grid gap-0.5">
            <Label htmlFor="runners-private">{t("runners.privateNetworks")}</Label>
            <p className="text-xs text-muted-foreground">
              {owner ? t("runners.privateNetworksHint") : t("runners.privateNetworksOwner")}
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3">
          <Switch
            id="runners-catalog"
            checked={settings.catalog.enabled}
            disabled={!mayChange || update.isPending}
            onCheckedChange={(checked) =>
              save({ catalog: { ...settings.catalog, enabled: checked === true } })
            }
          />
          <div className="grid gap-0.5">
            <Label htmlFor="runners-catalog">{t("runners.catalog")}</Label>
            <p className="text-xs text-muted-foreground">{t("runners.catalogHint")}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
