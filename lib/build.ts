// Which build of Trialog this is: an opaque id that changes with every build and means nothing
// else. The page compares the id it was built with to the id the server reports, and tells the
// reader when the two differ, which means a newer version has been deployed since the page was
// loaded. Nothing is imported here, so the page can load this file in the browser.

/**
 * The id of this build. next.config.ts sets it once per build and it is written into the server
 * code and the page code alike. 'dev' when nothing set it, as in the tests.
 */
export const BUILD_ID: string = process.env.TRIALOG_BUILD_ID || 'dev';

/**
 * True when the server runs a different build than the page was loaded with. Ids are opaque, so
 * "different" is all that can be said; a missing id on either side never counts as different.
 */
export function isOtherBuild(pageBuild: unknown, serverBuild: unknown): boolean {
  return typeof pageBuild === 'string' && typeof serverBuild === 'string' && pageBuild !== '' && serverBuild !== '' && pageBuild !== serverBuild;
}
