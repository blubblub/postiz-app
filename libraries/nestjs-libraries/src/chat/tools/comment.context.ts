/**
 * The organization id is stashed on the request context by checkAuth; every
 * tool pulls it out the same way, so keep the parsing in one place.
 */
export const organizationFromContext = (context: any): string =>
  JSON.parse((context?.requestContext as any)?.get('organization') as string)
    .id;

/**
 * Some services want the whole organization record, not just its id — checkAuth
 * stashes the full object, so hand it back rather than re-fetching it.
 */
export const organizationRecordFromContext = (context: any): any =>
  JSON.parse((context?.requestContext as any)?.get('organization') as string);
