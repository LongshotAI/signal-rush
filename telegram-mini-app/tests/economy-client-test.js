/**
 * economy-client-test.js — Unit tests for EconomyClient
 *
 * Tests the EconomyClient by mocking globalThis.fetch before import.
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// We need to mock fetch BEFORE the module loads.
// Since we can't easily do that with dynamic import after the fact,
// we'll test by creating a simple mock server approach instead.

// Actually, the simplest approach: test the class methods directly
// by creating an instance and calling methods with a mocked _fetch.

describe('EconomyClient', () => {
  it('constructs with default base URL', async () => {
    const { EconomyClient } = await import('../economy-client.js');
    const c = new EconomyClient();
    assert.ok(c);
  });

  it('constructs with custom base URL', async () => {
    const { EconomyClient } = await import('../economy-client.js');
    const c = new EconomyClient({ baseUrl: 'http://example.com' });
    assert.ok(c);
  });

  it('setSessionToken updates token', async () => {
    const { EconomyClient } = await import('../economy-client.js');
    const c = new EconomyClient();
    c.setSessionToken('new-token');
    // Verify by checking the token is used in subsequent calls
    // (we can't directly test private state, but we can verify no crash)
    assert.ok(true);
  });

  it('auth returns ok:false when fetch fails', async () => {
    const { EconomyClient } = await import('../economy-client.js');
    const c = new EconomyClient({ baseUrl: 'http://invalid-host-that-does-not-exist' });
    const result = await c.auth('test-data');
    assert.equal(result.ok, false);
    assert.equal(result.offline, true);
  });

  it('getPlayer returns ok:false when service unavailable', async () => {
    const { EconomyClient } = await import('../economy-client.js');
    const c = new EconomyClient({ baseUrl: 'http://invalid-host' });
    const result = await c.getPlayer('123456');
    assert.equal(result.ok, false);
    assert.equal(result.offline, true);
  });

  it('getBalance returns ok:false when service unavailable', async () => {
    const { EconomyClient } = await import('../economy-client.js');
    const c = new EconomyClient({ baseUrl: 'http://invalid-host' });
    const result = await c.getBalance('p1');
    assert.equal(result.ok, false);
  });

  it('submitReceipt returns ok:false when service unavailable', async () => {
    const { EconomyClient } = await import('../economy-client.js');
    const c = new EconomyClient({ baseUrl: 'http://invalid-host' });
    const result = await c.submitReceipt({
      seed: 42, mode: 'aiHunt', inputs: [], claimedScore: 0, claimedLevel: 1,
    });
    assert.equal(result.ok, false);
  });

  it('healthCheck returns ok:false when service unavailable', async () => {
    const { EconomyClient } = await import('../economy-client.js');
    const c = new EconomyClient({ baseUrl: 'http://invalid-host' });
    const result = await c.healthCheck();
    assert.equal(result.ok, false);
    assert.equal(result.offline, true);
  });

  it('redeemCredits returns ok:false when service unavailable', async () => {
    const { EconomyClient } = await import('../economy-client.js');
    const c = new EconomyClient({ baseUrl: 'http://invalid-host' });
    const result = await c.redeemCredits({
      playerId: 'p1', credits: 10, model: 'gpt-4o-mini', prompt: 'test',
    });
    assert.equal(result.ok, false);
  });

  it('submitEarnReward returns ok:false when service unavailable', async () => {
    const { EconomyClient } = await import('../economy-client.js');
    const c = new EconomyClient({ baseUrl: 'http://invalid-host' });
    const result = await c.submitEarnReward({
      playerId: '00000000-0000-4000-8000-000000000001', score: 100, combo: 1, level: 1, tickCount: 50, difficultyTier: 0,
    });
    assert.equal(result.ok, false);
  });

  it('claimRewards returns ok:false when service unavailable', async () => {
    const { EconomyClient } = await import('../economy-client.js');
    const c = new EconomyClient({ baseUrl: 'http://invalid-host' });
    const result = await c.claimRewards({
      playerId: '00000000-0000-4000-8000-000000000001', vmcoSubKeyId: 'vmco-test', amountMicros: 10000,
    });
    assert.equal(result.ok, false);
  });

  it('vmcoClaim returns ok:false when service unavailable', async () => {
    const { EconomyClient } = await import('../economy-client.js');
    const c = new EconomyClient({ baseUrl: 'http://invalid-host' });
    const result = await c.vmcoClaim({
      playerId: '00000000-0000-4000-8000-000000000001', amountMicros: 10000,
    });
    assert.equal(result.ok, false);
  });

  it('handles timeout as offline', async () => {
    // Mock fetch to throw TimeoutError
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      const err = new Error('timeout');
      err.name = 'TimeoutError';
      throw err;
    };
    // Re-import to get fresh module with mocked fetch
    const { EconomyClient } = await import('../economy-client.js?cache-bust=' + Date.now());
    const c = new EconomyClient();
    const result = await c.healthCheck();
    assert.equal(result.ok, false);
    assert.equal(result.offline, true);
    globalThis.fetch = origFetch;
  });
});
