import createClient from 'openapi-fetch';

/**
 * Runtime options shared by every generated Core client.
 *
 * The concrete `Paths` type must come from the generated OpenAPI module. This
 * package intentionally does not provide a fallback domain schema.
 */
export interface CoreClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit;
}

export type CoreClient<Paths extends object> = ReturnType<typeof createClient<Paths>>;

export function createCoreClient<Paths extends object>(options: CoreClientOptions): CoreClient<Paths> {
  return createClient<Paths>({
    baseUrl: options.baseUrl,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
}
