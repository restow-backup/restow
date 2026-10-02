import { PlugZap, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ObjectLockLine } from "@/features/storage/components/object-lock-line";
import { ProbeResult } from "@/features/storage/components/probe-result";
import { ToneLine } from "@/features/storage/components/status";
import { storageErrorKey } from "@/features/storage/presenters";
import { ApiError } from "@/lib/api";
import { formatDateTime, formatRelative } from "@/lib/format";

import { AccessNote, ReadOnlyGroup, useInstallationAccess } from "../access";
import { useWordingScope } from "../scope";
import {
  type DefaultStorageLastTest,
  type DefaultStorageView,
  useDefaultStorage,
  useTestDefaultStorage,
} from "./default-storage-api";

/** The problem type of a test run against an environment that describes no usable storage. */
const MISCONFIGURED_PROBLEM = "urn:restow:problem:settings-default-storage-misconfigured";

/**
 * Installation, Default storage: where the installation keeps data for every
 * tenant that has no storage target of its own. It comes from the server's
 * environment (STORAGE_TARGET, STORAGE_LOCAL_PATH, S3_*), so the page states it
 * and tests it; it does not edit it. A passed test is a state, not proof of a
 * restore: it is shown in the neutral tone.
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
      {view.configured ? (
        <ReadOnlyGroup closed={access.operate !== null}>
          <TestCard view={view} />
        </ReadOnlyGroup>
      ) : null}
    </div>
  );
}

function DefaultCard({ view }: { view: DefaultStorageView }) {
  const { t } = useTranslation("installation");
  const scope = useWordingScope();

  if (!view.configured || view.kind === null) {
    return (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>{t("defaultStorage.misconfigured.title")}</AlertTitle>
        <AlertDescription>{t("defaultStorage.misconfigured.description")}</AlertDescription>
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
      <CardContent>
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
        </dl>
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
            {problem === MISCONFIGURED_PROBLEM
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
