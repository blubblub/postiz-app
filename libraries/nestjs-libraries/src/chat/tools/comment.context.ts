/**
 * The organization id is stashed on the request context by checkAuth; every
 * tool pulls it out the same way, so keep the parsing in one place.
 */
export const organizationFromContext = (context: any): string =>
  JSON.parse((context?.requestContext as any)?.get('organization') as string)
    .id;
