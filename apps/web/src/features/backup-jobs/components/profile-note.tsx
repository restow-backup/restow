import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { MachineFolders } from "../api.js";

/**
 * The profiles of a job's Linux machines and what their default folders cover (#59): a client's
 * only the user folders and the configuration, a server's also where applications keep their
 * data. Says too which machines got the server profile at enrollment although they were added
 * as clients (a container, a VM without a desktop). Nothing without Linux machines.
 */
export function ProfileNote({ machines }: { machines: readonly MachineFolders[] }) {
  const { t } = useTranslation("backupjobs");
  const linux = machines.filter((machine) => machine.os === "linux");
  if (linux.length === 0) {
    return null;
  }
  const profiles = (["client", "server"] as const)
    .map((profile) => ({
      profile,
      names: linux.filter((machine) => machine.profile === profile).map((machine) => machine.name),
    }))
    .filter((entry) => entry.names.length > 0);
  const detected = linux.filter((machine) => machine.profileDetection !== null);
  const mixed = profiles.length > 1;
  return (
    <div className="space-y-1 text-xs text-muted-foreground" data-slot="profile-note">
      {profiles.map((entry) => (
        <p key={entry.profile} className="flex items-start gap-2" data-profile={entry.profile}>
          <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>
            <strong className="font-medium text-foreground">
              {mixed
                ? t(`editor.folders.profile.labelMachines.${entry.profile}`, {
                    machines: entry.names.join(", "),
                  })
                : t(`editor.folders.profile.label.${entry.profile}`)}
            </strong>{" "}
            {t(`editor.folders.profile.${entry.profile}`)}
          </span>
        </p>
      ))}
      {detected.length > 0 ? (
        <p className="pl-5.5" data-slot="profile-detected">
          {t("editor.folders.profile.detected", {
            machines: detected.map((machine) => machine.name).join(", "),
            count: detected.length,
          })}
        </p>
      ) : null}
    </div>
  );
}
