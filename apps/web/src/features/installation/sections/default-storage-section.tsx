import { Info, PlugZap, Save, TriangleAlert, Undo2 } from "lucide-react";
import * as React from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { ErrorState } from "@/components/error-state";
import { ConfirmDialog } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { LocationFields } from "@/features/storage/components/location-fields";
import { ObjectLockLine } from "@/features/storage/components/object-lock-line";
import { ProbeResult } from "@/features/storage/components/probe-result";
import { ToneLine } from "@/features/storage/components/status";
import {
  type TargetFormValues,
  emptyTargetForm,
  formFieldOf,
  presetForEndpoint,
  targetFormSchema,
  toLocationInput,
} from "@/features/storage/forms";
import { problemFields, storageErrorKey } from "@/features/storage/presenters";
import type { ProbeResult as ProbeResultDto } from "@/features/storage/types";
import { ApiError } from "@/lib/api";
import { zodResolver } from "@/lib/form";
import { formatDateTime, formatRelative } from "@/lib/format";
import { isRecentSignInRequired } from "@/lib/recent-sign-in";

import { AccessNote, ReadOnlyGroup, useInstallationAccess } from "../access";
import { useWordingScope } from "../scope";
import {
  DEFAULT_STORAGE_PROBLEMS,
  type DefaultStorageBlocker,
  type DefaultStorageLastTest,
  type DefaultStorageView,
  blockersOf,
  refusedProbeOf,
  useDefaultStorage,
  useRemoveDefaultStorage,
  useSaveDefaultStorage,
  useTestDefaultStorage,
} from "./default-storage-api";

type Kind = "local" | "s3";

/**
 * Installation, Default storage: where the installation keeps data for every
 * tenant that has no storage target of its own. A provider owner saves it here
 * (a directory on the server or S3-compatible object storage, the same fields
 * as a tenant's storage target); without a saved default, the server's
 * environment applies (STORAGE_TARGET, STORAGE_LOCAL_PATH, S3_*). The page says
 * which one applies, refuses to point the default elsewhere while tenants keep
 * data on it (and names them), and tests it. A passed test is a state, not
 * proof of a restore: it is shown in the neutral tone.
 */
export function DefaultStorageSection() {
  const { t } = useTranslation("installation");
  const query = useDefaultStorage();
  if (query.isPending) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <ErrorState
        title={t("defaultStorage.loadError")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  return <DefaultStorageContent view={query.data} />;
}

export function DefaultStorageContent({ view }: { view: DefaultStorageView }) {
  const access = useInstallationAccess();
  return (
    <div className="space-y-6">
      <AccessNote block={access.operate} level="administrator" />
      <DefaultCard view={view} />
      <ConfigureCard view={view} closed={access.change} />
      {view.configured ? (
        <ReadOnlyGroup closed={access.operate !== null}>
          <TestCard view={view} />
        </ReadOnlyGroup>
      ) : null}
    </div>
  );
}

function DefaultCard({ view }: { view: DefaultStorageView }) {
  const { t, i18n } = useTranslation("installation");
  const scope = useWordingScope();
  const language = i18n.resolvedLanguage ?? i18n.language;

  if (!view.configured || view.kind === null) {
    const saved = view.source === "database";
    return (
      <Alert variant="destructive" data-slot="default-storage-misconfigured">
        <TriangleAlert />
        <AlertTitle>
          {t(
            saved
              ? "defaultStorage.misconfigured.savedTitle"
              : "defaultStorage.misconfigured.title",
          )}
        </AlertTitle>
        <AlertDescription>
          {t(
            saved
              ? "defaultStorage.misconfigured.savedDescription"
              : "defaultStorage.misconfigured.description",
          )}
        </AlertDescription>
      </Alert>
    );
  }

  const { tenants } = view;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("defaultStorage.card.title")}</CardTitle>
        <CardDescription>{t("defaultStorage.card.description", { scope })}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
          <Fact label={t("defaultStorage.type")}>{t(`defaultStorage.kind.${view.kind}`)}</Fact>
          <Fact label={t("defaultStorage.usage.label")}>
            {scope === "organisation"
              ? t(
                  tenants.usingDefault > 0
                    ? "defaultStorage.usage.organisationYes"
                    : "defaultStorage.usage.organisationNo",
                )
              : tenants.usingDefault > 0
                ? t("defaultStorage.usage.some", {
                    using: tenants.usingDefault,
                    total: tenants.total,
                  })
                : t("defaultStorage.usage.none")}
          </Fact>
          <Fact label={t("defaultStorage.location")}>
            <code className="break-all font-mono text-xs">{view.location}</code>
          </Fact>
          <Fact label={t("defaultStorage.copy")}>
            {view.copyLocation ? (
              <code className="break-all font-mono text-xs">{view.copyLocation}</code>
            ) : (
              <span className="text-muted-foreground">{t("defaultStorage.noCopy")}</span>
            )}
          </Fact>
          <Fact label={t("defaultStorage.source.label")}>
            <span data-slot="default-storage-source" data-source={view.source}>
              {view.saved
                ? t("defaultStorage.source.database", {
                    who: view.saved.updatedBy,
                    when: formatDateTime(view.saved.updatedAt, language) ?? view.saved.updatedAt,
                  })
                : t("defaultStorage.source.environment")}
            </span>
          </Fact>
        </dl>
        {view.saved && view.environment.configured && view.environment.location ? (
          <Alert variant="info" data-slot="default-storage-override">
            <Info />
            <AlertTitle>{t("defaultStorage.override.title")}</AlertTitle>
            <AlertDescription>
              <p>{t("defaultStorage.override.description")}</p>
              <code className="block max-w-full break-all font-mono text-xs">
                {view.environment.location}
              </code>
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The tenants that keep the default from moving, with why. */
function Blockers({ blockers }: { blockers: DefaultStorageBlocker[] }) {
  const { t } = useTranslation("installation");
  const scope = useWordingScope();
  return (
    <Alert variant="warning" data-slot="default-storage-blockers">
      <TriangleAlert />
      <AlertTitle>{t("defaultStorage.blockers.title", { scope })}</AlertTitle>
      <AlertDescription>
        <p>{t("defaultStorage.blockers.description", { scope })}</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {blockers.map((blocker) => (
            <li key={blocker.tenantId}>
              <span className="font-medium text-foreground">{blocker.tenantName}</span>
              {": "}
              {blocker.reasons
                .map((reason) => t(`defaultStorage.blockers.reasons.${reason}`))
                .join(", ")}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

/** The form's starting values: the saved default, or an empty form of the kind in use. */
function initialValues(view: DefaultStorageView, kind: Kind): TargetFormValues {
  const empty = { ...emptyTargetForm("primary"), name: "default" };
  const saved = view.saved?.kind === kind ? view.saved : null;
  if (kind === "local") {
    return { ...empty, basePath: saved?.local?.basePath ?? "" };
  }
  const s3 = saved?.s3;
  if (!s3) {
    return empty;
  }
  return {
    ...empty,
    preset: presetForEndpoint(s3.endpoint),
    bucket: s3.bucket,
    prefix: s3.prefix ?? "",
    endpoint: s3.endpoint ?? "",
    region: s3.region,
    forcePathStyle: s3.forcePathStyle,
  };
}

/** Message of an error the form cannot put on a field. */
function changeErrorKey(error: unknown): string {
  const type = error instanceof ApiError ? error.problem?.type : undefined;
  switch (type) {
    case DEFAULT_STORAGE_PROBLEMS.environmentInvalid:
      return "installation:defaultStorage.errors.environmentInvalid";
    case DEFAULT_STORAGE_PROBLEMS.unreachable:
      return "installation:defaultStorage.errors.unreachable";
    case DEFAULT_STORAGE_PROBLEMS.misconfigured:
      return "installation:defaultStorage.errors.misconfigured";
    case DEFAULT_STORAGE_PROBLEMS.inUse:
      return "installation:defaultStorage.errors.inUse";
    default:
      return storageErrorKey(error);
  }
}

/**
 * Save the default, or go back to the environment. Owner only; the API asks
 * for a recent sign-in (the identity dialog repeats the action), probes the
 * location before saving, and refuses to move it while tenants keep data on it.
 */
function ConfigureCard({
  view,
  closed,
}: {
  view: DefaultStorageView;
  closed: "demo" | "role" | null;
}) {
  const { t } = useTranslation("installation");
  const { t: tc } = useTranslation();
  const scope = useWordingScope();
  const [kind, setKind] = React.useState<Kind>(view.saved?.kind ?? view.kind ?? "local");
  const [removing, setRemoving] = React.useState(false);
  const remove = useRemoveDefaultStorage();
  const identity = useConfirmIdentity();
  const [removeError, setRemoveError] = React.useState<unknown>(null);

  const runRemove = () => {
    setRemoveError(null);
    remove.mutate(undefined, {
      onSuccess: () => {
        setRemoving(false);
        toast.success(t("defaultStorage.configure.removed"));
      },
      onError: (error) => {
        if (isRecentSignInRequired(error)) {
          setRemoving(false);
          identity.ask(runRemove);
          return;
        }
        setRemoveError(error);
      },
    });
  };

  const blockers = view.blockers;
  return (
    <Card data-slot="default-storage-configure">
      <CardHeader>
        <CardTitle>{t("defaultStorage.configure.title")}</CardTitle>
        <CardDescription>{t("defaultStorage.configure.description", { scope })}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <AccessNote block={closed} level="owner" />
        {blockers.length > 0 ? <Blockers blockers={blockers} /> : null}
        <ReadOnlyGroup closed={closed !== null}>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label id="default-storage-kind-label">{t("defaultStorage.type")}</Label>
              <RadioGroup
                value={kind}
                onValueChange={(next) => setKind(next as Kind)}
                aria-labelledby="default-storage-kind-label"
                className="gap-2 sm:flex sm:gap-6"
              >
                {(["local", "s3"] as const).map((option) => (
                  <div key={option} className="flex items-center gap-2">
                    <RadioGroupItem value={option} id={`default-storage-kind-${option}`} />
                    <Label
                      htmlFor={`default-storage-kind-${option}`}
                      className="cursor-pointer font-normal"
                    >
                      {t(`defaultStorage.kind.${option}`)}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </div>
            {/* Remounted per kind: each kind validates its own fields. */}
            <LocationForm key={kind} kind={kind} view={view} onRecentSignIn={identity.ask} />
          </div>
        </ReadOnlyGroup>
      </CardContent>
      {view.saved && view.environment.configured ? (
        <CardFooter className="border-t border-border [.border-t]:pt-4">
          <ReadOnlyGroup closed={closed !== null}>
            <Button variant="outline" size="sm" onClick={() => setRemoving(true)}>
              <Undo2 />
              {t("defaultStorage.configure.remove")}
            </Button>
          </ReadOnlyGroup>
        </CardFooter>
      ) : null}
      <ConfirmDialog
        open={removing}
        onOpenChange={(next) => {
          if (!next) {
            setRemoveError(null);
          }
          setRemoving(next);
        }}
        title={t("defaultStorage.configure.removeTitle")}
        description={
          <>
            <p>{t("defaultStorage.configure.removeDescription")}</p>
            {view.environment.location ? (
              <code className="block break-all font-mono text-xs">{view.environment.location}</code>
            ) : null}
          </>
        }
        confirmLabel={t("defaultStorage.configure.removeConfirm")}
        pending={remove.isPending}
        error={
          removeError ? (
            <div className="space-y-2">
              <p>{tc(changeErrorKey(removeError))}</p>
              {blockersOf(removeError)?.length ? (
                <Blockers blockers={blockersOf(removeError) ?? []} />
              ) : null}
            </div>
          ) : undefined
        }
        onConfirm={runRemove}
      />
      {identity.dialog}
    </Card>
  );
}

function LocationForm({
  kind,
  view,
  onRecentSignIn,
}: {
  kind: Kind;
  view: DefaultStorageView;
  onRecentSignIn: (retry: () => void) => void;
}) {
  const { t } = useTranslation("installation");
  const { t: tc } = useTranslation();
  const stored = view.saved?.kind === kind ? view.saved : null;
  const form = useForm<TargetFormValues>({
    resolver: zodResolver(targetFormSchema(kind, stored)),
    defaultValues: initialValues(view, kind),
  });
  const save = useSaveDefaultStorage();
  const [error, setError] = React.useState<unknown>(null);
  const [probe, setProbe] = React.useState<ProbeResultDto | null>(null);

  const applyFieldProblems = (cause: unknown): boolean => {
    let matched = false;
    for (const problem of problemFields(cause)) {
      const field = formFieldOf(problem.field);
      if (field) {
        form.setError(field, { message: problem.reason }, { shouldFocus: !matched });
        matched = true;
      }
    }
    return matched;
  };

  const submit = (values: TargetFormValues) => {
    setError(null);
    setProbe(null);
    save.mutate(toLocationInput(kind, values), {
      onSuccess: (result) => {
        setProbe(result.probe);
        form.reset({ ...values, accessKeyId: "", secretAccessKey: "" });
        toast.success(t("defaultStorage.configure.saved"));
      },
      onError: (cause) => {
        if (isRecentSignInRequired(cause)) {
          onRecentSignIn(() => submit(values));
          return;
        }
        setProbe(refusedProbeOf(cause));
        if (!applyFieldProblems(cause)) {
          setError(cause);
        }
      },
    });
  };

  const blockers = blockersOf(error);
  return (
    <form
      id="default-storage-form"
      onSubmit={form.handleSubmit(submit)}
      noValidate
      className="space-y-4"
    >
      <LocationFields form={form} kind={kind} stored={stored} />
      <p className="text-xs text-muted-foreground">
        {t(`defaultStorage.configure.testHint.${kind}`)}
      </p>
      {probe ? (
        <div className="space-y-2" data-slot="default-storage-probe">
          <ProbeResult probe={probe} compact />
          {kind === "s3" && save.data?.objectLock ? (
            <ObjectLockLine kind={kind} capability={save.data.objectLock} />
          ) : null}
        </div>
      ) : null}
      {blockers && blockers.length > 0 ? <Blockers blockers={blockers} /> : null}
      {error && !blockers ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{tc(changeErrorKey(error))}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" loading={save.isPending}>
        {save.isPending ? null : <Save />}
        {t("defaultStorage.configure.save")}
      </Button>
    </form>
  );
}

function TestCard({ view }: { view: DefaultStorageView }) {
  const { t } = useTranslation("installation");
  const { t: tc } = useTranslation();
  const test = useTestDefaultStorage();
  const kind = view.kind ?? "local";
  const problem = test.error instanceof ApiError ? test.error.problem?.type : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("defaultStorage.test.title")}</CardTitle>
        <CardDescription>{t("defaultStorage.test.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {test.data ? (
          <div className="space-y-3">
            <ProbeResult probe={test.data.probe} />
            <ObjectLockLine kind={kind} capability={test.data.objectLock} />
          </div>
        ) : test.error ? (
          <ToneLine tone="destructive">
            {problem === DEFAULT_STORAGE_PROBLEMS.misconfigured
              ? t("defaultStorage.errors.misconfigured")
              : tc(storageErrorKey(test.error))}
          </ToneLine>
        ) : view.lastTest ? (
          <LastTest test={view.lastTest} />
        ) : (
          <ToneLine tone="neutral">{t("defaultStorage.test.never")}</ToneLine>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => test.mutate()}
          loading={test.isPending}
          disabled={test.isPending}
        >
          {test.isPending ? null : <PlugZap />}
          {test.data || view.lastTest
            ? t("defaultStorage.test.again")
            : t("defaultStorage.test.action")}
        </Button>
      </CardContent>
    </Card>
  );
}

/** The last test somebody ran from this page, as the installation's audit chain recorded it. */
function LastTest({ test }: { test: DefaultStorageLastTest }) {
  const { t, i18n } = useTranslation("installation");
  const { t: ts } = useTranslation("storage");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const when = formatRelative(test.testedAt, language) ?? test.testedAt;
  const step = test.failedStep
    ? ts(`health.steps.${test.failedStep}`, { defaultValue: test.failedStep })
    : null;
  return (
    <div className="space-y-1" data-slot="last-test">
      <ToneLine tone={test.ok ? "ok" : "destructive"}>
        <span className="font-medium" title={formatDateTime(test.testedAt, language) ?? undefined}>
          {t(test.ok ? "defaultStorage.test.passed" : "defaultStorage.test.failed", {
            when,
            who: test.testedBy,
          })}
        </span>
        {!test.ok && step ? (
          <span className="text-muted-foreground">
            {" "}
            {t("defaultStorage.test.failedAt", { step })}
          </span>
        ) : null}
      </ToneLine>
    </div>
  );
}
