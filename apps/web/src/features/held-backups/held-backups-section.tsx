import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PauseCircle, Settings2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { RelativeTime, StatusBadge } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { errorMessageKey } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { providerMay } from "@/lib/provider-role";
import { useSession } from "@/lib/session";

import {
  continueHeldBackup,
  fetchHeldBackups,
  fetchSizeGuardSettings,
  type HeldBackup,
  heldBackupKeys,
  raiseHeldBackupLimit,
  type SizeGuardOverrideInput,
  saveSizeGuardSettings,
  suggestedLimitGib,
} from "./api";

/**
 * The backups the size and space guard held (#99, docs/STORAGE.md "Unusually large runs"), at
 * the top of Warnings: what each would have added and what is usual, and the decision. Continue
 * once (technicians and up), raise the object's limit or switch the check off for it, and the
 * tenant's settings (administrators and up). Shown only where the server answers.
 */

const GIB = 1024 ** 3;

function useHeldScope() {
  const session = useSession();
  const tenantId = session.activeTenant?.id ?? null;
  return {
    tenantId,
    enabled: session.status === "authenticated" && tenantId !== null,
    canContinue: session.isProviderAdmin
      ? providerMay(session, "technician")
      : session.role === "tenant_admin",
    canConfigure: session.isProviderAdmin
      ? providerMay(session, "administrator")
      : session.role === "tenant_admin",
  };
}

export function HeldBackupsSection() {
  const { t } = useTranslation("warnings");
  const scope = useHeldScope();
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [raising, setRaising] = React.useState<HeldBackup | null>(null);
  const holds = useQuery({
    queryKey: heldBackupKeys.holds(scope.tenantId),
    queryFn: fetchHeldBackups,
    enabled: scope.enabled,
  });
  const client = useQueryClient();
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: heldBackupKeys.holds(scope.tenantId) }),
      client.invalidateQueries({ queryKey: heldBackupKeys.settings(scope.tenantId) }),
    ]);
  const fail = (error: unknown) => toast.error(t(`common:${errorMessageKey(error)}`));
  const continueOnce = useMutation({
    mutationFn: (hold: HeldBackup) => continueHeldBackup(hold.id, null),
    onSuccess: () => {
      toast.success(t("held.toast.continued"));
      void refresh();
    },
    onError: fail,
  });
  const switchOff = useMutation({
    mutationFn: (hold: HeldBackup) =>
      saveSizeGuardSettings({
        kind: hold.objectKind,
        objectId: hold.objectId,
        override: { enabled: false },
      }),
    onSuccess: () => {
      toast.success(t("held.toast.switchedOff"));
      void refresh();
    },
    onError: fail,
  });

  if (!holds.data) {
    return null;
  }
  const open = holds.data.open;
  return (
    <Card data-slot="held-backups" data-count={open.length}>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <PauseCircle className="size-4" aria-hidden="true" />
            {t("held.title")}
          </CardTitle>
          <CardDescription>{t("held.description")}</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
          <Settings2 aria-hidden="true" />
          {t("held.settings.open")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {open.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-slot="held-none">
            {t("held.none")}
          </p>
        ) : (
          open.map((hold) => (
            <HeldRow
              key={hold.id}
              hold={hold}
              canContinue={scope.canContinue}
              canConfigure={scope.canConfigure}
              busy={continueOnce.isPending || switchOff.isPending}
              onContinue={() => continueOnce.mutate(hold)}
              onRaise={() => setRaising(hold)}
              onSwitchOff={() => switchOff.mutate(hold)}
            />
          ))
        )}
      </CardContent>
      <RaiseDialog
        hold={raising}
        onClose={() => setRaising(null)}
        onDone={() => {
          setRaising(null);
          void refresh();
        }}
      />
      <SettingsDialog
        open={settingsOpen}
        canConfigure={scope.canConfigure}
        tenantId={scope.tenantId}
        enabled={scope.enabled}
        onOpenChange={setSettingsOpen}
        onSaved={() => void refresh()}
      />
    </Card>
  );
}

function HeldRow({
  hold,
  canContinue,
  canConfigure,
  busy,
  onContinue,
  onRaise,
  onSwitchOff,
}: {
  hold: HeldBackup;
  canContinue: boolean;
  canConfigure: boolean;
  busy: boolean;
  onContinue: () => void;
  onRaise: () => void;
  onSwitchOff: () => void;
}) {
  const { t, i18n } = useTranslation("warnings");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const bytes = (value: number | null) => formatBytes(value ?? 0, language);
  const why =
    hold.reason === "size"
      ? t(hold.medianBytes !== null ? "held.why.size" : "held.why.sizeNoHistory", {
          limit: bytes(hold.limitBytes),
          bytes: bytes(hold.bytes),
          usual: bytes(hold.medianBytes),
        })
      : t("held.why.space", {
          free: bytes(hold.freeBytes),
          total: bytes(hold.totalBytes),
        });
  return (
    <div
      className="space-y-2 rounded-md border p-3"
      data-slot="held-backup"
      data-status={hold.status}
      data-reason={hold.reason}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{hold.objectName}</span>
        <span className="text-muted-foreground">{t(`held.kind.${hold.objectKind}`)}</span>
        <StatusBadge tone={hold.status === "approved" ? "info" : "warning"}>
          {t(`held.status.${hold.status}`)}
        </StatusBadge>
      </div>
      <p className="text-sm">{why}</p>
      <p className="text-xs text-muted-foreground">
        {t("held.heldAt")} <RelativeTime value={hold.heldAt} />
        {hold.refusedRuns > 0 ? ` · ${t("held.refused", { count: hold.refusedRuns })}` : null}
        {hold.status === "approved" && hold.approvedBy
          ? ` · ${t("held.approvedBy", { name: hold.approvedBy })}`
          : null}
      </p>
      {hold.status === "pending" ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!canContinue || busy} onClick={onContinue}>
            {t("held.actions.continue")}
          </Button>
          <Button size="sm" variant="outline" disabled={!canConfigure || busy} onClick={onRaise}>
            {t("held.actions.raise")}
          </Button>
          <Button size="sm" variant="ghost" disabled={!canConfigure || busy} onClick={onSwitchOff}>
            {t("held.actions.switchOff")}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("held.continuesNext")}</p>
      )}
      <p className="text-xs text-muted-foreground">{t("held.excludeHint")}</p>
    </div>
  );
}

function RaiseDialog({
  hold,
  onClose,
  onDone,
}: {
  hold: HeldBackup | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t, i18n } = useTranslation("warnings");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const [value, setValue] = React.useState("");
  const inputId = React.useId();
  React.useEffect(() => {
    setValue(hold ? String(suggestedLimitGib(hold)) : "");
  }, [hold]);
  const raise = useMutation({
    mutationFn: ({ id, gib }: { id: string; gib: number }) => raiseHeldBackupLimit(id, gib),
    onSuccess: () => {
      toast.success(t("held.toast.raised"));
      onDone();
    },
    onError: (error) => toast.error(t(`common:${errorMessageKey(error)}`)),
  });
  const gib = Number(value.replace(",", "."));
  const valid = Number.isFinite(gib) && gib > 0 && hold !== null && gib * GIB > hold.bytes;
  return (
    <Dialog open={hold !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent data-slot="held-raise-dialog">
        <DialogHeader>
          <DialogTitle>{t("held.raise.title", { name: hold?.objectName ?? "" })}</DialogTitle>
          <DialogDescription>
            {t("held.raise.description", {
              bytes: formatBytes(hold?.bytes ?? 0, language),
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={inputId}>{t("held.raise.label")}</Label>
          <Input
            id={inputId}
            inputMode="decimal"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("held.cancel")}
          </Button>
          <Button
            disabled={!valid || raise.isPending}
            onClick={() => hold && raise.mutate({ id: hold.id, gib })}
          >
            {t("held.raise.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A GiB field: empty is "none" where `empty` allows it. */
function numberOrNull(value: string): number | null {
  const trimmed = value.trim().replace(",", ".");
  if (trimmed === "") {
    return null;
  }
  const number = Number(trimmed);
  return Number.isFinite(number) && number >= 0 ? number : Number.NaN;
}

function SettingsDialog({
  open,
  canConfigure,
  tenantId,
  enabled,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  canConfigure: boolean;
  tenantId: string | null;
  enabled: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { t, i18n } = useTranslation("warnings");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const settings = useQuery({
    queryKey: heldBackupKeys.settings(tenantId),
    queryFn: fetchSizeGuardSettings,
    enabled: enabled && open,
  });
  const [form, setForm] = React.useState({
    on: true,
    factor: "",
    minGib: "",
    firstRunGib: "",
    minFreePercent: "",
  });
  const ids = {
    on: React.useId(),
    factor: React.useId(),
    minGib: React.useId(),
    firstRunGib: React.useId(),
    minFreePercent: React.useId(),
  };
  const effective = settings.data?.effective;
  React.useEffect(() => {
    if (effective) {
      setForm({
        on: effective.enabled,
        factor: String(effective.factor),
        minGib: String(effective.minBytes / GIB),
        firstRunGib: effective.firstRunBytes === null ? "" : String(effective.firstRunBytes / GIB),
        minFreePercent: String(effective.minFreePercent),
      });
    }
  }, [effective]);
  const save = useMutation({
    mutationFn: (input: {
      kind?: never;
      objectId?: never;
      override: SizeGuardOverrideInput | null;
    }) => saveSizeGuardSettings(input),
    onSuccess: () => {
      toast.success(t("held.toast.saved"));
      onSaved();
    },
    onError: (error) => toast.error(t(`common:${errorMessageKey(error)}`)),
  });
  const resetObject = useMutation({
    mutationFn: (object: { kind: HeldBackup["objectKind"]; objectId: string }) =>
      saveSizeGuardSettings({ ...object, override: null }),
    onSuccess: () => onSaved(),
    onError: (error) => toast.error(t(`common:${errorMessageKey(error)}`)),
  });
  const factor = Number(form.factor.replace(",", "."));
  const minGib = numberOrNull(form.minGib);
  const firstRunGib = numberOrNull(form.firstRunGib);
  const minFreePercent = Number(form.minFreePercent.replace(",", "."));
  const valid =
    Number.isFinite(factor) &&
    factor >= 2 &&
    factor <= 1000 &&
    minGib !== null &&
    Number.isFinite(minGib) &&
    !Number.isNaN(firstRunGib) &&
    Number.isFinite(minFreePercent) &&
    minFreePercent >= 0 &&
    minFreePercent <= 50;
  const field = (key: keyof typeof form) => ({
    id: ids[key],
    value: String(form[key]),
    disabled: !canConfigure,
    inputMode: "decimal" as const,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      setForm((current) => ({ ...current, [key]: event.target.value })),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="held-settings-dialog">
        <DialogHeader>
          <DialogTitle>{t("held.settings.title")}</DialogTitle>
          <DialogDescription>{t("held.settings.description")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="flex items-center gap-2">
            <Checkbox
              id={ids.on}
              checked={form.on}
              disabled={!canConfigure}
              onCheckedChange={(checked) =>
                setForm((current) => ({ ...current, on: checked === true }))
              }
            />
            <Label htmlFor={ids.on}>{t("held.settings.enabled")}</Label>
          </div>
          <div className="grid gap-1">
            <Label htmlFor={ids.factor}>{t("held.settings.factor")}</Label>
            <Input {...field("factor")} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={ids.minGib}>{t("held.settings.minGib")}</Label>
            <Input {...field("minGib")} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={ids.firstRunGib}>{t("held.settings.firstRunGib")}</Label>
            <Input {...field("firstRunGib")} placeholder={t("held.settings.firstRunExempt")} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={ids.minFreePercent}>{t("held.settings.minFreePercent")}</Label>
            <Input {...field("minFreePercent")} />
          </div>
          {settings.data && settings.data.objects.length > 0 ? (
            <div className="space-y-1" data-slot="held-settings-objects">
              <p className="text-sm font-medium">{t("held.settings.objects")}</p>
              {settings.data.objects.map((object) => (
                <div
                  key={`${object.kind}:${object.objectId}`}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <span>
                    {object.objectName}
                    <span className="text-muted-foreground">
                      {" · "}
                      {object.effective.enabled
                        ? object.override.limitBytes
                          ? t("held.settings.objectLimit", {
                              limit: formatBytes(object.override.limitBytes, language),
                            })
                          : t("held.settings.objectOwn")
                        : t("held.settings.objectOff")}
                    </span>
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={!canConfigure || resetObject.isPending}
                    onClick={() =>
                      resetObject.mutate({ kind: object.kind, objectId: object.objectId })
                    }
                  >
                    {t("held.settings.reset")}
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("held.cancel")}
          </Button>
          <Button
            disabled={!canConfigure || !valid || save.isPending}
            onClick={() =>
              save.mutate({
                override: {
                  enabled: form.on,
                  factor,
                  minGib: minGib ?? 0,
                  firstRunGib,
                  minFreePercent,
                },
              })
            }
          >
            {t("held.settings.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
