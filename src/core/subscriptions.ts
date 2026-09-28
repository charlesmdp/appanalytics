// Extracted without changing the PartnerDex subscription inference rules.
/**
 * Transactions recorded before this date carry no chargeId, so a subscription
 * that activated earlier cannot be matched to its first payment. Those fall
 * back to their activation date as the MRR gate.
 */
const CHARGE_ID_AVAILABLE_FROM = "2020-09-01T00:00:00.000Z";

const MS_PER_DAY = 86_400_000;

/**
 * Partner transactions carry the date they were *recorded* into a payout batch,
 * not the date the merchant was charged, and payouts run twice a month. A final
 * sale landing days after a cancellation is therefore normal settlement lag, not
 * evidence the subscription is still alive. Only billing beyond this window
 * proves a charge outlived an event.
 */
const SETTLEMENT_LAG_DAYS = 21;

/**
 * How a cancel is paired with the activation that replaces it (spec §4.a/§4.b).
 *
 * Shopify performs a plan change as one operation: it cancels the old recurring
 * charge and activates the new one milliseconds apart, which is why the fold in
 * `events.ts` tie-breaks them at a shared instant. The pairing window exists to
 * absorb that gap and nothing else.
 *
 * It used to be `PLAN_CHANGE_WINDOW_DAYS`, two days wide and measured with
 * `Math.abs`, and that is far too generous to mean "the same operation". Any
 * merchant who cancelled and signed up again inside a long weekend was paired
 * with themselves: their cancellation was written off as a tier move, so a real
 * loss and a real win-back both vanished from the numbers, and the fold read
 * their return as an upgrade. The spec is specific about the sizes, and about
 * the direction — an activation *before* a cancel cannot be replacing it.
 */
export const PLAN_CHANGE_WINDOW_SECONDS = 60;

/**
 * Spec §4.b. A charge whose own activation lands a moment *before* its own
 * cancel is the feed re-emitting itself out of order, not a subscription that
 * lived for four seconds. Same charge only; this is an ordering guard.
 */
const PLAN_CHANGE_REEMIT_SECONDS = 5;

/** Is `to` at or after `from`, and closer to it than `seconds`? */
function withinSeconds(from: string, to: string, seconds: number): boolean {
  const gap = (new Date(to).getTime() - new Date(from).getTime()) / 1000;
  return gap >= 0 && gap < seconds;
}

const CANCEL_TYPES = [
  "SUBSCRIPTION_CHARGE_CANCELED",
  "SUBSCRIPTION_CHARGE_EXPIRED",
  "SUBSCRIPTION_CHARGE_DECLINED",
];

const INSTALL_TYPES = ["RELATIONSHIP_INSTALLED", "RELATIONSHIP_REACTIVATED"];
const UNINSTALL_TYPES = [
  "RELATIONSHIP_UNINSTALLED",
  "RELATIONSHIP_DEACTIVATED",
];

/**
 * Cadence -> monthly (spec 1.5). Shopify bills app subscriptions either every
 * 30 days or annually; the 30-day cycle passes through untouched by convention
 * rather than being scaled by 365/30.
 */
export function monthlyAmountFor(
  amount: number,
  billingInterval: string,
): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return billingInterval === "ANNUAL" ? amount / 12 : amount;
}

/**
 * A billing gap this wide can only be an annual cycle. Shopify's other cadence
 * is 30 days, so nothing monthly is ever billed this far out; the tolerance
 * below 365 absorbs the date-vs-timestamp rounding described at `cycleDays`.
 */
const ANNUAL_GAP_DAYS = 360;

/** `app_id`, plan name and as-billed price — what identifies a price point. */
export function priceKey(
  appId: string,
  planName: string | null,
  amount: number | null,
): string {
  return `${appId}\u0000${planName ?? ""}\u0000${(amount ?? 0).toFixed(2)}`;
}

/**
 * Cadence per price point, learned from the charges whose interval is already
 * known for certain.
 *
 * `AppSubscriptionSale.billingInterval` is the only field in the entire Partner
 * API that states a cadence — the charge on an app event carries `amount`,
 * `billingOn`, `name` and `test`, and nothing else. So a charge's interval is
 * unknowable until its first sale settles into a payout batch, which lags
 * activation by up to `SETTLEMENT_LAG_DAYS`.
 *
 * Defaulting that gap to the 30-day cadence counts an annual plan at twelve
 * times its MRR for the fortnight before its sale lands. Reading the cadence off
 * the price point instead closes the gap: an app sells "Starter" at one monthly
 * price and one annual price, so a settled annual sale at $140 tells us that the
 * *next* $140 Starter charge is annual too, before its own sale arrives.
 *
 * A price point seen at both cadences teaches nothing and is dropped, so the
 * book only ever answers where the answer is unambiguous.
 */
export function buildPriceBook(
  charges: ChargeRow[],
  salesByRef: Map<string, SaleRow>,
): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  for (const charge of charges) {
    if (charge.is_test) continue;
    const interval = salesByRef.get(
      charge.charge_id.split("/").pop() ?? "",
    )?.billing_interval;
    if (!interval) continue;
    const key = priceKey(charge.app_id, charge.plan_name, charge.amount);
    const intervals = seen.get(key);
    if (intervals) intervals.add(interval);
    else seen.set(key, new Set([interval]));
  }

  const book = new Map<string, string>();
  for (const [key, intervals] of seen) {
    const [only] = intervals;
    if (intervals.size === 1 && only) book.set(key, only);
  }
  return book;
}

/**
 * When each app+shop relationship first paid, across every charge it has held.
 *
 * Keyed on the relationship rather than the charge because a plan change starts
 * a *new* charge: asking "has this charge been paid for" would answer no for
 * every upgrade, while the question that matters is whether the merchant behind
 * it was already a paying customer.
 *
 * Settled sales only. A charge that has been billed but whose transaction is
 * still in flight looks unpaid here, which costs nothing: the callers fall back
 * to `billing_on`, and the next rebuild after the payout lands corrects it.
 */
function buildFirstPaidAt(
  charges: ChargeRow[],
  salesByRef: Map<string, SaleRow>,
): Map<string, string> {
  const first = new Map<string, string>();
  for (const charge of charges) {
    const sale = salesByRef.get(charge.charge_id.split("/").pop() ?? "");
    if (!sale) continue;
    const key = `${charge.app_id} ${charge.shop_id}`;
    const seen = first.get(key);
    if (seen === undefined || sale.first_sale_at < seen)
      first.set(key, sale.first_sale_at);
  }
  return first;
}

/**
 * The billing cadence of one charge, from the strongest evidence available.
 *
 * Precedence is deliberate — each step is only reached because the one above it
 * had nothing to say:
 *
 *   1. a settled sale, which *states* the interval;
 *   2. a billing date a year out, which no 30-day charge can have. This is what
 *      catches an app's first-ever annual customer, before the price book has
 *      seen one — but only for a charge billed at activation, since a fresh
 *      annual trial is billed at the trial end, days away, and is
 *      indistinguishable from a monthly trial;
 *   3. the price book (see `buildPriceBook`);
 *   4. the 30-day cadence, which is both Shopify's default and the commoner
 *      case by an order of magnitude.
 */
function resolveInterval(
  charge: ChargeRow,
  sale: SaleRow | undefined,
  book: Map<string, string>,
): string {
  if (sale?.billing_interval) return sale.billing_interval;

  const gap =
    charge.activated_at && charge.billing_on
      ? daysBetween(charge.activated_at, charge.billing_on)
      : null;
  if (gap !== null && gap >= ANNUAL_GAP_DAYS) return "ANNUAL";

  return (
    book.get(priceKey(charge.app_id, charge.plan_name, charge.amount)) ??
    "EVERY_30_DAYS"
  );
}

export interface ChargeRow {
  charge_id: string;
  app_id: string;
  shop_id: string;
  plan_name: string | null;
  amount: number | null;
  currency: string | null;
  is_test: number;
  accepted_at: string | null;
  activated_at: string | null;
  canceled_at: string | null;
  frozen_at: string | null;
  unfrozen_at: string | null;
  billing_on: string | null;
}

export interface SaleRow {
  charge_ref: string;
  first_sale_at: string;
  last_sale_at: string;
  paid_sale_count: number;
  billing_interval: string | null;
}

function daysBetween(from: string, to: string): number {
  return (new Date(to).getTime() - new Date(from).getTime()) / MS_PER_DAY;
}

export interface DeriveOptions {
  churnOnUninstall: boolean;
  trialMinGapDays: number;
}
export function deriveSubscriptions(
  charges: ChargeRow[],
  sales: SaleRow[],
  finalUninstall: Map<string, { at: string; type: string }>,
  reporting: DeriveOptions,
  now: string,
  learnedPrices?: Map<string, string>,
) {
  const salesByRef = new Map(sales.map((row) => [row.charge_ref, row]));
  const priceBook = learnedPrices ?? buildPriceBook(charges, salesByRef);
  const firstPaidAt = buildFirstPaidAt(charges, salesByRef);
  interface Derived extends ChargeRow {
    charge_ref: string;
    billing_interval: string;
    monthly_amount: number;
    conversion_at: string | null;
    churn_at: string | null;
    churn_reason: string | null;
    trial_started_at: string | null;
    trial_ends_at: string | null;
    trial_status: string;
    is_plan_change: number;
    paid_sale_count: number;
    first_sale_at: string | null;
    last_sale_at: string | null;
  }

  // Sibling charges per shop+app, so a charge can tell whether it continues an
  // existing relationship or starts a new one.
  const siblings = new Map<string, ChargeRow[]>();
  for (const charge of charges) {
    const key = `${charge.app_id} ${charge.shop_id}`;
    const list = siblings.get(key);
    if (list) list.push(charge);
    else siblings.set(key, [charge]);
  }

  const derived: Derived[] = [];

  for (const charge of charges) {
    const chargeRef = charge.charge_id.split("/").pop() ?? "";
    const sale = salesByRef.get(chargeRef);
    const amount = charge.amount ?? 0;
    const billingInterval = resolveInterval(charge, sale, priceBook);
    const activatedAt = charge.activated_at;

    // Churn: an explicit cancel, or the merchant walking away entirely.
    let churnAt = charge.canceled_at;
    let churnReason: string | null = churnAt ? "canceled" : null;
    if (reporting.churnOnUninstall && activatedAt) {
      const gone = finalUninstall.get(`${charge.app_id} ${charge.shop_id}`);
      const goneAt = gone?.at;
      // Billing that continued past the uninstall means the charge outlived it
      // (the merchant reinstalled, or event ordering is noisy), so the uninstall
      // is not what ended this subscription.
      const outlivedByBilling = Boolean(
        sale &&
        goneAt &&
        daysBetween(goneAt, sale.last_sale_at) > SETTLEMENT_LAG_DAYS,
      );

      /**
       * A deactivation that Shopify answered by freezing the charge.
       *
       * These are two different endings wearing the same shape. An *uninstall*
       * is the merchant removing the app: the charge is cancelled and the
       * subscription is over. A *deactivation* is the shop itself going away —
       * paused, closed, or suspended — and Shopify does not cancel the charge
       * for it, it freezes it, usually within seconds. The spec is explicit
       * that the deactivation is account-level and moves no MRR on its own
       * (§3.1); the freeze is what moves it, and `subscription_frozen` already
       * carries exactly that, reversibly.
       *
       * Treating the deactivation as churn as well booked the same loss twice
       * over: the merchant was reported cancelled *and* frozen one second
       * apart, and a store that later reopens — as this one did in March —
       * had a churn on its record that it never earned.
       */
      const frozenByDeactivation = Boolean(
        gone?.type === "RELATIONSHIP_DEACTIVATED" &&
        goneAt &&
        charge.frozen_at &&
        charge.frozen_at >= goneAt &&
        (!charge.unfrozen_at || charge.unfrozen_at < charge.frozen_at),
      );

      if (
        goneAt &&
        goneAt > activatedAt &&
        !outlivedByBilling &&
        !frozenByDeactivation &&
        (!churnAt || goneAt < churnAt)
      ) {
        churnAt = goneAt;
        // Spec §7.1 keeps store closure apart from product churn: a shop that
        // was deactivated never passed a verdict on the app, and lumping it in
        // with uninstalls is what makes a churn-reason breakdown misleading.
        churnReason =
          gone?.type === "RELATIONSHIP_DEACTIVATED"
            ? "deactivated"
            : "uninstalled";
      }
    }

    /**
     * `billing_on` is the charge's *next* billing date, which means two very
     * different things and must not be read as "trial ends here":
     *
     *  - on a fresh trial it is the trial end, a part-cycle away;
     *  - on a charge that was billed at activation it is a full cycle away;
     *  - on a mid-cycle plan change it is whatever remained of the cycle the
     *    merchant already paid for.
     *
     * Only the first is a trial. The other two are paying customers, and
     * treating them as trials understates paying shops and MRR.
     */
    // `billing_on` is a calendar date at midnight while activation carries a
    // time of day, so a full cycle measures slightly short of its nominal
    // length. One day of tolerance absorbs that; real trials sit far below it.
    const cycleDays = (billingInterval === "ANNUAL" ? 365 : 30) - 1;
    const billingGapDays =
      activatedAt && charge.billing_on
        ? daysBetween(activatedAt, charge.billing_on)
        : null;

    /**
     * A charge that replaces one which ended at the same moment continues an
     * existing relationship rather than starting a trial — *if* that
     * relationship was a paying one.
     *
     * The rule earns its keep on a mid-cycle upgrade: the merchant has already
     * paid for the cycle they are in, so the replacement charge is not a trial
     * however short its remaining `billing_on` gap looks. But a merchant who
     * switches plan while still *inside* a trial is continuing the trial, and
     * Shopify says so plainly — it carries the unused trial days onto the new
     * charge, so the replacement bills on the date the original trial would
     * have ended. Reading that as "paid at activation" books revenue from
     * someone who has not been charged a cent, and starts their trial-conversion
     * clock on the wrong day.
     *
     * So the shop has to have actually paid for this app before this charge
     * activated. Where it has not, `billing_on` decides, which is right in both
     * directions.
     */
    const paidSince = firstPaidAt.get(`${charge.app_id} ${charge.shop_id}`);

    /**
     * Had this shop paid for this app before this charge activated?
     *
     * The charge's own first sale does not count — that lands *after* its
     * activation — so this is true only of a merchant who was already a
     * customer, which is the one thing in the feed that tells a trial apart
     * from a billing anchor the merchant has already paid for.
     */
    const paidBefore = Boolean(
      activatedAt && paidSince && paidSince <= activatedAt,
    );

    const continuesPaidRelationship = Boolean(
      activatedAt &&
      paidBefore &&
      (siblings.get(`${charge.app_id} ${charge.shop_id}`) ?? []).some(
        (other) =>
          other.charge_id !== charge.charge_id &&
          other.canceled_at !== null &&
          withinSeconds(
            other.canceled_at,
            activatedAt,
            PLAN_CHANGE_WINDOW_SECONDS,
          ),
      ),
    );

    /**
     * Whether this charge was billed the moment it activated.
     *
     * This is a fact about the past, and a later cancellation cannot change it.
     * The condition used to be gated on `!churnAt`, which retroactively unmade
     * the payment of anyone who paid up front and then left: `conversion_at`
     * went null, so a shop that really did pay never entered MRR at all, and
     * the trial ladder below fell through to its churn branch and invented a
     * trial they never had.
     */
    const billedAtActivation =
      Boolean(activatedAt) &&
      (continuesPaidRelationship ||
        (billingGapDays !== null && billingGapDays >= cycleDays));

    // The MRR gate is the first real payment, not activation: a subscription in
    // trial is live but worth nothing.
    let conversionAt: string | null;
    if (amount <= 0) {
      conversionAt = activatedAt;
    } else if (sale) {
      conversionAt = sale.first_sale_at;
    } else if (activatedAt && activatedAt < CHARGE_ID_AVAILABLE_FROM) {
      conversionAt = activatedAt;
    } else if (billedAtActivation) {
      conversionAt = activatedAt;
    } else if (charge.billing_on && charge.billing_on <= now && !churnAt) {
      // The billing date passed with no cancellation, so the merchant was
      // charged; the transaction simply has not settled into the payout feed
      // yet. Without this, every shop that converted in the last couple of
      // weeks reads as unpaid.
      conversionAt = charge.billing_on;
    } else {
      conversionAt = null;
    }

    /**
     * When a trial window would close. `billing_on` states it outright and is
     * preferred; without one, a settled payment that landed materially later
     * than activation is the only remaining sign the merchant was not charged
     * up front. The second is the weaker evidence — a payout batch lags the
     * charge by up to `SETTLEMENT_LAG_DAYS` — but it is all the history from
     * before `billing_on` was recorded has.
     */
    const trialEnd =
      charge.billing_on !== null
        ? billingGapDays !== null && billingGapDays > reporting.trialMinGapDays
          ? charge.billing_on
          : null
        : sale &&
            activatedAt &&
            daysBetween(activatedAt, sale.first_sale_at) >
              reporting.trialMinGapDays
          ? sale.first_sale_at
          : null;

    /**
     * Whether this charge ran a trial at all (spec 6.1).
     *
     * The spec derives trial state from a window already known to exist, and
     * only *then* lets an ending classify it. That order is the whole point: a
     * cancellation can say how a trial finished, never that there was one. The
     * ladder below used to ask the opposite question first — "did this charge
     * end before any payment settled?" — which is true of everyone who leaves
     * early, trial or not. So a returning merchant who paid up front and quit
     * two days later was recorded as a cancelled trial and announced as one,
     * while the payment they had actually made went unbooked.
     *
     * The default is therefore no trial, and a window has to be shown. Two
     * signals together show one, and neither carries alone:
     *
     *  - `billing_on` falls short of a full cycle, so Shopify is visibly
     *    *waiting* to charge rather than having charged already; and
     *  - the shop has not paid for this app before, because Shopify does not
     *    grant the same shop a second trial. A short gap on a returning
     *    customer is the remainder of a cycle they have already bought.
     *
     * The second is what `billing_on` cannot express on its own: a resubscribe
     * that inherits the previous charge's billing date is indistinguishable
     * from a fresh part-cycle trial by the gap alone.
     */
    const trialWindow =
      amount > 0 && activatedAt && !billedAtActivation && !paidBefore
        ? trialEnd
        : null;

    let trialStatus = "none";
    let trialEndsAt: string | null = null;
    if (trialWindow && activatedAt) {
      if (sale) {
        if (
          daysBetween(activatedAt, sale.first_sale_at) >
          reporting.trialMinGapDays
        ) {
          trialStatus = "converted";
          trialEndsAt = sale.first_sale_at;
        }
      } else if (churnAt) {
        // Spec 6.1's `canceled_during` and `canceled_after` both land here.
        // Which one it was is read downstream, off `churn_at` against
        // `trial_ends_at` — a comparison that only means anything because the
        // window above was established without consulting the churn.
        trialStatus = "canceled";
        trialEndsAt = trialWindow;
      } else if (trialWindow > now) {
        trialStatus = "in_trial";
        trialEndsAt = trialWindow;
      } else {
        // Past its billing date with no cancellation: it converted, and the
        // transaction is still in flight (see SETTLEMENT_LAG_DAYS).
        trialStatus = "converted";
        trialEndsAt = trialWindow;
      }
    } else if (
      amount > 0 &&
      activatedAt &&
      !billedAtActivation &&
      !charge.billing_on &&
      !sale &&
      !churnAt
    ) {
      // Activated, never billed, never cancelled, and no billing date to go on:
      // a genuine data gap rather than a trial outcome.
      trialStatus = "unknown";
    }

    derived.push({
      ...charge,
      charge_ref: chargeRef,
      billing_interval: billingInterval,
      monthly_amount: monthlyAmountFor(amount, billingInterval),
      conversion_at: conversionAt,
      churn_at: churnAt,
      churn_reason: churnReason,
      trial_started_at: trialStatus === "none" ? null : activatedAt,
      trial_ends_at: trialEndsAt,
      trial_status: trialStatus,
      is_plan_change: 0,
      paid_sale_count: sale?.paid_sale_count ?? 0,
      first_sale_at: sale?.first_sale_at ?? null,
      last_sale_at: sale?.last_sale_at ?? null,
    });
  }

  // A cancel immediately followed by a new charge on the same shop is an
  // upgrade or downgrade, not churn. Shopify models plan changes as a new
  // subscription, so without this every upgrade would read as a lost customer.
  const activationsByShop = new Map<string, string[]>();
  for (const row of derived) {
    if (!row.activated_at) continue;
    const key = `${row.app_id}\u0000${row.shop_id}`;
    const list = activationsByShop.get(key);
    if (list) list.push(row.activated_at);
    else activationsByShop.set(key, [row.activated_at]);
  }

  for (const row of derived) {
    if (!row.churn_at) continue;
    const churnAt = row.churn_at;
    const key = `${row.app_id}\u0000${row.shop_id}`;

    // §4.a: another charge on this install picked up where this one stopped.
    const replaced = (activationsByShop.get(key) ?? []).some(
      (at) =>
        at !== row.activated_at &&
        withinSeconds(churnAt, at, PLAN_CHANGE_WINDOW_SECONDS),
    );
    // §4.b: this charge's own activation arrived just ahead of its cancel.
    const reemitted = Boolean(
      row.activated_at &&
      withinSeconds(row.activated_at, churnAt, PLAN_CHANGE_REEMIT_SECONDS),
    );

    if (replaced || reemitted) {
      row.is_plan_change = 1;
      row.churn_reason = "plan_change";
    }
  }

  return derived;
}
