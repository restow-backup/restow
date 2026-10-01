/**
 * Who signs a release image (docs/UPDATING.md, "What is verified").
 *
 * The release workflow (.github/workflows/release.yml, job `publish`) signs the
 * multi-arch index of both images keylessly with cosign: the certificate comes
 * from Sigstore's Fulcio for the GitHub Actions OIDC identity of that workflow
 * run, and names the workflow file and the tag it ran for. The updater accepts an
 * image only with a valid signature whose certificate names exactly
 * `https://github.com/restow-backup/restow/.github/workflows/release.yml@refs/tags/v<version>`
 * for the version being installed, issued for
 * `https://token.actions.githubusercontent.com`, and checked against Sigstore's
 * trust root and transparency log. A digest someone typed into release notes,
 * an image built elsewhere and the image of another release all fail that.
 *
 * The verifier is cosign itself, in its official image pinned by digest (the
 * version the release workflow signs with, so it reads the signature format that
 * version writes), started through the same Docker daemon as every other step.
 */

/** The repository whose release workflow signs the published images. */
export const RELEASE_REPOSITORY = "restow-backup/restow";

/** The OIDC issuer of GitHub Actions, as Fulcio puts it into the certificate. */
export const RELEASE_SIGNATURE_ISSUER = "https://token.actions.githubusercontent.com";

/** cosign v3.1.3 (the version release.yml signs with), multi-arch index, pinned by digest. */
export const DEFAULT_COSIGN_IMAGE =
  "ghcr.io/sigstore/cosign/cosign:v3.1.3@sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8";

/** The Docker CLI image for helper containers (docker 27.5.1, multi-arch index), pinned by digest. */
export const DEFAULT_CLI_IMAGE =
  "docker:27-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c";

/** A release tag the workflow runs for: `v` and a plain version (release.yml triggers on `v*`). */
const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** An image reference that names its content by digest (`name[:tag]@sha256:<64 hex>`). */
export const DIGEST_PINNED_IMAGE = /^[a-z0-9][a-z0-9._/:-]{0,199}@sha256:[0-9a-f]{64}$/;

/**
 * The certificate identity of the release workflow run for `tag`; null when `tag`
 * is not a tag that workflow runs for (or does not belong to `version`).
 */
export function releaseSignerIdentity(tag: string, version: string): string | null {
  if (!RELEASE_TAG.test(tag) || tag.slice(1) !== version) {
    return null;
  }
  return `https://github.com/${RELEASE_REPOSITORY}/.github/workflows/release.yml@refs/tags/${tag}`;
}
