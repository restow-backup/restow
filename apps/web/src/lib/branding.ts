import { applyProductNameToInstance } from "@restow/i18n";

import { i18n } from "@/i18n";

/**
 * The product name of this installation (the branding). The api reports it in
 * the public setup state (`SetupState.productName`); applying it makes `{appName}`
 * resolve to it in every text of the app, including `common:app.name`, the
 * document title and the wordmark, without any call site passing it.
 *
 * Until the state arrives (and when it never does, say the api is down) the
 * app shows the default name.
 */
export function applyProductName(productName: string | null | undefined): void {
  if (applyProductNameToInstance(i18n, productName)) {
    // Rendered texts follow the language-changed event, so a changed name reaches them too.
    void i18n.changeLanguage(i18n.resolvedLanguage ?? i18n.language);
  }
}
