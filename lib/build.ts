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
 * The version people say: «v0.3», from package.json. The minor number goes up each time the live
 * hub moves to a new version (see CONTRIBUTING.md). Empty when nothing set it, as in the tests.
 */
export const VERSION: string = process.env.TRIALOG_VERSION || '';

/** The pull request this build was made from, its «build» number: «51». Empty when unknown. */
export const BUILD_NUMBER: string = process.env.TRIALOG_BUILD_NUMBER || '';

/** «v0.3», «v0.3.1» → «v0.3» and «v0.3.1»; a patch of 0 is left out. */
export function versionLabel(packageVersion: string): string {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(packageVersion.trim());
  if (!m) return '';
  return `v${m[1]}.${m[2]}${m[3] && m[3] !== '0' ? `.${m[3]}` : ''}`;
}

/**
 * The pull request a commit came from, read from its message: GitHub ends a squash merge's title
 * with «(#51)» and starts a merge commit with «Merge pull request #53». Empty when neither is there.
 */
export function pullRequestOf(commitMessage: string): string {
  const firstLine = commitMessage.split('\n')[0] ?? '';
  const m = /\(#(\d+)\)\s*$/.exec(firstLine) ?? /^Merge pull request #(\d+)\b/.exec(firstLine);
  return m ? m[1] : '';
}

/** What the page shows under the message box: «Trialog v0.3 · build 51», or less when less is known. */
export function buildLabel(version: string, build: string): string {
  if (!version) return '';
  return `Trialog ${version}${build ? ` · build ${build}` : ''}`;
}

/**
 * True when the server runs a different build than the page was loaded with. Ids are opaque, so
 * "different" is all that can be said; a missing id on either side never counts as different.
 */
export function isOtherBuild(pageBuild: unknown, serverBuild: unknown): boolean {
  return typeof pageBuild === 'string' && typeof serverBuild === 'string' && pageBuild !== '' && serverBuild !== '' && pageBuild !== serverBuild;
}
