/**
 * The license key of the full-build smoke. The Business and Service Provider
 * checks (several tenants, the journal receiver of check 6) need a real,
 * verified key: RESTOW_EDITION is honoured only in demo mode (RESTOW_DEMO=true).
 *
 * The key comes from the test-only signer of ee/licensing/testing, which is
 * never part of an image: a throwaway Ed25519 key pair made for this run. Its
 * public key goes into the stack's .env as RESTOW_LICENSE_PUBLIC_KEY (the
 * verification key the api trusts); the private key lives in this process
 * only and is never written anywhere. The key is installed the way an operator
 * does it (Settings, License): read the installation id, then post the key.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const SIGNER_PATH = "ee/licensing/testing/test-signer.mjs";

/** A fresh signer: `{ publicKey, sign({ edition, licensee, installationId }) }`. */
export async function createLicenseSigner(repoRoot) {
  let module;
  try {
    module = await import(pathToFileURL(join(repoRoot, SIGNER_PATH)).href);
  } catch (error) {
    throw new Error(
      `the full-build smoke needs the test license signer ${SIGNER_PATH} (${error instanceof Error ? error.message : error}); run the community variant (--variant community) on a tree without ee/`,
    );
  }
  return module.createTestLicenseSigner();
}

/**
 * Install a key of `edition` for the installation behind `api` (a provider
 * admin's session). Returns the license state the api answers with.
 */
export async function installLicenseKey(
  api,
  signer,
  { edition = "service_provider", licensee = "Restow release smoke" } = {},
) {
  const before = await api.get("/api/v1/license");
  if (!before.installationId) {
    throw new Error("GET /api/v1/license names no installation id; the setup is not complete");
  }
  const key = signer.sign({ edition, licensee, installationId: before.installationId });
  const state = await api.post("/api/v1/license", { key });
  if (state.edition !== edition || state.source !== "key") {
    throw new Error(
      `after installing a ${edition} key the api reports the edition ${state.edition} from ${state.source}`,
    );
  }
  return state;
}
