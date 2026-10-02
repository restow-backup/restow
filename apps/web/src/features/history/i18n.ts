import "@/features/jobs/i18n";

import historyDe from "@restow/i18n/resources/de/history.json" with { type: "json" };
import historyEn from "@restow/i18n/resources/en/history.json" with { type: "json" };

import { i18n } from "@/i18n";

/**
 * The `history` namespace: the History pages, the run drawer, the throughput charts and the
 * live indicator. The files ship with the shared package; registering them here keeps the
 * feature current even while the package's build output lags behind (identical content merges
 * harmlessly). The `backup` namespace (state names, durations, throttling texts the run pages
 * reuse) comes along.
 */
export const HISTORY_NAMESPACE = "history";

i18n.addResourceBundle("de", HISTORY_NAMESPACE, historyDe, true, true);
i18n.addResourceBundle("en", HISTORY_NAMESPACE, historyEn, true, true);
