'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const api = require('../bili-live-prophecy.user.js');

test('only numeric room routes are accepted; official page is never mounted recursively', () => {
  assert.equal(api.roomIdFromPath('/23197314'), '23197314');
  assert.equal(api.roomIdFromPath('/23197314/'), '23197314');
  for (const path of ['/', '/0', '/01', '/p/html/live-app-guessing-game/index.html', '/23197314/foo', '//23197314']) {
    assert.equal(api.roomIdFromPath(path), null);
  }
});

test('canonical room and anchor use the real room-info response and a fixed official URL', () => {
  const context = api.parseRoomResponse({ code: 0, data: { room_id: 23197314, uid: 51628309 } });
  assert.deepEqual(context, { roomId: '23197314', anchorId: '51628309' });
  assert.equal(api.officialUrl(context), 'https://live.bilibili.com/p/html/live-app-guessing-game/index.html?roomId=23197314&anchorId=51628309');
  for (const response of [null, {}, { code: -101 }, { code: 0 }, { code: 0, data: { uid: 1 } }, { code: '0', data: { uid: 1, room_id: 2 } }]) {
    assert.throws(() => api.parseRoomResponse(response));
  }
  for (const id of [-1, 0, 0.5, Number.MAX_SAFE_INTEGER + 1, '1&anchorId=7', '<img>', '../2']) {
    assert.throws(() => api.officialUrl({ roomId: id, anchorId: '1' }));
  }
});

test('compatibility only runs at the official H5 path with room and anchor IDs', () => {
  assert.equal(api.isOfficialLocation(new URL(api.officialUrl({ roomId: '1', anchorId: '2' }))), true);
  for (const url of ['https://evil.invalid/p/html/live-app-guessing-game/index.html?roomId=1&anchorId=2',
    'https://live.bilibili.com/23197314', 'https://live.bilibili.com/p/html/live-app-guessing-game/index.html?roomId=1&anchorId=bad']) {
    assert.equal(api.isOfficialLocation(new URL(url)), false);
  }
});

test('fresh installation monitors new predictions but never enables automatic participation', () => {
  for (const value of [null, undefined, {}, { version: 99, enabled: true }, []]) {
    const prefs = api.normalizeSettings(value);
    assert.equal(prefs.enabled, false);
    assert.equal(prefs.overlayEnabled, true);
    assert.equal(prefs.maxTicket, 1);
    assert.equal(prefs.minBalance, 10);
  }
});

test('persisted automatic configuration requires explicit boolean, valid budgets and account/anchor binding', () => {
  const valid = { version: 1, enabled: true, overlayEnabled: false, strategy: 'higher',
    maxTicket: 3, minBalance: 20, authorizedViewerId: '10000001', authorizedAnchorId: '51628309' };
  assert.deepEqual(api.normalizeSettings(valid), valid);
  for (const invalid of [{ enabled: 'true' }, { maxTicket: 1.5 }, { maxTicket: 0 }, { minBalance: -1 },
    { minBalance: 0.5 }, { strategy: 'random' }, { authorizedViewerId: null }, { authorizedAnchorId: null }]) {
    assert.equal(api.normalizeSettings({ ...valid, ...invalid }).enabled, false, JSON.stringify(invalid));
  }
});

test('shipped policy is available without browser or credential globals', () => {
  assert.equal(api.ProphecyPolicy.evaluateAutoCandidate().reason, 'disabled');
  assert.equal(api.ProphecyPolicy.chooseAnswer({ a: 2, b: 8 }, 'higher').answer, 1);
  assert.equal(api.ProphecyPolicy.chooseAnswer({ a: 2, b: 8 }, 'lower').answer, 2);
  assert.deepEqual(api.ProphecyPolicy.DEFAULT_SETTINGS, { enabled: false, strategy: 'lower', maxTicket: 1, minBalance: 10 });
});
