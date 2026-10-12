'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
// Exercise the implementation that is actually shipped in the userscript.
// The isolated VM check below also loads this same released file.
const policy = require('../bili-live-prophecy.user.js').ProphecyPolicy;

function fixture() {
  return {
    viewerId: 7001, anchorId: 8001, balance: 10,
    serverNowMs: 2000000000000 - 5000, clockAgeMs: 0,
    settings: { enabled: true },
    item: { my_answer: 0, prophet: {
      prophet_id: 901, prophet_status: 1, count_down_time: 2000000000,
      smh_spend: 1, answer_count: { a: 2, b: 8 }
    } }
  };
}

const evaluate = (input) => policy.evaluateAutoCandidate(input);
function expectSkip(input, reason) {
  assert.deepEqual(evaluate(input), { ok: false, reason });
}

test('automation defaults to off; enabling preserves explicit default budget and lower strategy', () => {
  assert.deepEqual(policy.DEFAULT_SETTINGS, { enabled: false, strategy: 'lower', maxTicket: 1, minBalance: 10 });
  expectSkip(undefined, 'disabled');
  const result = evaluate(fixture());
  assert.equal(result.ok, true);
  assert.equal(result.answer, 2);
  assert.equal(result.ticket, 1);
});

test('potential odds include this account in the selected denominator', () => {
  const high = policy.chooseAnswer({ a: 2, b: 8 }, 'higher');
  const low = policy.chooseAnswer({ a: 2, b: 8 }, 'lower');
  assert.deepEqual(high.odds, { numerator: 8, denominator: 3, multiplier: 8 / 3 });
  assert.deepEqual(low.odds, { numerator: 2, denominator: 9, multiplier: 2 / 9 });
  assert.equal(high.answer, 1);
  assert.equal(low.answer, 2);
});

test('empty sides do not produce Infinity; exact ties have a deterministic A choice', () => {
  assert.equal(policy.chooseAnswer({ a: 0, b: 1 }, 'higher').odds.multiplier, 1);
  assert.equal(policy.chooseAnswer({ a: 0, b: 1 }, 'lower').odds.multiplier, 0);
  for (const count of [0, 1, 32]) for (const strategy of ['higher', 'lower']) {
    const result = policy.chooseAnswer({ a: count, b: count }, strategy);
    assert.equal(result.answer, 1);
    assert.equal(result.tied, true);
    assert.equal(result.odds.denominator, count + 1);
  }
});

test('higher/lower choices remain distinct when display rounding hides the difference', () => {
  const counts = { a: Number.MAX_SAFE_INTEGER - 3, b: Number.MAX_SAFE_INTEGER - 2 };
  assert.equal(policy.chooseAnswer(counts, 'higher').answer, 1);
  assert.equal(policy.chooseAnswer(counts, 'lower').answer, 2);
});

test('side reversal reverses the selected answer for every non-tie sample', () => {
  for (const a of [0, 1, 2, 7, 100, 1000000]) for (const b of [0, 1, 3, 8, 100, 9000000]) {
    if (a === b) continue;
    for (const strategy of ['higher', 'lower']) {
      const direct = policy.chooseAnswer({ a, b }, strategy);
      const reversed = policy.chooseAnswer({ a: b, b: a }, strategy);
      assert.equal(direct.answer + reversed.answer, 3);
    }
  }
});

test('clock window includes exactly five seconds and excludes the deadline', () => {
  for (const [remainingMs, allowed] of [[5000.001, false], [5000, true], [4999, true], [0.001, true], [0, false], [-1, false]]) {
    const input = fixture();
    input.serverNowMs = input.item.prophet.count_down_time * 1000 - remainingMs;
    const result = evaluate(input);
    assert.equal(result.ok, allowed, `remaining=${remainingMs}`);
  }
});

test('server calibration must exist and remain at most fifteen seconds old', () => {
  for (const age of [undefined, null, NaN, Infinity, -1, '0']) {
    const input = fixture(); input.clockAgeMs = age;
    expectSkip(input, 'invalid_clock');
  }
  const current = fixture(); current.clockAgeMs = 15000;
  assert.equal(evaluate(current).ok, true);
  current.clockAgeMs = 15000.001;
  expectSkip(current, 'stale_clock');
});

test('unknown or unsafe server time/deadline cannot fall through to an automatic action', () => {
  for (const value of [undefined, null, NaN, Infinity, -1, 0, '2000000000', Number.MAX_SAFE_INTEGER + 1]) {
    const input = fixture(); input.serverNowMs = value;
    expectSkip(input, 'invalid_clock');
  }
  for (const value of [undefined, null, NaN, Infinity, -1, 0, '2000000000', Number.MAX_SAFE_INTEGER]) {
    const input = fixture(); input.item.prophet.count_down_time = value;
    expectSkip(input, 'invalid_deadline');
  }
});

test('minimum balance is explicitly before participation, not a retained reserve', () => {
  const input = fixture();
  input.balance = 10; input.settings.minBalance = 10;
  const result = evaluate(input);
  assert.equal(result.ok, true);
  assert.equal(result.balanceAfter, 9);
  input.balance = 9;
  expectSkip(input, 'balance_below_minimum');
});

test('affordability is an independent requirement even after meeting the balance threshold', () => {
  const input = fixture();
  input.settings.minBalance = 0; input.settings.maxTicket = 20;
  input.item.prophet.smh_spend = 11; input.balance = 10;
  expectSkip(input, 'insufficient_balance');
});

test('ticket cap includes equality and rejects a changed price beyond the cap', () => {
  const input = fixture();
  assert.equal(evaluate(input).ok, true);
  input.item.prophet.smh_spend = 2;
  expectSkip(input, 'ticket_limit');
  input.settings.maxTicket = 0; input.item.prophet.smh_spend = 1;
  expectSkip(input, 'ticket_limit');
});

test('invalid amounts and unknown balances fail closed instead of coercing strings', () => {
  for (const value of [undefined, null, NaN, Infinity, -1, 0, 0.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    const input = fixture(); input.item.prophet.smh_spend = value;
    expectSkip(input, 'invalid_ticket');
  }
  for (const value of [undefined, null, NaN, Infinity, -1, 0.5, '10', Number.MAX_SAFE_INTEGER + 1]) {
    const input = fixture(); input.balance = value;
    expectSkip(input, 'unknown_balance');
  }
});

test('already answered, closed and malformed participation states cannot be chosen', () => {
  for (const status of [0, 2, 3, 4, '1', undefined]) {
    const input = fixture(); input.item.prophet.prophet_status = status;
    expectSkip(input, 'not_open');
  }
  for (const answer of [1, 2, -1, '0', undefined, null, NaN]) {
    const input = fixture(); input.item.my_answer = answer;
    expectSkip(input, 'already_answered_or_unknown');
  }
});

test('manual intent blocks auto even if the user did not complete manual participation', () => {
  const input = fixture(); input.manualIntent = true;
  expectSkip(input, 'manual_intent');
});

test('a recorded attempt remains ineligible after a failed or unknown outcome', () => {
  const input = fixture(); input.attempted = true;
  expectSkip(input, 'already_attempted');
});

test('identity normalization catches own predictions without number/string mismatches', () => {
  const input = fixture(); input.viewerId = '8001';
  expectSkip(input, 'own_prediction');
  for (const value of [0, -1, null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '01', '../1']) {
    const other = fixture(); other.viewerId = value;
    expectSkip(other, 'invalid_identity');
  }
});

test('attempt keys isolate both accounts and anchors for the same prediction ID', () => {
  assert.equal(policy.makeAttemptKey({ viewerId: 1, anchorId: '2', prophetId: 3 }), '1:2:3');
  assert.notEqual(policy.makeAttemptKey({ viewerId: 1, anchorId: 2, prophetId: 3 }), policy.makeAttemptKey({ viewerId: 4, anchorId: 2, prophetId: 3 }));
  assert.notEqual(policy.makeAttemptKey({ viewerId: 1, anchorId: 2, prophetId: 3 }), policy.makeAttemptKey({ viewerId: 1, anchorId: 4, prophetId: 3 }));
  assert.equal(policy.makeAttemptKey({ viewerId: Number.MAX_SAFE_INTEGER + 1, anchorId: 2, prophetId: 3 }), null);
});

test('reward uses integer floor after multiplying the ticket price', () => {
  const input = fixture(); input.settings = { enabled: true, strategy: 'higher', maxTicket: 5, minBalance: 0 };
  input.item.prophet.smh_spend = 5;
  assert.equal(evaluate(input).expectedReward, 13);
  input.item.prophet.answer_count = { a: 0, b: Number.MAX_SAFE_INTEGER - 1 };
  expectSkip(input, 'unsafe_reward');
});

test('malformed counts and settings never default into a permitted action', () => {
  for (const value of [undefined, null, NaN, Infinity, -1, 1.2, '2', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    const input = fixture(); input.item.prophet.answer_count.a = value;
    expectSkip(input, 'invalid_counts');
  }
  for (const change of [{ enabled: 'true' }, { strategy: 'random' }, { maxTicket: '1' }, { minBalance: -1 }, { maxTicket: NaN }, { minBalance: Infinity }]) {
    const input = fixture(); input.settings = { enabled: true, ...change };
    expectSkip(input, 'invalid_settings');
  }
});

test('re-evaluation invalidates a previously eligible plan after state or settings change', () => {
  const input = fixture();
  assert.equal(evaluate(input).ok, true);
  input.settings.enabled = false;
  expectSkip(input, 'disabled');
  input.settings.enabled = true; input.item.my_answer = 2;
  expectSkip(input, 'already_answered_or_unknown');
  input.item.my_answer = 0; input.serverNowMs = input.item.prophet.count_down_time * 1000;
  expectSkip(input, 'closed');
});

test('released policy loads without browser globals and preserves input purity', () => {
  const input = fixture(); const before = JSON.stringify(input);
  Object.freeze(input.settings); Object.freeze(input.item.prophet.answer_count);
  Object.freeze(input.item.prophet); Object.freeze(input.item); Object.freeze(input);
  const result = evaluate(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.odds), true);
  const context = vm.createContext({ module: { exports: {} } });
  vm.runInContext(fs.readFileSync(require.resolve('../bili-live-prophecy.user.js'), 'utf8'), context);
  const isolatedPolicy = context.module.exports.ProphecyPolicy;
  assert.equal(isolatedPolicy.DEFAULT_SETTINGS.enabled, false);
  assert.equal(isolatedPolicy.chooseAnswer({ a: 2, b: 8 }, 'higher').answer, 1);
});
