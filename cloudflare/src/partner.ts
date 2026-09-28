import {
  APP_EVENTS_QUERY,
  TRANSACTIONS_QUERY,
  SALE_TRANSACTION_TYPES,
  SYNCED_EVENT_TYPES,
} from "../../src/partner/queries.js";
import type { AppEventNode, TransactionNode } from "../../src/sync/ingest.js";
import { type Env, type App } from "./config.js";
import type { Job } from "./store.js";
export class PartnerError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
  ) {
    super(message);
  }
}
export async function page(env: Env, app: App, job: Job) {
  const token = env[app.secret];
  if (!token) throw new PartnerError(`Secret ${app.secret} manquant.`, false);
  const transactions = job.phase === "transactions";
  const variables = {
    after: job.cursor,
    appId: `gid://partners/App/${app.appId}`,
    ...(transactions
      ? {
          createdAtMin: job.window_start,
          createdAtMax: job.window_end,
          types: SALE_TRANSACTION_TYPES,
        }
      : {
          occurredAtMin: job.window_start,
          occurredAtMax: job.window_end,
          types: SYNCED_EVENT_TYPES,
        }),
  };
  let response: Response;
  try {
    response = await fetch(
      `https://partners.shopify.com/${app.organizationId}/api/${env.PARTNER_API_VERSION || "2026-07"}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({
          query: transactions ? TRANSACTIONS_QUERY : APP_EVENTS_QUERY,
          variables,
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );
  } catch {
    throw new PartnerError(
      "Shopify ne répond pas. La reprise gardera la dernière page enregistrée.",
      true,
    );
  }
  if (!response.ok)
    throw new PartnerError(
      `Shopify HTTP ${response.status}. ${[401, 403].includes(response.status) ? "Vérifie le jeton et ses deux permissions." : "Nouvel essai nécessaire."}`,
      response.status === 429 || response.status >= 500,
    );
  const json = (await response.json()) as {
    data?: any;
    errors?: { message: string }[];
  };
  if (json.errors?.length) {
    const transient = json.errors.some((e) =>
      /throttl|too many|internal|temporar/i.test(e.message),
    );
    throw new PartnerError(
      transient
        ? "Shopify limite les requêtes ou rencontre une erreur temporaire."
        : "La requête Shopify a été refusée. Vérifie les permissions, l’app et la version API.",
      transient,
    );
  }
  const connection = transactions
    ? json.data?.transactions
    : json.data?.app?.events;
  if (!connection?.edges || !connection.pageInfo)
    throw new PartnerError(
      "App ou données introuvables dans ce compte Partner.",
      false,
    );
  const edges = connection.edges as {
    cursor: string;
    node: TransactionNode | AppEventNode;
  }[];
  const cursor = edges.at(-1)?.cursor ?? null;
  if (connection.pageInfo.hasNextPage && (!cursor || cursor === job.cursor))
    throw new PartnerError(
      "Pagination Shopify sans progression. Reprise nécessaire.",
      false,
    );
  return {
    nodes: edges.map((e) => e.node),
    cursor,
    more: Boolean(connection.pageInfo.hasNextPage),
  };
}
