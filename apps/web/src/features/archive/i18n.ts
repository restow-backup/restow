import archiveDe from "@restow/i18n/resources/de/archive.json" with { type: "json" };
import archiveEn from "@restow/i18n/resources/en/archive.json" with { type: "json" };

import { i18n } from "@/i18n";

/** The `archive` namespace ships with this feature (see features/retention/i18n.ts for the pattern). */
export const ARCHIVE_NAMESPACE = "archive";

i18n.addResourceBundle("de", ARCHIVE_NAMESPACE, archiveDe, true, true);
i18n.addResourceBundle("en", ARCHIVE_NAMESPACE, archiveEn, true, true);
