import { MailSection } from "@/features/settings/sections/mail-section";
import { ServerSection } from "@/features/settings/sections/server-section";

import { SettingsLoader } from "./settings-loader";

/** The sections that edit the installation settings row: it loads once and both read it. */

export function ServerSectionPage() {
  return <SettingsLoader>{(settings) => <ServerSection settings={settings} />}</SettingsLoader>;
}

export function MailSectionPage() {
  return <SettingsLoader>{(settings) => <MailSection settings={settings} />}</SettingsLoader>;
}
