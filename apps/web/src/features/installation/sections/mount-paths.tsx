import { HardDrive } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { providerMay } from "@/lib/provider-role";
import { useSession } from "@/lib/session";

import "../i18n";
import { useMountPaths } from "./mounts-api";

/**
 * The network shares the mounter added (Installation > Mounts), offered as paths
 * under the path field of a storage location of the kind "directory": one click
 * puts the share's path into the field. Only provider admins with every tenant may
 * read them (and only provider admins may configure a directory); for everyone else,
 * without the mounter or without shares, it renders nothing.
 */
export function MountPathHints({ onPick }: { onPick: (path: string) => void }) {
  const { t } = useTranslation("installation");
  const session = useSession();
  const enabled = providerMay(session, "read_only", { everyTenant: true });
  const query = useMountPaths(enabled);
  const paths = query.data?.paths ?? [];
  if (!enabled || paths.length === 0) {
    return null;
  }
  return (
    <div className="space-y-1.5" data-slot="mount-path-hints">
      <p className="text-xs text-muted-foreground">{t("mounts.storageHint.label")}</p>
      <div className="flex flex-wrap gap-2">
        {paths.map((path) => (
          <Button
            key={path}
            type="button"
            variant="outline"
            size="sm"
            className="font-mono text-xs"
            aria-label={t("mounts.storageHint.use", { path })}
            onClick={() => onPick(path)}
          >
            <HardDrive aria-hidden="true" />
            {path}
          </Button>
        ))}
      </div>
    </div>
  );
}
