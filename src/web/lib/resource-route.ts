// Resource page hash routing: `#/resources` (applications tab) and
// `#/resources?tab=services` (services tab). Pure functions, unit-testable.

export type ResourceTab = 'applications' | 'services';

export const SERVICES_TAB_QUERY = 'tab=services';

/** Parse the query part of a `#/resources` hash; invalid values fall back to applications. */
export function parseResourceTab(query: string | undefined): ResourceTab {
  if (query == null || query === '') return 'applications';
  for (const pair of query.split('&')) {
    if (pair === SERVICES_TAB_QUERY) return 'services';
  }
  return 'applications';
}

/** Hash for the resources list page with the given tab. */
export function resourcesHash(tab: ResourceTab): string {
  return tab === 'services' ? `#/resources?${SERVICES_TAB_QUERY}` : '#/resources';
}

/** Hash for a resource detail page (single resource or service detail). */
export function resourceDetailHash(id: number): string {
  return `#/resources/${id}`;
}
