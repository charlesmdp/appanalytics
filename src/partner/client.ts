import { getConfig } from '../config.js';

export class PartnerApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly errors: unknown = null,
  ) {
    super(message);
    this.name = 'PartnerApiError';
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

const MAX_ATTEMPTS = 6;
const BASE_BACKOFF_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The Partner API is throttled per organization and answers with 429 plus a
 * Retry-After when you exceed it. Everything goes through this one function so
 * backoff and error shaping live in a single place.
 */
export async function partnerQuery<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const { partner } = getConfig();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(partner.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': partner.token,
          Accept: 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (cause) {
      if (attempt === MAX_ATTEMPTS) {
        throw new PartnerApiError(`Network error calling the Partner API: ${String(cause)}`, null);
      }
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      continue;
    }

    if (response.status === 429 || response.status >= 500) {
      if (attempt === MAX_ATTEMPTS) {
        throw new PartnerApiError(
          `Partner API returned ${response.status} after ${MAX_ATTEMPTS} attempts.`,
          response.status,
        );
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : BASE_BACKOFF_MS * 2 ** (attempt - 1);
      await sleep(waitMs);
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      throw new PartnerApiError(
        `Partner API rejected the token (${response.status}). Check PARTNER_API_TOKEN and that the ` +
          `client has the "View financials" and "Manage apps" permissions.`,
        response.status,
      );
    }

    if (response.status === 404) {
      throw new PartnerApiError(
        `Partner API returned 404. Check PARTNER_ORGANIZATION_ID and PARTNER_API_VERSION.`,
        404,
      );
    }

    if (!response.ok) {
      throw new PartnerApiError(
        `Partner API returned ${response.status}: ${(await response.text()).slice(0, 500)}`,
        response.status,
      );
    }

    const body = (await response.json()) as GraphQLResponse<T>;

    if (body.errors?.length) {
      const throttled = body.errors.some(
        (error) => (error.extensions?.code as string | undefined) === 'THROTTLED',
      );
      if (throttled && attempt < MAX_ATTEMPTS) {
        await sleep(BASE_BACKOFF_MS * 2 ** attempt);
        continue;
      }
      throw new PartnerApiError(
        `Partner API GraphQL errors: ${body.errors.map((e) => e.message).join('; ')}`,
        response.status,
        body.errors,
      );
    }

    if (!body.data) {
      throw new PartnerApiError('Partner API returned no data.', response.status);
    }

    return body.data;
  }

  throw new PartnerApiError('Exhausted Partner API retries.', null);
}

export interface PageInfo {
  hasNextPage: boolean;
}

export interface Edge<T> {
  cursor: string;
  node: T;
}

export interface Connection<T> {
  pageInfo: PageInfo;
  edges: Array<Edge<T>>;
}

/**
 * Walks a Relay connection to exhaustion, yielding one page at a time so
 * callers can persist incrementally and keep a resumable cursor.
 */
export async function* paginate<TNode>(
  query: string,
  variables: Record<string, unknown>,
  select: (data: any) => Connection<TNode> | null | undefined,
  startCursor: string | null = null,
): AsyncGenerator<{ nodes: TNode[]; endCursor: string | null }> {
  let after: string | null = startCursor;

  for (;;) {
    const data = await partnerQuery<unknown>(query, { ...variables, after });
    const connection = select(data);
    if (!connection) return;

    const nodes = connection.edges.map((edge) => edge.node);
    const endCursor = connection.edges.at(-1)?.cursor ?? null;

    if (nodes.length > 0) {
      yield { nodes, endCursor };
    }

    if (!connection.pageInfo.hasNextPage || !endCursor) return;
    after = endCursor;
  }
}
