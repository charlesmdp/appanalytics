/**
 * Reading reviews out of an App Store listing page.
 *
 * There is no API behind this. The Partner API's `App` object carries an id, a
 * name, an api key and an event feed, and nothing whatsoever about the listing
 * or its reviews, so the public page is the only source that exists.
 *
 * That page is server-rendered — no JavaScript, no headless browser — and every
 * field we want sits on an explicit hook rather than a layout class:
 *
 *   `id="review-<id>"`             the review's own id, stable across crawls
 *   `aria-label="N out of 5 stars"`  the rating
 *   `data-truncate-content-copy`   the body (and, second time round, the reply)
 *   `title="<store>"`              the merchant's store name
 *   `data-merchant-review-reply`   the developer's reply, if any
 *   `<script type="application/ld+json">`  the published aggregate rating
 *
 * Those hooks are semantic and accessibility-bearing, which is the closest thing
 * to a stability guarantee an unversioned page can offer: the Tailwind soup
 * around them is regenerated constantly, but `aria-label` is load-bearing for
 * screen readers and does not churn. Parsing keys on those and nothing else.
 *
 * Every extractor returns null rather than guessing when its hook is missing, so
 * a redesign surfaces as a review that fails validation and is skipped, not as a
 * row full of plausible nonsense.
 */

export interface ParsedReview {
  /** Shopify's own review id. The natural key for everything downstream. */
  reviewId: string;
  rating: number;
  /** Date only — the listing never publishes a time. */
  postedOn: string;
  body: string;
  storeName: string;
  country: string | null;
  /** Verbatim, e.g. "About 2 months using the app". */
  usageDuration: string | null;
  replyBody: string | null;
  replyOn: string | null;
}

export interface ParsedReviewPage {
  reviews: ParsedReview[];
  /**
   * The app's name as the listing states it.
   *
   * Not used by the crawl at all — it is how a partner confirms the URL they
   * pasted is the app they meant, which is the one mistake in this feature that
   * otherwise stays invisible until an app mysteriously has no reviews.
   */
  listingName: string | null;
  /** The listing's published figures, from JSON-LD. Null if absent. */
  ratingValue: number | null;
  ratingCount: number | null;
  hasNextPage: boolean;
  /**
   * The highest page number the pager links to.
   *
   * A sweep uses this to know how far it has to walk before it is entitled to
   * call a review missing.
   */
  lastPage: number | null;
}

const MONTHS: Record<string, string> = {
  january: '01',
  february: '02',
  march: '03',
  april: '04',
  may: '05',
  june: '06',
  july: '07',
  august: '08',
  september: '09',
  october: '10',
  november: '11',
  december: '12',
};

/** "July 24, 2026" → "2026-07-24". Null on anything that is not that shape. */
export function parseListingDate(raw: string): string | null {
  const match = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(raw.trim());
  if (!match) return null;
  const month = MONTHS[match[1]!.toLowerCase()];
  if (!month) return null;
  return `${match[3]}-${month}-${match[2]!.padStart(2, '0')}`;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1]?.toLowerCase() === 'x'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Markup to readable text.
 *
 * Block boundaries become newlines before tags are dropped, because a review
 * written as several paragraphs would otherwise come back as one run-on
 * sentence with words welded together across the tag boundary.
 */
function toText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/**
 * The slice of markup belonging to each review.
 *
 * Bounded by the next review's anchor so a field can never be read out of its
 * neighbour. `id="review-reply-…"` does not collide: the id here is digits.
 */
function reviewSegments(html: string): Array<{ reviewId: string; markup: string }> {
  const anchors = [...html.matchAll(/id="review-(\d+)"/g)];
  return anchors.map((anchor, index) => {
    const start = anchor.index!;
    const end = index + 1 < anchors.length ? anchors[index + 1]!.index! : html.length;
    return { reviewId: anchor[1]!, markup: html.slice(start, end) };
  });
}

/**
 * The developer's reply, and the review markup with the reply removed.
 *
 * Splitting them first is what keeps the two apart everywhere else: the reply
 * carries its own date and its own truncatable body, and a reply-to-a-1-star
 * saying "we have refunded you" would otherwise be read as the review itself.
 */
function splitReply(markup: string): {
  withoutReply: string;
  replyBody: string | null;
  replyOn: string | null;
} {
  const start = markup.indexOf('data-merchant-review-reply');
  if (start < 0) return { withoutReply: markup, replyBody: null, replyOn: null };

  const replyMarkup = markup.slice(start);
  const copy = /data-truncate-content-copy[^>]*>([\s\S]*?)<\/div>/.exec(replyMarkup);
  const replied = /replied\s+([A-Za-z]+\s+\d{1,2},\s*\d{4})/.exec(toText(replyMarkup));

  return {
    withoutReply: markup.slice(0, start),
    replyBody: copy ? toText(copy[1]!) || null : null,
    replyOn: replied ? parseListingDate(replied[1]!) : null,
  };
}

/**
 * One review, or null if the markup no longer looks like one.
 *
 * A rating we cannot read is the disqualifying case: it is the field with no
 * safe default, since guessing turns a silent parser break into a wrong average
 * rating that nobody has any reason to doubt.
 */
function parseReview(reviewId: string, markup: string): ParsedReview | null {
  const { withoutReply, replyBody, replyOn } = splitReply(markup);

  const rating = /aria-label="(\d) out of 5 stars"/.exec(withoutReply);
  if (!rating) return null;

  const stars = Number(rating[1]);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return null;

  // The first date in the block is the review's own; the reply's is already gone.
  const posted = /([A-Za-z]+\s+\d{1,2},\s*\d{4})/.exec(toText(withoutReply));
  const postedOn = posted ? parseListingDate(posted[1]!) : null;
  if (!postedOn) return null;

  const copy = /data-truncate-content-copy[^>]*>([\s\S]*?)<\/div>/.exec(withoutReply);
  const store = /title="([^"]*)"/.exec(withoutReply);

  // Country and "N months using the app" are the two bare divs after the store
  // name's share button — the only fields on the page with no hook of their own.
  const trailing = withoutReply.slice(withoutReply.indexOf('data-review-share-link'));
  const bare = [...trailing.matchAll(/<div>([^<]*)<\/div>/g)].map((match) => toText(match[1]!));

  return {
    reviewId,
    rating: stars,
    postedOn,
    body: copy ? toText(copy[1]!) : '',
    storeName: store ? decodeEntities(store[1]!).trim() : '',
    country: bare[0] || null,
    usageDuration: bare[1] || null,
    replyBody,
    replyOn,
  };
}

/** The listing's own name and published rating — Shopify's arithmetic, not ours. */
function parseAggregate(html: string): {
  listingName: string | null;
  ratingValue: number | null;
  ratingCount: number | null;
} {
  const empty = { listingName: null, ratingValue: null, ratingCount: null };
  const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  if (!block) return empty;

  try {
    const parsed = JSON.parse(block[1]!) as {
      name?: unknown;
      aggregateRating?: { ratingValue?: unknown; ratingCount?: unknown };
    };
    const value = Number(parsed.aggregateRating?.ratingValue);
    const count = Number(parsed.aggregateRating?.ratingCount);
    return {
      listingName: typeof parsed.name === 'string' && parsed.name ? parsed.name : null,
      ratingValue: Number.isFinite(value) ? value : null,
      ratingCount: Number.isFinite(count) ? count : null,
    };
  } catch {
    // A listing we cannot read the aggregate for still has readable reviews.
    return empty;
  }
}

export function parseReviewsPage(html: string): ParsedReviewPage {
  const reviews: ParsedReview[] = [];
  for (const { reviewId, markup } of reviewSegments(html)) {
    const review = parseReview(reviewId, markup);
    if (review) reviews.push(review);
  }

  const pages = [...html.matchAll(/reviews\?[^"']*page=(\d+)/g)].map((match) => Number(match[1]));
  const lastPage = pages.length > 0 ? Math.max(...pages) : null;

  return {
    reviews,
    ...parseAggregate(html),
    hasNextPage: /rel="next"/.test(html),
    lastPage,
  };
}
