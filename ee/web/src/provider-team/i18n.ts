import teamDe from "@restow/i18n/resources/de/team.json" with { type: "json" };
import teamEn from "@restow/i18n/resources/en/team.json" with { type: "json" };

import { i18n } from "@/i18n";

/** The `team` namespace ships with this module (registered like ../license/i18n.ts). */
export const TEAM_NAMESPACE = "team";

i18n.addResourceBundle("de", TEAM_NAMESPACE, teamDe, true, true);
i18n.addResourceBundle("en", TEAM_NAMESPACE, teamEn, true, true);
