import { useQueryClient } from "@tanstack/react-query";
import { CircleCheck, HardDrive, Info, LoaderCircle, Network } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { Field, messageId } from "@/components/forms/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { providerMay } from "@/lib/provider-role";
import { isRecentSignInRequired } from "@/lib/recent-sign-in";
import { useSession } from "@/lib/session";

import "../i18n";
import { useInstallationAccess } from "../access";
import {
  type MountSpec,
  type MountsView,
  NFS_VERSIONS,
  type NfsVersion,
  mountsKeys,
  useAddMountWhenIdle,
  useMounts,
  useTestMount,
  validMountName,
} from "./mounts-api";
import {
  ErrorAlert,
  OperationCard,
  PendingCard,
  TestOutcome,
  UnavailableCard,
} from "./mounts-section";
import {
  type NfsAddress,
  deriveMountName,
  existingMountFor,
  formatNfsAddress,
  joinPath,
  parseNfsAddress,
  validSubfolder,
} from "./nfs-address";

/**
 * The shortcut from the storage form to Installation > Network shares (docs/MOUNTS.md,
 * "From the storage form"): when the path field of a storage location of the kind
 * "directory" holds an NFS address (`nas.local:/volume1/restow`, `nfs://10.0.0.5/export`),
 * the form offers to mount it through the mounter and then fills in the path the share
 * gets in the application, so the admin only saves the storage location.
 *
 * Nothing of the mounter's flow is repeated here: the same requests (test, add with
 * "apply when idle"), the same operation report, the same identity check and the same
 * "mounter not running" card as the Network shares section. Only the provider owner may
 * mount; everyone else is told whom to ask and what to tell them. A share that is
 * mounted already is offered as it is.
 */
export function NfsPathOffer({ value, onUse }: { value: string; onUse: (path: string) => void }) {
  const { t } = useTranslation("installation");
  const address = React.useMemo(() => parseNfsAddress(value), [value]);
  const [filled, setFilled] = React.useState<{ path: string; name: string } | null>(null);

  if (filled && value.trim() === filled.path) {
    return (
      <Alert variant="info" data-slot="nfs-offer-done">
        <CircleCheck />
        <AlertDescription>{t("mounts.storageOffer.done", { name: filled.name })}</AlertDescription>
      </Alert>
    );
  }
  if (!address) {
    return null;
  }
  return (
    <NfsOffer
      key={formatNfsAddress(address)}
      address={address}
      onMounted={(path, name) => {
        setFilled({ path, name });
        onUse(path);
      }}
      onUse={onUse}
    />
  );
}

interface Started {
  name: string;
  subfolder: string;
  /** The operation the mounter reported before this add, which is not this add's. */
  previousOperationId: string | null;
}

function NfsOffer({
  address,
  onMounted,
  onUse,
}: {
  address: NfsAddress;
  onMounted: (path: string, name: string) => void;
  onUse: (path: string) => void;
}) {
  const { t } = useTranslation("installation");
  const session = useSession();
  const access = useInstallationAccess();
  const mayRead = providerMay(session, "read_only", { everyTenant: true });
  const mayAdd = access.change === null && mayRead;
  const query = useMounts(mayRead);
  const view = query.data;
  const existing = view?.state ? existingMountFor(address, view.state.mounts) : null;
  const [started, setStarted] = React.useState<Started | null>(null);
  const refetchQuery = query.refetch;
  const refetch = React.useCallback(() => void refetchQuery(), [refetchQuery]);

  let body: React.ReactNode;
  if (started && view) {
    body = (
      <Progress
        view={view}
        started={started}
        refetch={refetch}
        onMounted={onMounted}
        onReset={() => setStarted(null)}
      />
    );
  } else if (existing) {
    body = (
      <div className="space-y-2" data-slot="nfs-offer-existing">
        <p className="text-sm">
          {t("mounts.storageOffer.existing", { name: existing.entry.mount.name })}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="font-mono text-xs"
          onClick={() => onUse(existing.path)}
        >
          <HardDrive aria-hidden="true" />
          {t("mounts.storageHint.use", { path: existing.path })}
        </Button>
      </div>
    );
  } else if (access.change === "demo") {
    body = <p className="text-sm text-muted-foreground">{t("mounts.unavailable.demo")}</p>;
  } else if (!mayAdd) {
    body = (
      <p className="text-sm" data-slot="nfs-offer-ask-owner">
        {t("mounts.storageOffer.askOwner", { server: address.server, export: address.export })}
      </p>
    );
  } else if (!view) {
    body = (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        {t("mounts.storageOffer.loading")}
      </p>
    );
  } else if (!view.available || !view.state) {
    body = <UnavailableCard view={view} />;
  } else if (view.pending && !view.pending.failure) {
    // Another share waits for running jobs; only one may wait at a time.
    body = <PendingCard pending={view.pending} closed={false} />;
  } else {
    body = <MountForm address={address} view={view} onStarted={(next) => setStarted(next)} />;
  }

  return (
    <div className="space-y-3 rounded-md border p-3" data-slot="nfs-offer">
      <p className="flex items-start gap-2 text-sm">
        <Network className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span>
          {t("mounts.storageOffer.detected")}{" "}
          <code className="break-all font-mono text-xs">{formatNfsAddress(address)}</code>
        </span>
      </p>
      {body}
    </div>
  );
}

function MountForm({
  address,
  view,
  onStarted,
}: {
  address: NfsAddress;
  view: MountsView;
  onStarted: (started: Started) => void;
}) {
  const { t } = useTranslation("installation");
  const state = view.state;
  const taken = state?.mounts.map((entry) => entry.mount.name) ?? [];
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState(() => deriveMountName(address, taken));
  const [subfolder, setSubfolder] = React.useState("");
  const [nfsVersion, setNfsVersion] = React.useState<NfsVersion>("4.1");
  const [touched, setTouched] = React.useState(false);
  const add = useAddMountWhenIdle();
  const test = useTestMount();
  const identity = useConfirmIdentity();

  const invalid = { name: !validMountName(name), subfolder: !validSubfolder(subfolder) };
  const valid = !invalid.name && !invalid.subfolder;
  const blocked = !state?.capabilities.ready || state?.operation?.status === "running";
  const spec: MountSpec = {
    protocol: "nfs",
    name: name.trim(),
    server: address.server,
    export: address.export,
    nfsVersion,
    readOnly: false,
  };

  if (!open) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">{t("mounts.storageOffer.description")}</p>
        <Button type="button" size="sm" onClick={() => setOpen(true)} data-slot="nfs-offer-open">
          <HardDrive aria-hidden="true" />
          {t("mounts.storageOffer.offer")}
        </Button>
      </div>
    );
  }

  const submit = () => {
    setTouched(true);
    if (!valid || add.isPending || blocked) {
      return;
    }
    const previousOperationId = state?.operation?.id ?? null;
    add.mutate(spec, {
      onSuccess: () =>
        onStarted({ name: spec.name, subfolder: subfolder.trim(), previousOperationId }),
      onError: (error) => {
        if (isRecentSignInRequired(error)) {
          identity.ask(submit);
        }
      },
    });
  };
  const message = (field: keyof typeof invalid) =>
    touched && invalid[field]
      ? t(field === "name" ? "mounts.dialog.invalid.name" : "mounts.storageOffer.invalidSubfolder")
      : undefined;
  // Enter in these fields must not save the storage location around them.
  const noSubmit = (event: React.KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
    }
  };
  const path = joinPath(`${view.mountRoot}/${name.trim() || "<name>"}`, subfolder);

  return (
    <div className="space-y-3" data-slot="nfs-offer-form">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="nfs-offer-name" label={t("mounts.dialog.name")} error={message("name")}>
          <Input
            id="nfs-offer-name"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            value={name}
            maxLength={32}
            aria-invalid={message("name") !== undefined}
            aria-describedby={messageId("nfs-offer-name")}
            onKeyDown={noSubmit}
            onChange={(event) => {
              setName(event.target.value.toLowerCase());
              test.reset();
            }}
          />
        </Field>
        <div className="space-y-1.5">
          <Label htmlFor="nfs-offer-version">{t("mounts.dialog.version")}</Label>
          <Select
            value={nfsVersion}
            onValueChange={(next) => {
              setNfsVersion(next as NfsVersion);
              test.reset();
            }}
          >
            <SelectTrigger id="nfs-offer-version" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {NFS_VERSIONS.map((version) => (
                <SelectItem key={version} value={version}>
                  NFS {version}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <Field
        id="nfs-offer-subfolder"
        label={t("mounts.storageOffer.subfolder")}
        error={message("subfolder")}
        hint={t("mounts.storageOffer.subfolderHint", { path })}
      >
        <Input
          id="nfs-offer-subfolder"
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          value={subfolder}
          aria-invalid={message("subfolder") !== undefined}
          aria-describedby={messageId("nfs-offer-subfolder")}
          onKeyDown={noSubmit}
          onChange={(event) => setSubfolder(event.target.value)}
        />
      </Field>
      <Alert variant="info" data-slot="nfs-offer-restart">
        <Info />
        <AlertDescription>{t("mounts.storageOffer.restart")}</AlertDescription>
      </Alert>
      {blocked ? (
        <p className="text-sm text-muted-foreground">{t("mounts.storageOffer.blocked")}</p>
      ) : null}
      {test.data ? <TestOutcome result={test.data} /> : null}
      {test.isError ? <ErrorAlert error={test.error} /> : null}
      {add.isError && !isRecentSignInRequired(add.error) ? <ErrorAlert error={add.error} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={test.isPending}
          disabled={add.isPending}
          onClick={() => {
            setTouched(true);
            if (valid) {
              test.mutate({ mount: spec });
            }
          }}
        >
          {test.isPending ? t("mounts.dialog.testing") : t("mounts.dialog.test")}
        </Button>
        <Button
          type="button"
          size="sm"
          loading={add.isPending}
          disabled={test.isPending || blocked}
          onClick={submit}
        >
          {t("mounts.storageOffer.submit")}
        </Button>
      </div>
      {identity.dialog}
    </div>
  );
}

/** How often the form looks at the add it started (the api may be restarting meanwhile). */
const FOLLOW_MS = 3_000;

function Progress({
  view,
  started,
  refetch,
  onMounted,
  onReset,
}: {
  view: MountsView;
  started: Started;
  refetch: () => void;
  onMounted: (path: string, name: string) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation("installation");
  const queryClient = useQueryClient();
  const pending = view.pending?.mount.name === started.name ? view.pending : null;
  const operation =
    view.state?.operation &&
    view.state.operation.kind === "add" &&
    view.state.operation.name === started.name &&
    view.state.operation.id !== started.previousOperationId
      ? view.state.operation
      : null;
  const succeeded = operation?.status === "succeeded";
  const finished = succeeded || (operation !== null && operation.status !== "running");
  const failedWhileWaiting = pending?.failure != null;

  React.useEffect(() => {
    if (finished || failedWhileWaiting) {
      return;
    }
    const timer = setInterval(refetch, FOLLOW_MS);
    return () => clearInterval(timer);
  }, [finished, failedWhileWaiting, refetch]);

  const done = React.useRef(false);
  React.useEffect(() => {
    if (succeeded && !done.current) {
      done.current = true;
      void queryClient.invalidateQueries({ queryKey: mountsKeys.paths });
      onMounted(joinPath(`${view.mountRoot}/${started.name}`, started.subfolder), started.name);
    }
  }, [succeeded, onMounted, queryClient, started, view.mountRoot]);

  if (pending) {
    return (
      <div className="space-y-2" data-slot="nfs-offer-waiting">
        {pending.failure ? null : (
          <p className="text-sm font-medium">{t("mounts.storageOffer.waitingTitle")}</p>
        )}
        <PendingCard pending={pending} closed={false} onCancelled={onReset} />
      </div>
    );
  }
  if (operation) {
    return (
      <div className="space-y-2" data-slot="nfs-offer-progress">
        <OperationCard operation={operation} />
        {operation.status !== "running" && !succeeded ? (
          <Button type="button" variant="outline" size="sm" onClick={onReset}>
            {t("mounts.storageOffer.retry")}
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <p
      className="flex items-center gap-2 text-sm text-muted-foreground"
      data-slot="nfs-offer-starting"
    >
      <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
      {t("mounts.storageOffer.starting")}
    </p>
  );
}
