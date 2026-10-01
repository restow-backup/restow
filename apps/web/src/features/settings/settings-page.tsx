import {
  AppWindow,
  Download,
  Info,
  Mail,
  Settings,
  SlidersHorizontal,
  TriangleAlert,
} from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { usePageWidth } from "@/components/kit";
import { PageHeader } from "@/components/page-header";
import { RequireRole } from "@/components/require-role";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UpdatesSection } from "@/features/updates/updates-section";
import type { InstallationSettings } from "./api";
import { useInstallationSettings } from "./hooks";
import { MicrosoftAppSetup } from "./microsoft-app/microsoft-app-setup";
import { useSettingsSection } from "./paths";
import { SETTINGS_SECTIONS, type SettingsSection } from "./presenters";
import { AboutSection } from "./sections/about-section";
import { DangerSection } from "./sections/danger-section";
import { GeneralSection } from "./sections/general-section";
import { MailSection } from "./sections/mail-section";

/** Installation settings are the provider's; tenant admins manage their tenant elsewhere. */
export const SETTINGS_ROLES = ["provider_admin"] as const;

const SECTION_CLASS = "mt-2 data-[state=inactive]:hidden";

const SECTION_ICONS: Record<SettingsSection, React.ComponentType<{ className?: string }>> = {
  general: SlidersHorizontal,
  mail: Mail,
  microsoft365: AppWindow,
  updates: Download,
  about: Info,
  danger: TriangleAlert,
};

export function SettingsPage() {
  const { t } = useTranslation("settings");
  usePageWidth("readable");
  return (
    <div className="space-y-6">
      {/* Its own icon also where the menu entry License (About) is active. */}
      <PageHeader title={t("title")} description={t("subtitle")} icon={Settings} />
      <RequireRole roles={SETTINGS_ROLES} fallback={<SettingsForbidden />}>
        <SettingsContent />
      </RequireRole>
    </div>
  );
}

function SettingsContent() {
  const { t } = useTranslation("settings");
  const query = useInstallationSettings();

  if (query.isPending) {
    return <SettingsSkeleton />;
  }
  if (query.isError) {
    return (
      <ErrorState
        title={t("loadError")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  return <SettingsTabs settings={query.data} />;
}

function SettingsTabs({ settings }: { settings: InstallationSettings }) {
  const { t } = useTranslation("settings");
  const [section, setSection] = useSettingsSection();

  return (
    <Tabs value={section} onValueChange={(value) => setSection(value as SettingsSection)}>
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <TabsList aria-label={t("sections.label")}>
          {SETTINGS_SECTIONS.map((id) => {
            const Icon = SECTION_ICONS[id];
            return (
              <TabsTrigger key={id} value={id} className="gap-1.5">
                <Icon className="size-4" aria-hidden="true" />
                {t(`sections.${id}`)}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </div>
      {/* Sections stay mounted so unsaved edits survive switching tabs. */}
      <TabsContent value="general" forceMount className={SECTION_CLASS}>
        <GeneralSection settings={settings} />
      </TabsContent>
      <TabsContent value="mail" forceMount className={SECTION_CLASS}>
        <MailSection settings={settings} />
      </TabsContent>
      <TabsContent value="microsoft365" forceMount className={SECTION_CLASS}>
        <MicrosoftAppSetup variant="page" />
      </TabsContent>
      <TabsContent value="updates" forceMount className={SECTION_CLASS}>
        <UpdatesSection />
      </TabsContent>
      <TabsContent value="about" forceMount className={SECTION_CLASS}>
        <AboutSection />
      </TabsContent>
      <TabsContent value="danger" forceMount className={SECTION_CLASS}>
        <DangerSection settings={settings} />
      </TabsContent>
    </Tabs>
  );
}

function SettingsForbidden() {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  return (
    <Alert variant="warning">
      <TriangleAlert />
      <AlertTitle>{tc("errors.forbidden")}</AlertTitle>
      <AlertDescription>{t("forbidden")}</AlertDescription>
    </Alert>
  );
}

function SettingsSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-9 w-80 max-w-full" />
      {[0, 1].map((index) => (
        <Card key={index}>
          <CardHeader className="space-y-2">
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-4 w-2/3" />
          </CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-9 w-1/2" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
