// Shared default for every locally packaged or published Flowix DSH runtime.
// Set FLOWIX_DSH_VERSION to override it for a one-off build.
export const DEFAULT_DSH_RELEASE_VERSION = '26.9.25'

export function getDshReleaseVersion() {
  return process.env.FLOWIX_DSH_VERSION || DEFAULT_DSH_RELEASE_VERSION
}
