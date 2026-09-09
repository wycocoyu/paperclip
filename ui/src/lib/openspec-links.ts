/**
 * Deep links into the OpenSpec tab.
 *
 * The store-relative path is the only thing worth persisting: the openspec
 * store is a git checkout read straight off disk, so a path survives being
 * copied between environments while a full URL does not — it would carry the
 * host and company prefix it was written under. Anything holding a reference
 * (an issue work product, a comment, a document) stores the path and calls
 * this to render it, so the URL shape lives in exactly one place.
 */

/** Query parameter the OpenSpec tab reads its selected file from. */
export const OPENSPEC_PATH_PARAM = "path";

/**
 * Build an in-app href for a store-relative path.
 *
 * Returned without a company prefix — `Link` from `@/lib/router` adds the
 * active one, which is what makes the same stored path work for every company
 * and every environment.
 *
 * A directory path is passed through unchanged. The tab resolves what it can
 * and says so when it cannot, rather than this trying to guess which file
 * inside a change the reader wanted.
 */
export function openSpecPathHref(storePath: string): string {
  return `/openspec?${OPENSPEC_PATH_PARAM}=${encodeURIComponent(storePath)}`;
}
