import { Server } from "lucide-react";
import { useTranslation } from "react-i18next";

import { SoonBadge, SoonSuffix } from "@/components/layout/soon-badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * "Connect Proxmox", next to the buttons that add an agent: a teaser for a
 * connection that comes after this release, in every edition. It starts no
 * flow. The button opens a small popover that says what is coming (a popover
 * rather than a tooltip, so that a touch screen can read it too); it is a real
 * button, so the keyboard reaches it and Escape closes the popover. The "Soon"
 * badge is the one the menu uses for entries whose feature does not exist yet.
 */
export function ProxmoxTeaser() {
  const { t } = useTranslation("endpoints");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="outline" data-slot="proxmox-teaser">
          <Server aria-hidden="true" />
          {t("proxmox.label")}
          <SoonBadge />
          <SoonSuffix />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 text-sm" data-slot="proxmox-teaser-content">
        <p className="font-medium">{t("proxmox.title")}</p>
        <p className="mt-1.5 text-muted-foreground">{t("proxmox.description")}</p>
      </PopoverContent>
    </Popover>
  );
}
