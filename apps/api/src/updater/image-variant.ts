/**
 * Which of the two published builds this image is (docs/CI.md, "Two build
 * targets"). The Dockerfile bakes RESTOW_IMAGE_VARIANT into the application
 * image: `community` for the Community build (the Apache-2.0 core alone,
 * `ghcr.io/restow-backup/restow-community`), `full` for the full build. An
 * installation stays on its variant: the update check reads the digests of its
 * own images from the release notes, and the opt-in updater (which runs from the
 * same image) pulls or builds the images of that variant.
 *
 * Unset means `full`, so an image built before the variable existed, and the
 * full build itself, behave exactly as before.
 */

export const IMAGE_VARIANT_VARIABLE = "RESTOW_IMAGE_VARIANT";

export const IMAGE_VARIANTS = ["full", "community"] as const;
export type ImageVariant = (typeof IMAGE_VARIANTS)[number];

type Env = Readonly<Record<string, string | undefined>>;

/** The variant a value names; `full` when empty; null when it names neither. */
export function parseImageVariant(raw: string | undefined): ImageVariant | null {
  const value = raw?.trim().toLowerCase() ?? "";
  if (value === "") {
    return "full";
  }
  return (IMAGE_VARIANTS as readonly string[]).includes(value) ? (value as ImageVariant) : null;
}

/**
 * The variant of this image, for the update check. Anything but `community`
 * reads as `full`; the updater refuses an unknown value instead (config.ts).
 */
export function imageVariantOf(env: Env): ImageVariant {
  return parseImageVariant(env[IMAGE_VARIANT_VARIABLE]) === "community" ? "community" : "full";
}

/**
 * The names a release uses for the two images of a variant: the repository
 * names under ghcr.io/restow-backup and the labels of the digest lines in the
 * release notes (`restow: sha256:...`, `restow-community: sha256:...`).
 */
export function imageNamesOf(variant: ImageVariant): { app: string; web: string } {
  return variant === "community"
    ? { app: "restow-community", web: "restow-web-community" }
    : { app: "restow", web: "restow-web" };
}

/** The image repositories of the official releases for a variant. */
export function defaultImageRepositories(variant: ImageVariant): { app: string; web: string } {
  const names = imageNamesOf(variant);
  return {
    app: `ghcr.io/restow-backup/${names.app}`,
    web: `ghcr.io/restow-backup/${names.web}`,
  };
}

/** The Dockerfile targets of the application and the web image, of either build. */
export type BuildTarget = "runtime" | "web" | "runtime-community" | "web-community";

/** The Dockerfile targets that build the two images of a variant. */
export function buildTargetsOf(variant: ImageVariant): { app: BuildTarget; web: BuildTarget } {
  return variant === "community"
    ? { app: "runtime-community", web: "web-community" }
    : { app: "runtime", web: "web" };
}
