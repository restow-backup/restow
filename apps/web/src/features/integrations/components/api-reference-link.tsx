import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";

import { OPENAPI_DOCUMENT_URL } from "@/lib/api";

/**
 * Where the endpoints a key opens are described: the OpenAPI document the API serves
 * (`/api/v1/openapi.json`), for an RMM, a script or a code generator.
 */
export function ApiReferenceLink() {
  const { t } = useTranslation("integrations");
  return (
    <a
      href={OPENAPI_DOCUMENT_URL}
      target="_blank"
      rel="noreferrer"
      data-slot="api-reference"
      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
    >
      {t("apiKeys.reference")}
      <ExternalLink aria-hidden="true" className="size-3" />
      <span className="sr-only">{t("apiKeys.opensInNewTab")}</span>
    </a>
  );
}
