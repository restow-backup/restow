import {
  Ban,
  FileArchive,
  FileQuestion,
  type LucideIcon,
  Mail,
  MailOpen,
  Package,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { formatKey } from "../presenters";
import type { MailFileFormat } from "../types";

const FORMAT_ICON: Record<MailFileFormat, LucideIcon> = {
  eml: Mail,
  msg: MailOpen,
  mbox: Package,
  zip: FileArchive,
  pst: Ban,
  unknown: FileQuestion,
};

/** The icon of a detected format, for file lists. */
export function FormatIcon({
  format,
  className,
}: { format: MailFileFormat | null; className?: string }) {
  const Icon = FORMAT_ICON[format ?? "unknown"];
  return <Icon aria-hidden="true" className={className} />;
}

/** The detected format of a file as a badge; PST and unknown files are marked as not importable. */
export function FormatBadge({ format }: { format: MailFileFormat | null }) {
  const { t } = useTranslation("imports");
  if (format === null) {
    return null;
  }
  const variant = format === "pst" ? "warning" : format === "unknown" ? "muted" : "outline";
  return (
    <Badge variant={variant}>
      <FormatIcon format={format} />
      {t(formatKey(format))}
    </Badge>
  );
}
