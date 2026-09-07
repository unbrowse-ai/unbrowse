// Source-checkout sentinel. Release packaging atomically replaces this file
// with a signed manifest via scripts/build-release-manifest.ts. Keeping source
// provenance blank prevents a checkout from impersonating the previous release.
export const BUILD_RELEASE_VERSION = "";
export const BUILD_GIT_SHA = "";
export const BUILD_CODE_HASH = "";
export const BUILD_RELEASE_MANIFEST_BASE64 = "";
export const BUILD_RELEASE_MANIFEST_SIGNATURE = "";
export const BUILD_DEFAULT_BACKEND_URL = "https://beta-api.unbrowse.ai";
export const BUILD_DEFAULT_PROFILE = "";
