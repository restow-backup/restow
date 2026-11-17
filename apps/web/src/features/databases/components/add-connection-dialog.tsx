import { useNavigate } from "@tanstack/react-router";
import { Hourglass, PlugZap } from "lucide-react";
import * as React from "react";

import { Field } from "@/components/forms/field";
import { NativeSelect } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { ApiError } from "@/lib/api";

import { type DbAuthMethod, type DbMode, splitAddressCredentials } from "../api.js";
import {
  useCreateConnection,
  useDbFormat,
  useProbe,
  useRunners,
  useTestConnection,
} from "../hooks.js";
import { connectionTo, linkTo } from "../paths.js";
import { INTERVAL_CHOICES } from "../presenters.js";
import { ProbeResult } from "./probe-result.js";

/** What a suggestion of the inventory opens the dialog with (3.4). */
export interface AddConnectionPrefill {
  address: string;
  authMethod: DbAuthMethod;
  endpointId: string;
}

export interface AddConnectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefill?: AddConnectionPrefill | null;
}

/** The value of the executor picker: the Restow server, or one agent. */
const SERVER = "server";

/** The key of a problem the API answered, for the texts of the `databases` namespace. */
export function problemKey(error: unknown): string {
  if (error instanceof ApiError) {
    const suffix = error.problem?.type?.replace(/^urn:restow:problem:database-/, "");
    if (suffix && suffix !== error.problem?.type) {
      const reason = (error.problem as { reason?: unknown } | null)?.reason;
      return typeof reason === "string" ? `problems.${reason}` : `problems.${suffix}`;
    }
    if (error.status === 429) {
      return "problems.probe-limit";
    }
  }
  return "problems.generic";
}

/**
 * "Add database" (docs/DATABASES.md 2.3, 3): the address, the user and the password, the
 * executor; "Test connection" shows engine, version, certificate, databases and the rights
 * matrix before anything is saved. Then name, mode, schedule and the databases to protect.
 * A user and a password typed into the address as a URL move into their fields.
 */
export function AddConnectionDialog({ open, onOpenChange, prefill }: AddConnectionDialogProps) {
  const format = useDbFormat();
  const { t } = format;
  const navigate = useNavigate();
  const runners = useRunners(open);
  const test = useTestConnection();
  const create = useCreateConnection();

  const [address, setAddress] = React.useState("");
  const [user, setUser] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [executor, setExecutor] = React.useState<string>(SERVER);
  const [authMethod, setAuthMethod] = React.useState<DbAuthMethod>("password");
  const [allowUnencrypted, setAllowUnencrypted] = React.useState(false);
  const [probeId, setProbeId] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [mode] = React.useState<DbMode>("backup");
  const [intervalMinutes, setIntervalMinutes] = React.useState(60);
  const [excluded, setExcluded] = React.useState<string[]>([]);
  const probe = useProbe(probeId);
  // A new opening starts clean (the mutations' reset functions are stable).
  const resetTest = test.reset;
  const resetCreate = create.reset;

  React.useEffect(() => {
    if (!open) {
      return;
    }
    setAddress(prefill?.address ?? "");
    setUser("");
    setPassword("");
    setExecutor(prefill?.endpointId ?? SERVER);
    setAuthMethod(prefill?.authMethod ?? "password");
    setAllowUnencrypted(false);
    setProbeId(null);
    setName("");
    setIntervalMinutes(60);
    setExcluded([]);
    resetTest();
    resetCreate();
  }, [open, prefill, resetTest, resetCreate]);

  const runner = runners.data?.runners.find((candidate) => candidate.endpointId === executor);
  const socketPossible = runner?.os === "linux";
  const result = probe.data ?? null;
  const waiting = result !== null && (result.status === "pending" || result.status === "running");
  const canSave =
    result !== null &&
    result.status === "done" &&
    result.engine !== null &&
    (result.login === "ok" || result.engine === "sqlite") &&
    result.error?.code !== "db_target_is_restow" &&
    (result.tls?.used === true || allowUnencrypted);

  const onAddressBlur = () => {
    const split = splitAddressCredentials(address);
    if (split.user !== null || split.password !== null) {
      setAddress(split.address);
      if (split.user !== null) setUser(split.user);
      if (split.password !== null) setPassword(split.password);
    }
  };

  const runTest = () => {
    const split = splitAddressCredentials(address);
    setProbeId(null);
    test.mutate(
      {
        address: split.address,
        user: authMethod === "password" ? user.trim() || split.user : null,
        password: authMethod === "password" ? password || split.password : null,
        authMethod,
        executor:
          executor === SERVER ? { kind: "server" } : { kind: "agent", endpointId: executor },
        allowUnencrypted,
      },
      { onSuccess: (answer) => setProbeId(answer.id) },
    );
  };

  const save = () => {
    if (!result) return;
    create.mutate(
      {
        probeId: result.id,
        name: name.trim() || null,
        user: authMethod === "password" ? user.trim() || null : null,
        password: authMethod === "password" ? password : null,
        allowUnencrypted,
        mode,
        schedule: { intervalMinutes },
        selection: { mode: "all", names: [], exclude: excluded },
      },
      {
        onSuccess: (connection) => {
          toast.success(t("add.saved", { name: connection.name }));
          onOpenChange(false);
          void navigate(linkTo(connectionTo(connection.id)));
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" data-slot="add-database">
        <DialogHeader>
          <DialogTitle>{t("add.title")}</DialogTitle>
          <DialogDescription>{t("add.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field id="db-address" label={t("add.address")} hint={t("add.addressHint")}>
            <Input
              id="db-address"
              value={address}
              autoComplete="off"
              spellCheck={false}
              placeholder="postgresql://db.example.com:5432"
              onChange={(event) => setAddress(event.target.value)}
              onBlur={onAddressBlur}
            />
          </Field>
          <Field id="db-executor" label={t("add.executor")} hint={t("add.executorHint")}>
            <NativeSelect
              id="db-executor"
              value={executor}
              onChange={(event) => {
                setExecutor(event.target.value);
                if (event.target.value === SERVER) setAuthMethod("password");
              }}
            >
              <option value={SERVER}>{t("add.executorServer")}</option>
              {(runners.data?.runners ?? []).map((candidate) => (
                <option key={candidate.endpointId} value={candidate.endpointId}>
                  {candidate.online
                    ? t("add.executorAgent", { hostname: candidate.hostname })
                    : t("add.executorAgentOffline", { hostname: candidate.hostname })}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {socketPossible ? (
            <div className="flex items-start gap-2">
              <Checkbox
                id="db-socket"
                checked={authMethod === "socket"}
                onCheckedChange={(checked) =>
                  setAuthMethod(checked === true ? "socket" : "password")
                }
              />
              <Label htmlFor="db-socket" className="flex flex-col items-start gap-0.5">
                <span>{t("add.socket")}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {t("add.socketHint")}
                </span>
              </Label>
            </div>
          ) : null}
          {authMethod === "password" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="db-user" label={t("add.user")} hint={t("add.userHint")}>
                <Input
                  id="db-user"
                  value={user}
                  autoComplete="off"
                  onChange={(event) => setUser(event.target.value)}
                />
              </Field>
              <Field id="db-password" label={t("add.password")}>
                <Input
                  id="db-password"
                  type="password"
                  value={password}
                  autoComplete="new-password"
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
            </div>
          ) : null}
          <div className="flex items-start gap-2">
            <Checkbox
              id="db-unencrypted"
              checked={allowUnencrypted}
              onCheckedChange={(checked) => setAllowUnencrypted(checked === true)}
            />
            <Label htmlFor="db-unencrypted" className="flex flex-col items-start gap-0.5">
              <span>{t("add.unencrypted")}</span>
              <span className="text-xs font-normal text-muted-foreground">
                {t("add.unencryptedHint")}
              </span>
            </Label>
          </div>
          <div className="flex justify-end">
            <Button
              variant="outline"
              onClick={runTest}
              disabled={address.trim() === "" || test.isPending || waiting}
              data-action="test-connection"
            >
              <PlugZap aria-hidden="true" />
              {t("add.test")}
            </Button>
          </div>
          {test.isError ? (
            <Alert variant="destructive">
              <AlertTitle>{t(problemKey(test.error))}</AlertTitle>
            </Alert>
          ) : null}
          {waiting ? (
            <Alert variant="info" data-slot="probe-waiting">
              <Hourglass aria-hidden="true" />
              <AlertTitle>{t("add.waiting")}</AlertTitle>
              <AlertDescription>{t("add.waitingHint")}</AlertDescription>
            </Alert>
          ) : null}
          {result?.status === "expired" ? (
            <Alert variant="warning">
              <AlertTitle>{t("codes.db_runner_offline")}</AlertTitle>
              <AlertDescription>{t("add.expired")}</AlertDescription>
            </Alert>
          ) : null}
          {result && result.status === "done" ? (
            <ProbeResult probe={result} format={format} />
          ) : null}
          {canSave ? (
            <div className="space-y-4 border-t pt-4" data-slot="save-options">
              <Field id="db-name" label={t("add.name")} hint={t("add.nameHint")}>
                <Input
                  id="db-name"
                  value={name}
                  placeholder={result?.address}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="db-mode" label={t("add.mode")} hint={t("add.modeHint")}>
                  <NativeSelect id="db-mode" value={mode} disabled>
                    <option value="backup">{t("modes.backup")}</option>
                    <option value="pitr">{t("modes.pitr")}</option>
                    <option value="warm_copy">{t("modes.warm_copy")}</option>
                  </NativeSelect>
                </Field>
                <Field id="db-interval" label={t("add.interval")}>
                  <NativeSelect
                    id="db-interval"
                    value={String(intervalMinutes)}
                    onChange={(event) => setIntervalMinutes(Number(event.target.value))}
                  >
                    {INTERVAL_CHOICES.map((minutes) => (
                      <option key={minutes} value={minutes}>
                        {t("intervals.minutes", { count: minutes })}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              </div>
              {result && result.databases.length > 0 ? (
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">{t("add.selection")}</legend>
                  {result.databases.map((database) => {
                    const id = `db-select-${database.name}`;
                    return (
                      <div key={database.name} className="flex items-center gap-2">
                        <Checkbox
                          id={id}
                          checked={!excluded.includes(database.name)}
                          onCheckedChange={(checked) =>
                            setExcluded((current) =>
                              checked === true
                                ? current.filter((entry) => entry !== database.name)
                                : [...current, database.name],
                            )
                          }
                        />
                        <Label htmlFor={id} className="font-normal">
                          {database.name}
                        </Label>
                      </div>
                    );
                  })}
                  <p className="text-xs text-muted-foreground">{t("add.selectionHint")}</p>
                </fieldset>
              ) : null}
              {create.isError ? (
                <Alert variant="destructive">
                  <AlertTitle>{t(problemKey(create.error))}</AlertTitle>
                </Alert>
              ) : null}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("add.cancel")}
          </Button>
          <Button
            onClick={save}
            disabled={!canSave || create.isPending}
            data-action="save-connection"
          >
            {t("add.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
