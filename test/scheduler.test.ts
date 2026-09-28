import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { resetEnvironment } from './helpers.js';
import {
  backoffDelayMs,
  onSyncComplete,
  resetSyncScheduler,
  runSyncNow,
  setSyncRunner,
  syncStatus,
  type SyncOutcome,
} from '../src/sync/scheduler.js';
import type { SyncResult } from '../src/sync/index.js';

const EMPTY: SyncResult = {
  apps: [],
  transactions: 0,
  events: 0,
  subscriptions: 0,
  installs: 0,
  customerEvents: 0,
};

/** A runner whose completion the test controls. */
function deferred() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const run = async (): Promise<SyncResult> => {
    calls += 1;
    await gate;
    return EMPTY;
  };
  return { run, release, get calls() { return calls; } };
}

describe('background sync loop', () => {
  beforeEach(() => {
    resetEnvironment();
    resetSyncScheduler();
  });
  afterEach(() => resetSyncScheduler());

  it('never runs two syncs at once', async () => {
    const runner = deferred();
    setSyncRunner(runner.run);

    // A second caller arriving mid-run joins the first rather than starting
    // another pass over the same watermarks.
    const first = runSyncNow();
    const second = runSyncNow();
    assert.equal(runner.calls, 1);
    assert.equal(syncStatus().running, true);

    runner.release();
    await Promise.all([first, second]);
    assert.equal(runner.calls, 1);
    assert.equal(syncStatus().running, false);
  });

  it('starts a fresh run once the previous one has finished', async () => {
    let calls = 0;
    setSyncRunner(async () => {
      calls += 1;
      return EMPTY;
    });

    await runSyncNow();
    await runSyncNow();
    assert.equal(calls, 2);
  });

  it('records a failure without leaving the loop wedged', async () => {
    setSyncRunner(async () => {
      throw new Error('Partner API token was revoked');
    });

    const outcome = await runSyncNow();
    assert.equal(outcome.result, null);
    assert.match(outcome.error?.message ?? '', /revoked/);

    const status = syncStatus();
    assert.equal(status.running, false);
    assert.equal(status.consecutiveFailures, 1);
    assert.match(status.lastError ?? '', /revoked/);
    assert.equal(status.lastSuccessAt, null);
  });

  it('clears the failure streak on the next success', async () => {
    setSyncRunner(async () => {
      throw new Error('network down');
    });
    await runSyncNow();
    await runSyncNow();
    assert.equal(syncStatus().consecutiveFailures, 2);

    setSyncRunner(async () => EMPTY);
    await runSyncNow();

    const status = syncStatus();
    assert.equal(status.consecutiveFailures, 0);
    assert.equal(status.lastError, null);
    assert.ok(status.lastSuccessAt);
  });

  it('backs off geometrically while failing and caps the wait', () => {
    assert.equal(backoffDelayMs(5, 0), 5 * 60_000);
    assert.equal(backoffDelayMs(5, 1), 10 * 60_000);
    assert.equal(backoffDelayMs(5, 2), 20 * 60_000);
    // Capped, so an instance still recovers unattended once the cause is fixed.
    assert.equal(backoffDelayMs(5, 3), 30 * 60_000);
    assert.equal(backoffDelayMs(5, 99), 30 * 60_000);
  });

  it('hands every outcome to subscribers', async () => {
    const seen: SyncOutcome[] = [];
    const unsubscribe = onSyncComplete((outcome) => seen.push(outcome));

    setSyncRunner(async () => ({ ...EMPTY, transactions: 3 }));
    await runSyncNow();

    setSyncRunner(async () => {
      throw new Error('boom');
    });
    await runSyncNow();

    assert.equal(seen.length, 2);
    assert.equal(seen[0]?.result?.transactions, 3);
    assert.equal(seen[1]?.error?.message, 'boom');

    unsubscribe();
    setSyncRunner(async () => EMPTY);
    await runSyncNow();
    assert.equal(seen.length, 2);
  });

  it('survives a subscriber that throws', async () => {
    onSyncComplete(() => {
      throw new Error('slack webhook exploded');
    });
    setSyncRunner(async () => EMPTY);

    const outcome = await runSyncNow();
    assert.equal(outcome.error, null);
    assert.equal(syncStatus().consecutiveFailures, 0);
  });
});
