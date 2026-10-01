import { describe, expect, it } from "vitest";
import {
  buildTargetsOf,
  defaultImageRepositories,
  imageNamesOf,
  imageVariantOf,
  parseImageVariant,
} from "./image-variant.js";

describe("image variant", () => {
  it("reads unset and empty as the full build, so older images behave as before", () => {
    expect(imageVariantOf({})).toBe("full");
    expect(imageVariantOf({ RESTOW_IMAGE_VARIANT: "" })).toBe("full");
    expect(imageVariantOf({ RESTOW_IMAGE_VARIANT: "full" })).toBe("full");
    expect(parseImageVariant(undefined)).toBe("full");
    expect(parseImageVariant("  ")).toBe("full");
  });

  it("recognises the Community build", () => {
    expect(imageVariantOf({ RESTOW_IMAGE_VARIANT: "community" })).toBe("community");
    expect(imageVariantOf({ RESTOW_IMAGE_VARIANT: " Community " })).toBe("community");
  });

  it("parses an unknown value as invalid; the update check reads it as full", () => {
    expect(parseImageVariant("comunity")).toBeNull();
    expect(imageVariantOf({ RESTOW_IMAGE_VARIANT: "comunity" })).toBe("full");
  });

  it("names the published images and the Dockerfile targets of each build", () => {
    expect(imageNamesOf("full")).toEqual({ app: "restow", web: "restow-web" });
    expect(imageNamesOf("community")).toEqual({
      app: "restow-community",
      web: "restow-web-community",
    });
    expect(defaultImageRepositories("full")).toEqual({
      app: "ghcr.io/restow-backup/restow",
      web: "ghcr.io/restow-backup/restow-web",
    });
    expect(defaultImageRepositories("community")).toEqual({
      app: "ghcr.io/restow-backup/restow-community",
      web: "ghcr.io/restow-backup/restow-web-community",
    });
    expect(buildTargetsOf("full")).toEqual({ app: "runtime", web: "web" });
    expect(buildTargetsOf("community")).toEqual({ app: "runtime-community", web: "web-community" });
  });
});
