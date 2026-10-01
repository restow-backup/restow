import { productName } from "@restow/i18n";
import type { OperatingMode } from "../config.js";

/**
 * Which ways into Restow an installation offers, derived from its configuration.
 * The login page and the invitation dialog read the result from the public
 * setup state, so nobody is sent down a sign-in path that cannot work. Sign-in
 * methods beyond passkey and password come from extensions
 * (extensions.ts, `SignInProvider`).
 */

/** The saved installation facts sign-in depends on. */
export interface SignInSettings {
  operatingMode: OperatingMode | null;
  publicUrl: string | null;
}

/**
 * Issuer shown for this installation in authenticator apps: the product name
 * (the branding) plus the host of the public URL, so codes of several
 * installations stay apart.
 */
export function totpIssuer(publicUrl: string | undefined): string {
  const name = productName();
  if (!publicUrl) {
    return name;
  }
  try {
    return `${name} (${new URL(publicUrl).host})`;
  } catch {
    return name;
  }
}
