// ==UserScript==
// @name         B站直播预言 · 官方面板入口
// @namespace    local.bili-live-prophecy
// @version      1.0.0
// @description  底部居中精简参与卡片、全屏浮窗，以及默认关闭的最后5秒自动参与（赔率/门票/余额可配置）。
// @match        https://live.bilibili.com/*
// @run-at       document-end
// @grant        none
// @license      MIT
// @homepageURL  https://github.com/Glasden/bili-live-prophecy
// @supportURL   https://github.com/Glasden/bili-live-prophecy/issues
// @updateURL    https://raw.githubusercontent.com/Glasden/bili-live-prophecy/main/bili-live-prophecy.user.js
// @downloadURL  https://raw.githubusercontent.com/Glasden/bili-live-prophecy/main/bili-live-prophecy.user.js
// ==/UserScript==

(function () {
  'use strict';
  // The official SDK keeps login, cookies, CSRF and request encoding local.
  // Manual participation retains a trusted browser confirmation. The optional
  // automated path has an independent policy, account lock and attempt record.
  const ROOM_INFO = 'https://api.live.bilibili.com/room/v1/Room/get_info';
  const OFFICIAL_PAGE = 'https://live.bilibili.com/p/html/live-app-guessing-game/index.html';
  const HOST_ID = 'bili-live-prophecy-entry';
  const COMPAT_ID = 'bili-live-prophecy-compat';

'use strict';

// Pure policy: no DOM, storage, clocks, credentials or network access.
// Can be pasted inside the userscript IIFE; Node can require this file directly.
const ProphecyPolicy = (() => {
  const AUTO_WINDOW_MS = 5000;
  const MAX_CLOCK_AGE_MS = 15000;
  const DEFAULT_SETTINGS = Object.freeze({
    enabled: false, strategy: 'lower', maxTicket: 1, minBalance: 10
  });

  const record = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
  const safeWhole = (value) => Number.isSafeInteger(value) && value >= 0;
  const safeMillis = (value) => typeof value === 'number' && Number.isFinite(value) &&
    value >= 0 && value <= Number.MAX_SAFE_INTEGER;
  const skip = (reason) => Object.freeze({ ok: false, reason });

  function numericId(value) {
    if (typeof value === 'number') return safeWhole(value) && value > 0 ? String(value) : null;
    return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? value : null;
  }

  function normalizeSettings(input = {}) {
    if (!record(input)) return skip('invalid_settings');
    const settings = {};
    for (const name of Object.keys(DEFAULT_SETTINGS)) {
      settings[name] = input[name] === undefined ? DEFAULT_SETTINGS[name] : input[name];
    }
    if (typeof settings.enabled !== 'boolean' ||
        !['higher', 'lower'].includes(settings.strategy) ||
        !safeWhole(settings.maxTicket) || !safeWhole(settings.minBalance)) {
      return skip('invalid_settings');
    }
    return Object.freeze({ ok: true, settings: Object.freeze(settings) });
  }

  function makeAttemptKey({ viewerId, anchorId, prophetId } = {}) {
    const ids = [viewerId, anchorId, prophetId].map(numericId);
    return ids.every(Boolean) ? ids.join(':') : null;
  }

  function chooseAnswer(answerCount, strategy) {
    if (!['higher', 'lower'].includes(strategy)) return skip('invalid_strategy');
    if (!record(answerCount) || !safeWhole(answerCount.a) || !safeWhole(answerCount.b) ||
        answerCount.a === Number.MAX_SAFE_INTEGER || answerCount.b === Number.MAX_SAFE_INTEGER) {
      return skip('invalid_counts');
    }
    const { a, b } = answerCount;
    // A = b/(a+1), B = a/(b+1). Compare exact cross-products; do not
    // compare rounded display odds or substitute the current unadjusted odds.
    const left = BigInt(b) * (BigInt(b) + 1n);
    const right = BigInt(a) * (BigInt(a) + 1n);
    const tied = left === right;
    const answer = tied || (strategy === 'higher' ? left > right : left < right) ? 1 : 2;
    const numerator = answer === 1 ? b : a;
    const denominator = (answer === 1 ? a : b) + 1;
    return Object.freeze({
      ok: true, answer, tied,
      odds: Object.freeze({ numerator, denominator, multiplier: numerator / denominator })
    });
  }

  function evaluateAutoCandidate({
    item, viewerId, anchorId, balance, serverNowMs, clockAgeMs, settings = {},
    manualIntent = false, attempted = false
  } = {}) {
    const normalized = normalizeSettings(settings);
    if (!normalized.ok) return normalized;
    const prefs = normalized.settings;
    if (!prefs.enabled) return skip('disabled');
    if (manualIntent) return skip('manual_intent');
    if (attempted) return skip('already_attempted');

    const uid = numericId(viewerId);
    const anchor = numericId(anchorId);
    if (!uid || !anchor) return skip('invalid_identity');
    if (uid === anchor) return skip('own_prediction');
    if (!record(item) || !record(item.prophet)) return skip('invalid_prediction');
    const prophet = item.prophet;
    const prophetId = numericId(prophet.prophet_id);
    if (!prophetId) return skip('invalid_prediction');
    if (prophet.prophet_status !== 1) return skip('not_open');
    if (item.my_answer !== 0) return skip('already_answered_or_unknown');

    if (!safeMillis(serverNowMs) || serverNowMs <= 0 || !safeMillis(clockAgeMs)) {
      return skip('invalid_clock');
    }
    if (clockAgeMs > MAX_CLOCK_AGE_MS) return skip('stale_clock');
    if (!safeWhole(prophet.count_down_time) || prophet.count_down_time <= 0 ||
        !Number.isSafeInteger(prophet.count_down_time * 1000)) return skip('invalid_deadline');
    const deadlineMs = prophet.count_down_time * 1000;
    const remainingMs = deadlineMs - serverNowMs;
    if (remainingMs <= 0) return skip('closed');
    if (remainingMs > AUTO_WINDOW_MS) return skip('too_early');

    const ticket = prophet.smh_spend;
    if (!safeWhole(ticket) || ticket <= 0) return skip('invalid_ticket');
    if (ticket > prefs.maxTicket) return skip('ticket_limit');
    if (!safeWhole(balance)) return skip('unknown_balance');
    // User preference is the balance BEFORE participating, independently of
    // whether the account can afford this ticket. It is not a retained balance.
    if (balance < prefs.minBalance) return skip('balance_below_minimum');
    if (balance < ticket) return skip('insufficient_balance');

    const choice = chooseAnswer(prophet.answer_count, prefs.strategy);
    if (!choice.ok) return choice;
    const reward = BigInt(ticket) * BigInt(choice.odds.numerator) / BigInt(choice.odds.denominator);
    if (reward > BigInt(Number.MAX_SAFE_INTEGER)) return skip('unsafe_reward');

    return Object.freeze({
      ok: true,
      prophetId, viewerId: uid, anchorId: anchor,
      attemptKey: makeAttemptKey({ viewerId: uid, anchorId: anchor, prophetId }),
      answer: choice.answer, tied: choice.tied, odds: choice.odds,
      ticket, expectedReward: Number(reward), balanceAfter: balance - ticket,
      deadlineMs, remainingMs
    });
  }

  return Object.freeze({
    AUTO_WINDOW_MS, MAX_CLOCK_AGE_MS, DEFAULT_SETTINGS,
    normalizeSettings, makeAttemptKey, chooseAnswer, evaluateAutoCandidate
  });
})();

  function isOfficialLocation(location) {
    if (!location || location.hostname !== 'live.bilibili.com' ||
        location.pathname !== '/p/html/live-app-guessing-game/index.html') return false;
    const params = new URLSearchParams(location.search);
    return Boolean(numericId(params.get('roomId')) &&
      numericId(params.get('anchorId') || params.get('anchorUid')));
  }

  function installOfficialCompatibility(win, doc) {
    if (!isOfficialLocation(win.location) || doc.getElementById(COMPAT_ID)) return null;
    // The userscript also runs in the official iframe itself. It does not depend
    // on parent/child document.domain compatibility or on parent login globals.
    if (/BiliApp/i.test(win.navigator.userAgent)) return null;

    function el(tag, className, content) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (content !== undefined) node.textContent = content;
      return node;
    }

    const host = el('div');
    host.id = COMPAT_ID;
    host.dataset.version = '1.0.0';
    host.dataset.state = 'loading';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = el('style');
    style.textContent = `
      :host { color-scheme: dark; font: 14px/1.6 -apple-system,BlinkMacSystemFont,
        "Segoe UI","Microsoft YaHei",sans-serif; color: #edf2f8; }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      .state { position: fixed; z-index: 100002; top: 10px; right: 12px;
        max-width: calc(100vw - 95px); padding: 2px 7px; border-radius: 5px;
        background: #272936ed; color: #d6d9e3; font-size: 10px; pointer-events: none; }
      .state.error { color: #ffcfab; }
      dialog { width: calc(100vw - 32px); max-width: 400px; max-height: calc(100dvh - 32px);
        margin: auto; padding: 22px; overflow: auto; border: 1px solid #666279;
        border-radius: 14px; background: #232431; color: #f5f2f7;
        box-shadow: 0 16px 60px #0007; font: inherit; }
      dialog::backdrop { background: #090b13aa; }
      .eyebrow { margin: 0 0 8px; color: #f5a9c2; font-size: 12px; }
      h2 { margin: 0 0 16px; font-size: 18px; line-height: 1.5; overflow-wrap: anywhere; }
      .message { margin: 0 0 14px; white-space: pre-line; overflow-wrap: anywhere; }
      .notice { margin: 12px 0 0; color: #cad0df; font-size: 12px; }
      .actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 10px; margin-top: 22px; }
      button { min-height: 38px; border: 1px solid #656a7e; border-radius: 7px;
        padding: 7px 15px; background: #323747; color: #f5f2f7; font: inherit; cursor: pointer; }
      .confirm { background: #fb7299; border-color: #fb7299; color: #191523; font-weight: 650; }
      button:focus-visible { outline: 2px solid #a4e5f0; outline-offset: 3px; }
      .toast { position: fixed; z-index: 100003; bottom: 66px; left: 12px; right: 12px;
        width: max-content; max-width: calc(100vw - 24px); margin: auto; padding: 10px 15px;
        border: 1px solid #69677d; border-radius: 8px; background: #242635f5;
        color: #f5f2f7; white-space: pre-line; overflow-wrap: anywhere; pointer-events: none; }
    `;
    const state = el('div', 'state', '正在适配 PC 确认…');
    state.setAttribute('role', 'status');
    const toast = el('div', 'toast');
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.hidden = true;
    shadow.append(style, state, toast);
    doc.body.append(host);

    let disposed = false;
    let runtime = null;
    let queued = false;
    let sdk = null;
    let engine = null;
    let originals = null;
    let active = null;
    let attempts = 0;
    let pollTimer = null;
    let toastTimer = null;

    function showToast(options = {}) {
      if (disposed) return Promise.resolve();
      win.clearTimeout(toastTimer);
      toast.textContent = String(options.msg || '请查看预言状态。');
      toast.hidden = false;
      toastTimer = win.setTimeout(() => { toast.hidden = true; }, 5000);
      return Promise.resolve();
    }

    function showConfirm(options = {}) {
      // Never drain an old native bridge queue, retry a prior selection or
      // auto-confirm. An overlapping prompt is cancelled instead of queued.
      if (disposed || active || !isOfficialLocation(win.location)) {
        return Promise.resolve({ confirm: false, cancel: true });
      }
      return new Promise((resolve) => {
        const previousFocus = doc.activeElement;
        const openedUrl = win.location.href;
        const dialog = el('dialog');
        const isJoin = String(options.content || '').startsWith('我猜：');
        dialog.setAttribute('aria-labelledby', 'bili-prophecy-confirm-title');
        const title = el('h2', '', String(options.title || '请确认'));
        title.id = 'bili-prophecy-confirm-title';
        dialog.append(el('p', 'eyebrow', isJoin ? '确认你的预言' : '预言提示'), title,
          el('p', 'message', String(options.content || '')));
        if (isJoin) dialog.append(el('p', 'notice', '确认后将消耗该预言标示的门票硬币。'));
        const actions = el('div', 'actions');
        const cancel = el('button', 'cancel', String(options.cancelText || '取消'));
        const confirm = el('button', 'confirm', String(options.confirmText || '确认'));
        cancel.type = confirm.type = 'button';
        actions.append(cancel, confirm);
        dialog.append(actions);
        shadow.append(dialog);

        let settled = false;
        function finish(value) {
          if (settled) return;
          settled = true;
          const confirmed = Boolean(value && !disposed && win.location.href === openedUrl);
          active = null;
          if (engine && engine.publishDialog) engine.publishDialog(false);
          if (dialog.open) dialog.close();
          dialog.remove();
          const result = { confirm: confirmed, cancel: !confirmed };
          resolve(result);
          if (previousFocus && previousFocus.isConnected) previousFocus.focus();
        }
        active = { cancel: () => finish(false) };
        if (engine && engine.publishDialog) engine.publishDialog(true);
        cancel.addEventListener('click', () => finish(false));
        confirm.addEventListener('click', (event) => {
          // A synthetic click from page code cannot approve a coin expenditure.
          if (event.isTrusted) finish(true);
        });
        dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(false); });
        dialog.addEventListener('close', () => finish(false));
        try { dialog.showModal(); cancel.focus(); }
        catch (_) {
          finish(false);
          void showToast({ msg: '浏览器无法显示确认框，请更新浏览器后重试。' });
        }
      });
    }

    function fail() {
      host.dataset.state = 'error';
      state.classList.add('error');
      state.textContent = 'PC 适配未就绪，请刷新或更新脚本';
    }

    function restoreSdk() {
      if (!sdk || !originals) return;
      // Restore independently: a later SDK/extension setter must not leave the
      // other method patched or prevent cancellation and DOM cleanup.
      for (const [name, replacement] of [['showConfirm', showConfirm], ['showToast', showToast]]) {
        try { if (sdk[name] === replacement) sdk[name] = originals[name]; }
        catch (_) { /* Never overwrite a method now owned by another integration. */ }
      }
    }

    function poll() {
      if (disposed) return;
      if (!isOfficialLocation(win.location)) { dispose(); return; }
      attempts += 1;
      try {
        const chunks = win.webpackChunkguessing_game;
        if (!queued && Array.isArray(chunks)) {
          queued = true;
          chunks.push([[`bili-prophecy-compat-1.0.0-${Date.now()}`], {}, (require) => {
            if (!disposed) runtime = require;
          }]);
        }
        // Do not require a module before its factory arrives: Webpack can cache
        // incomplete exports after a missing-module exception.
        if (runtime && runtime.m && typeof runtime.m[1171] === 'function') {
          const candidate = runtime(1171).Ay;
          if (!candidate || candidate.version !== '2.0.1' ||
              typeof candidate.showConfirm !== 'function' || typeof candidate.showToast !== 'function' ||
              typeof candidate.getPlatformSync !== 'function' || typeof candidate.getEnvSync !== 'function') {
            fail(); return;
          }
          const platform = candidate.getPlatformSync();
          if (platform.isApp || platform.isPcApp || ![-1, 4, 5].includes(candidate.getEnvSync())) {
            host.dataset.state = 'native';
            state.hidden = true;
            return;
          }
          sdk = candidate;
          originals = { showConfirm: sdk.showConfirm, showToast: sdk.showToast };
          sdk.showConfirm = showConfirm;
          sdk.showToast = showToast;
          if (sdk.showConfirm !== showConfirm || sdk.showToast !== showToast) throw new Error('SDK is not writable');
          host.dataset.state = 'ready';
          state.textContent = 'PC 预言 · v1.0.0';
          try {
            engine = createChildEngine(win, doc, { runtime, sdk, showToast, showConfirm,
              policy: ProphecyPolicy, cancelDialog: () => { if (active) active.cancel(); } });
          } catch (_) {
            // New optional features must not remove the proven manual confirmation.
            state.textContent = '手动确认可用；增强功能未就绪';
            state.classList.add('error');
          }
          return;
        }
      } catch (_) { restoreSdk(); fail(); return; }
      if (attempts >= 100) { fail(); return; }
      pollTimer = win.setTimeout(poll, 200);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (active) active.cancel();
      win.clearTimeout(pollTimer);
      win.clearTimeout(toastTimer);
      win.removeEventListener('pagehide', onPageHide);
      if (engine) engine.dispose();
      restoreSdk();
      host.remove();
    }

    function onPageHide(event) {
      if (active) active.cancel();
      if (!event.persisted) dispose();
    }
    win.addEventListener('pagehide', onPageHide);
    poll();
    return Object.freeze({ dispose });
  }

  function numericId(value) {
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
    }
    return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? value : null;
  }

  function roomIdFromPath(pathname) {
    const match = /^\/([1-9]\d{0,19})\/?$/.exec(pathname);
    return match ? match[1] : null;
  }

  function parseRoomResponse(body) {
    if (!body || typeof body !== 'object' || body.code !== 0) {
      const code = Number.isSafeInteger(body && body.code) ? `（code ${body.code}）` : '';
      throw new Error(`直播间接口返回异常${code}。`);
    }
    const roomId = numericId(body.data && body.data.room_id);
    const anchorId = numericId(body.data && body.data.uid);
    if (!roomId || !anchorId) throw new Error('直播间接口缺少有效的房间或主播信息。');
    return Object.freeze({ roomId, anchorId });
  }

  function officialUrl(context) {
    const roomId = numericId(context && context.roomId);
    const anchorId = numericId(context && context.anchorId);
    if (!roomId || !anchorId) throw new Error('缺少有效的房间或主播信息。');
    const url = new URL(OFFICIAL_PAGE);
    url.searchParams.set('roomId', roomId);
    url.searchParams.set('anchorId', anchorId);
    return url.href;
  }

/* Official H5 child: observe the official SDK, preserve its manual controls,
 * and perform an explicitly enabled, account-bound last-five-seconds attempt.
 * This module never reads cookies, tokens, request headers or SDK credentials. */
function createChildEngine(win, doc, options) {
  'use strict';
  const { runtime, sdk, policy, showToast, showConfirm, cancelDialog } = options;
  const CHANNEL = 'bili-prophecy-v3';
  const ORIGIN = 'https://live.bilibili.com';
  const H5_PATH = '/p/html/live-app-guessing-game/index.html';
  const API = Object.freeze({
    list: '/xlive/app-ucenter/v1/elden/get_by_user',
    balance: '/xlive/app-ucenter/v1/elden/is_in_fans_group',
    time: '/xlive/open-interface/v1/rtc/getTimestamp',
    join: '/xlive/app-ucenter/v1/elden/user_join'
  });
  const PREFIX = 'bili-prophecy-v3:';
  const HEARTBEAT_MS = 8000;
  const FRESH_MS = 15000;
  const READ_TIMEOUT_MS = 3500;
  const noop = () => {};
  const whole = value => Number.isSafeInteger(value) && value >= 0;
  const id = value => typeof value === 'number'
    ? (whole(value) && value > 0 ? String(value) : null)
    : (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? value : null);
  const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const mono = () => win.performance.now();
  const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const textOnly = value => typeof value === 'string' ? value.slice(0, 1000) : '';
  function route() {
    try {
      const url = new win.URL(win.location.href);
      if (url.origin !== ORIGIN || url.pathname !== H5_PATH) return null;
      const roomId = id(url.searchParams.get('roomId'));
      const anchorId = id(url.searchParams.get('anchorId') || url.searchParams.get('anchorUid'));
      return roomId && anchorId ? { roomId, anchorId, hash: url.hash } : null;
    } catch (_) { return null; }
  }
  const originalRoute = route();
  if (!originalRoute || !policy || typeof sdk?.getUserInfo !== 'function') {
    return { dispose: noop, publishDialog: noop };
  }
  const embedded = win.parent !== win;
  let disposed = false;
  let suspended = false;
  let generation = 0;
  let configuration = null;
  let heartbeatAt = -Infinity;
  let viewerId = null;
  let identityAt = -Infinity;
  let identitySequence = 0;
  let balance = null;
  let rows = new Map();
  let listAt = -Infinity;
  let listStartedAt = -Infinity;
  let balanceStartedAt = -Infinity;
  let clock = null;
  let client = null;
  let rawGet = null;
  let rawPost = null;
  let getHook = null;
  let postHook = null;
  let refreshing = false;
  let busy = false;
  let storageFault = false;
  let dialogOpen = false;
  let lastSnapshotAt = -Infinity;
  let lastRefreshAt = -Infinity;
  let lastStatusKey = '';
  let statusUntil = -Infinity;
  let lastRouteKey = JSON.stringify(originalRoute);
  let lastRevealId = null;
  let manualBusy = false;
  let compactSelectedId = null;
  let compactCurrent = null;
  let compactPending = null;
  let compactFeedback = null;
  let compactLastHeight = 0;
  let compactCompatHost = null;
  let compactCompatStyle = null;
  let compactResizeObserver = null;
  const manualMemory = new Set();
  const pendingManual = new Set();
  const attemptedMemory = new Set();
  const pendingTimers = new Set();
  const navControllers = new Set();
  const manualSource = new Map();
  const capabilities = { locks: !!win.navigator.locks?.request, storage: false, requestGuard: false };

  function timer(callback, delay) {
    const handle = win.setTimeout(() => { pendingTimers.delete(handle); callback(); }, delay);
    pendingTimers.add(handle);
    return handle;
  }
  function stopTimer(handle) { win.clearTimeout(handle); pendingTimers.delete(handle); }
  function deadlineRead(promise) {
    let handle;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => { handle = timer(() => reject(new Error('read_timeout')), READ_TIMEOUT_MS); })
    ]).finally(() => stopTimer(handle));
  }
  function sameRoute() {
    const now = route();
    return !!now && now.roomId === originalRoute.roomId && now.anchorId === originalRoute.anchorId;
  }
  function detailVisible() {
    const now = route();
    return sameRoute() && !!now && ['', '#', '#/'].includes(now.hash);
  }
  function sampleClock(sample) {
    if (!sample) return { serverNowMs: null, clockAgeMs: null, uncertaintyMs: null };
    const elapsed = mono() - sample.at;
    if (elapsed < 0 || elapsed > FRESH_MS) {
      return { serverNowMs: null, clockAgeMs: Math.max(0, elapsed), uncertaintyMs: null };
    }
    return { serverNowMs: sample.serverMs + elapsed, clockAgeMs: elapsed,
      uncertaintyMs: 1000 + sample.rtt + 250 };
  }
  const currentClock = () => sampleClock(clock);
  function postParent(type, body = {}) {
    if (!embedded || !configuration || disposed) return;
    win.parent.postMessage({ channel: CHANNEL, type, nonce: configuration.nonce,
      roomId: originalRoute.roomId, anchorId: originalRoute.anchorId, ...body }, ORIGIN);
  }
  function status(text, level = 'info', stickyMs = 0) {
    if (!text) return;
    const key = level + ':' + text;
    if (stickyMs) statusUntil = mono() + stickyMs;
    if (key !== lastStatusKey) {
      lastStatusKey = key;
      postParent('status', { text, level });
    }
  }
  function toast(message) {
    try { Promise.resolve(showToast?.({ msg: message, duration: 2800 })).catch(noop); } catch (_) {}
  }
  function faultStorage() {
    storageFault = true;
    capabilities.storage = false;
    generation += 1;
    status('本地持久化不可用，自动参与已停止；手动请求使用本页去重', 'warn', 6000);
  }
  function storageRead(key) {
    if (storageFault) return { failed: true, present: true, value: null };
    try {
      const raw = win.localStorage.getItem(key);
      if (raw === null) return { failed: false, present: false, value: null };
      let value = null;
      try { value = JSON.parse(raw); } catch (_) {}
      // A malformed existing marker still prevents automatic resubmission.
      return { failed: false, present: true, value };
    } catch (_) { faultStorage(); return { failed: true, present: true, value: null }; }
  }
  function storageWrite(key, value) {
    if (storageFault) return false;
    try {
      const data = JSON.stringify(value);
      win.localStorage.setItem(key, data);
      if (win.localStorage.getItem(key) !== data) throw new Error('storage_verification');
      return true;
    } catch (_) { faultStorage(); return false; }
  }
  function probeStorage() {
    const key = PREFIX + 'probe:' + Math.random().toString(36).slice(2);
    try {
      win.localStorage.setItem(key, '1');
      if (win.localStorage.getItem(key) !== '1') throw new Error('storage_verification');
      win.localStorage.removeItem(key);
      capabilities.storage = true;
    } catch (_) { faultStorage(); }
  }
  const itemKey = (uid, pid) => uid + ':' + pid;
  const markerKey = (kind, uid, pid) => PREFIX + kind + ':' + itemKey(uid, pid);
  function manualMarked(uid, pid) {
    if (pendingManual.has(pid) || manualMemory.has(itemKey(uid, pid))) return true;
    return storageRead(markerKey('manual', uid, pid)).present;
  }
  function attemptMarked(uid, pid, manual = false) {
    if (attemptedMemory.has(itemKey(uid, pid))) return true;
    if (manual && storageFault) return false;
    const marker = storageRead(markerKey('attempt', uid, pid));
    if (manual && marker.failed) return false;
    // A failed read-only preflight suppresses auto but has not sent a join.
    if (manual && marker.present && marker.value?.phase === 'preflight-failed' &&
        marker.value?.committed === false) return false;
    return marker.present;
  }
  function markManual(uid, pid, answer, ticket = null) {
    if (!uid) { pendingManual.add(pid); return false; }
    const key = itemKey(uid, pid);
    manualMemory.add(key);
    manualSource.set(key, { answer, ticket, at: mono() });
    return storageWrite(markerKey('manual', uid, pid), {
      version: 1, viewerId: uid, anchorId: originalRoute.anchorId,
      prophetId: pid, atMs: Date.now()
    });
  }
  function markAttempt(uid, pid, mode, answer, phase, committed) {
    if (committed) attemptedMemory.add(itemKey(uid, pid));
    return storageWrite(markerKey('attempt', uid, pid), {
      version: 1, viewerId: uid, anchorId: originalRoute.anchorId,
      prophetId: pid, mode, answer, phase, committed, atMs: Date.now()
    });
  }
  function acceptIdentity(info) {
    const next = info && info.isLogin !== false && !info.isTourist ? id(info.uid) : null;
    identityAt = mono();
    if (viewerId !== next) {
      const previous = viewerId;
      viewerId = next;
      generation += 1;
      rows = new Map();
      balance = null;
      compactCurrent = null;
      compactSelectedId = null;
      compactFeedback = null;
      listAt = -Infinity;
      listStartedAt = -Infinity;
      balanceStartedAt = -Infinity;
      if (previous && previous !== next) status('账号已变化，请重新开启自动参与', 'warn', 6000);
      if (previous && previous !== next) try { cancelDialog?.(); } catch (_) {}
    }
    if (viewerId && pendingManual.size) {
      for (const pid of pendingManual) markManual(viewerId, pid, 0);
      pendingManual.clear();
    }
    return viewerId;
  }
  async function freshIdentity() {
    const epoch = generation;
    const sequence = ++identitySequence;
    const controller = new win.AbortController();
    navControllers.add(controller);
    const timeout = timer(() => controller.abort(), READ_TIMEOUT_MS);
    try {
      // The official WEB SDK uses this same read-only nav endpoint. The SDK's
      // PC_ROOM / withBiliUser variants can retain a previous account in cache,
      // so an automatic spending authorization must verify nav afresh.
      const response = await win.fetch('https://api.bilibili.com/x/web-interface/nav', {
        method: 'GET', credentials: 'include', cache: 'no-store',
        redirect: 'error', signal: controller.signal
      });
      if (!response.ok) throw new Error('identity_unavailable');
      const body = await response.json();
      if (disposed || suspended || !sameRoute() || generation !== epoch ||
          sequence !== identitySequence) throw new Error('identity_superseded');
      if (!record(body) || body.code !== 0 || !record(body.data)) throw new Error('identity_unavailable');
      const loggedIn = body.data.isLogin === true;
      const uid = loggedIn ? id(body.data.mid) : null;
      if (loggedIn && !uid) throw new Error('identity_unavailable');
      return acceptIdentity({ uid, isLogin: loggedIn, isTourist: false });
    } finally {
      stopTimer(timeout);
      navControllers.delete(controller);
    }
  }
  function apiPath(url) {
    try {
      const parsed = new win.URL(url, 'https://api.live.bilibili.com');
      return parsed.origin === 'https://api.live.bilibili.com' ? parsed.pathname : '';
    } catch (_) { return ''; }
  }
  function validBusiness(result) { return record(result) && result.code === 0 && record(result.data); }
  function ingestList(result, uid, startedAt = mono()) {
    if (!validBusiness(result) || uid !== viewerId || !Array.isArray(result.data.prophets)) return false;
    if (startedAt < listStartedAt) return false;
    const next = new Map();
    for (const item of result.data.prophets) {
      const pid = id(item?.prophet?.prophet_id);
      if (pid) next.set(pid, item);
    }
    rows = next;
    if (startedAt >= balanceStartedAt) {
      balance = whole(result.data.user_smh_num) ? result.data.user_smh_num : null;
      balanceStartedAt = startedAt;
    }
    listAt = mono();
    listStartedAt = startedAt;
    return true;
  }
  function parseTime(result, start) {
    if (!validBusiness(result) || !whole(result.data.timestamp) || result.data.timestamp <= 0 ||
        !Number.isSafeInteger(result.data.timestamp * 1000)) return null;
    const received = mono();
    const rtt = received - start;
    if (rtt < 0 || rtt > READ_TIMEOUT_MS) return null;
    return { serverMs: result.data.timestamp * 1000, at: received, rtt, startedAt: start };
  }
  function ingestTime(result, start) {
    const sample = parseTime(result, start);
    if (!sample) return false;
    if (!clock || start >= clock.startedAt) clock = sample;
    return true;
  }
  function observeGet(url, params, result, start, uidAtStart) {
    if (disposed || !sameRoute()) return;
    const path = apiPath(url);
    if (path === API.time) ingestTime(result, start);
    if (path === API.list && id(params?.anchor_id) === originalRoute.anchorId &&
        id(params?.uid) === uidAtStart && uidAtStart === viewerId) {
      ingestList(result, uidAtStart, start);
    }
    if (path === API.balance && validBusiness(result) &&
        id(params?.anchor_id) === originalRoute.anchorId && id(params?.uid) === viewerId &&
        uidAtStart === viewerId && start >= balanceStartedAt) {
      balance = whole(result.data.smh_num) ? result.data.smh_num : null;
      balanceStartedAt = start;
    }
    snapshot(true);
  }
  function cleanItem(item) {
    const p = item?.prophet;
    if (!p || !id(p.prophet_id)) return null;
    return {
      prophetId: id(p.prophet_id), status: numeric(p.prophet_status),
      myAnswer: numeric(item.my_answer),
      deadlineMs: whole(p.count_down_time) && Number.isSafeInteger(p.count_down_time * 1000)
        ? p.count_down_time * 1000 : null,
      question: textOnly(p.question?.question), answerA: textOnly(p.question?.answer_a),
      answerB: textOnly(p.question?.answer_b), ticket: whole(p.smh_spend) ? p.smh_spend : null,
      answerCount: { a: whole(p.answer_count?.a) ? p.answer_count.a : null,
        b: whole(p.answer_count?.b) ? p.answer_count.b : null }
    };
  }
  function compactVisible() {
    return embedded && !disposed && !suspended && sameRoute() &&
      configuration?.presentation === 'overlay' && !configuration.controlsOpen;
  }
  function setCompactFeedback(pid, message, level = 'info', duration = 6500) {
    if (!compactVisible() || !pid) return;
    const item = cleanItem(rows.get(pid)) || (compactCurrent?.prophetId === pid ? compactCurrent : null);
    compactFeedback = { prophetId: pid, message, level, until: mono() + duration, item };
    compactSelectedId = pid;
  }
  function compactCandidates() {
    const time = currentClock().serverNowMs;
    return Array.from(rows.values()).map(cleanItem).filter(item => item &&
      item.status === 1 && item.myAnswer === 0 && item.deadlineMs &&
      (!time || item.deadlineMs > time))
      .sort((a, b) => a.deadlineMs - b.deadlineMs || a.prophetId.localeCompare(b.prophetId));
  }
  function compactOdds(item, answer) {
    const a = item?.answerCount?.a;
    const b = item?.answerCount?.b;
    if (!whole(a) || !whole(b) || a === Number.MAX_SAFE_INTEGER || b === Number.MAX_SAFE_INTEGER) return '—';
    const multiplier = answer === 1 ? b / (a + 1) : a / (b + 1);
    if (multiplier > 0 && multiplier < .01) return '<0.01×';
    if (multiplier >= 10000) return multiplier.toLocaleString('zh-CN', { maximumFractionDigits: 0 }) + '×';
    return multiplier.toFixed(2) + '×';
  }
  function compactClock(deadlineMs) {
    const now = currentClock().serverNowMs;
    if (!now || !deadlineMs) return { label: '校准时间…', urgent: false };
    const remaining = Math.max(0, Math.ceil((deadlineMs - now) / 1000));
    if (!remaining) return { label: '已截止', urgent: true };
    const seconds = String(remaining % 60).padStart(2, '0');
    const minutes = Math.floor(remaining / 60);
    return { label: '剩余 ' + (minutes ? String(minutes).padStart(2, '0') + ':' : '') + seconds + (minutes ? '' : ' 秒'),
      urgent: deadlineMs - now <= 5000 };
  }
  function reportCompactHeight(force = false) {
    if (!compactVisible()) return;
    let height = Math.ceil(compactCard.getBoundingClientRect().height);
    if (dialogOpen) {
      const dialog = compactCompatHost?.shadowRoot?.querySelector('dialog');
      height = Math.max(height, Math.min(420, (dialog?.scrollHeight || 300) + 28));
    }
    height = Math.max(120, Math.min(460, height));
    if (force || Math.abs(height - compactLastHeight) > 1) {
      compactLastHeight = height;
      postParent('compact-layout', { height });
    }
  }
  function applyCompactPresentation() {
    const visible = compactVisible();
    compactHost.hidden = !visible;
    if (visible) doc.documentElement.dataset.bp4Compact = 'true';
    else delete doc.documentElement.dataset.bp4Compact;
    const compat = doc.getElementById('bili-live-prophecy-compat');
    if (compat && compactCompatHost !== compat) {
      compactCompatStyle?.remove();
      if (compactCompatHost) delete compactCompatHost.dataset.presentation;
      compactCompatHost = compat;
      if (compat.shadowRoot) {
        compactCompatStyle = doc.createElement('style');
        compactCompatStyle.dataset.bp4CompactStyle = 'true';
        compactCompatStyle.textContent = `
          :host([data-presentation="overlay"]) .state{display:none!important}
          :host([data-presentation="overlay"]) dialog{width:calc(100vw - 24px);max-width:440px;
            max-height:calc(100dvh - 20px);padding:16px;border-radius:12px}
          :host([data-presentation="overlay"]) dialog h2{font-size:16px;margin-bottom:10px}
          :host([data-presentation="overlay"]) .eyebrow{margin-bottom:5px}
          :host([data-presentation="overlay"]) .actions{position:sticky;bottom:0;z-index:1;
            margin-top:14px;padding-top:5px;background:#232431}
          :host([data-presentation="overlay"]) .toast{bottom:8px;padding:7px 10px;font-size:12px}
        `;
        compat.shadowRoot.append(compactCompatStyle);
      }
    }
    if (compactCompatHost) {
      if (visible) compactCompatHost.dataset.presentation = 'overlay';
      else delete compactCompatHost.dataset.presentation;
    }
    if (!visible) compactLastHeight = 0;
    renderCompact();
  }
  function compactStatusFor(item, eligible) {
    if (compactFeedback && item && compactFeedback.prophetId === item.prophetId && compactFeedback.until > mono()) {
      return { text: compactFeedback.message, level: compactFeedback.level };
    }
    if (compactPending) return { text: compactPending.phase === 'confirm' ? '请在确认窗口中确认' : '正在核对并提交…' };
    if (!viewerId) return { text: '登录后即可参与', level: 'warn' };
    if (!item) return { text: '新的可参与预言出现时会在这里显示' };
    if (item.myAnswer === 1 || item.myAnswer === 2) return { text: '已参与选项 ' + (item.myAnswer === 1 ? 'A' : 'B'), level: 'success' };
    if (item.status !== 1 || (currentClock().serverNowMs && item.deadlineMs <= currentClock().serverNowMs)) return { text: '本题已截止' };
    if (viewerId === originalRoute.anchorId) return { text: '不能参与自己的预言', level: 'warn' };
    if (attemptMarked(viewerId, item.prophetId, true)) return { text: '本题已有参与请求，可在完整面板查看状态' };
    if (!capabilities.requestGuard || typeof showConfirm !== 'function') return { text: '参与模块加载中…' };
    if (mono() - listAt > FRESH_MS || !currentClock().serverNowMs || !whole(balance)) return { text: '正在刷新预言状态…' };
    if (!whole(item.ticket) || item.ticket <= 0) return { text: '门票信息待确认', level: 'warn' };
    if (balance < item.ticket) return { text: '硬币不足，需 ' + item.ticket + ' 枚', level: 'warn' };
    if (manualMarked(viewerId, item.prophetId)) return { text: '已手动选择，本题不会自动参与' };
    if (eligible && contextValid(generation, viewerId, true)) return { text: '可直接选择，或等待最后 5 秒自动检查' };
    return { text: eligible ? '选择一个选项，确认后参与' : '当前暂不可参与' };
  }
  function renderCompact() {
    if (!compactVisible()) return;
    if (compactFeedback && compactFeedback.until <= mono()) compactFeedback = null;
    const candidates = compactCandidates();
    const pinned = compactPending?.item || compactFeedback?.item;
    let selected = candidates.find(item => item.prophetId === compactSelectedId);
    if (!selected && pinned?.prophetId === compactSelectedId) selected = cleanItem(rows.get(compactSelectedId)) || pinned;
    if (!selected) selected = candidates[0] || null;
    compactCurrent = selected;
    compactSelectedId = selected?.prophetId || null;
    compactCard.dataset.prophetId = compactSelectedId || '';
    const position = candidates.findIndex(item => item.prophetId === compactSelectedId);
    compactPagination.hidden = candidates.length <= 1 || position < 0;
    compactPosition.textContent = (position >= 0 ? position + 1 : 1) + ' / ' + candidates.length;
    compactPrevious.disabled = compactNext.disabled = !!compactPending || dialogOpen || candidates.length < 2;
    compactQuestion.textContent = selected?.question || (mono() - listAt > FRESH_MS ? '正在加载当前预言…' : '暂无可参与的预言');
    compactQuestion.title = selected?.question || '';
    compactTicket.textContent = selected ? (whole(selected.ticket) ? selected.ticket + ' 硬币' : '门票待确认') : '实时预言';
    const countdown = compactClock(selected?.deadlineMs);
    compactCountdown.textContent = selected ? countdown.label : '';
    compactCountdown.classList.toggle('urgent', !!selected && countdown.urgent);
    compactChoices.hidden = !selected;
    const eligible = !!selected && !compactPending && !manualBusy && !dialogOpen &&
      capabilities.requestGuard && typeof showConfirm === 'function' && detailVisible() &&
      mono() - listAt <= FRESH_MS && basicEligibility(rows.get(selected.prophetId), viewerId, balance, currentClock(), true);
    compactCard.dataset.joinable = String(eligible);
    for (const [index, option] of compactOptions.entries()) {
      const answer = index + 1;
      const label = (answer === 1 ? selected?.answerA : selected?.answerB) || ('选项 ' + (answer === 1 ? 'A' : 'B'));
      option.label.textContent = label;
      option.button.title = label;
      option.odds.textContent = '赔率 ' + compactOdds(selected, answer);
      option.button.disabled = !eligible;
      option.button.setAttribute('aria-label', (answer === 1 ? 'A：' : 'B：') + label + '，' + option.odds.textContent);
      const joined = selected?.myAnswer === answer;
      option.action.textContent = joined ? '已参与' : '参与';
      option.button.classList.toggle('joined', joined);
    }
    const message = compactStatusFor(selected, eligible);
    compactStatus.textContent = message.text;
    compactStatus.dataset.level = message.level || 'info';
    reportCompactHeight();
  }
  function stepCompact(event, direction) {
    if (!event.isTrusted || !compactVisible() || compactPending || dialogOpen) return;
    const candidates = compactCandidates();
    if (candidates.length < 2) return;
    const current = Math.max(0, candidates.findIndex(item => item.prophetId === compactSelectedId));
    compactSelectedId = candidates[(current + direction + candidates.length) % candidates.length].prophetId;
    compactFeedback = null;
    renderCompact();
  }
  async function chooseCompact(event, answer) {
    if (!event.isTrusted || !compactVisible() || !detailVisible() || compactPending || manualBusy ||
        dialogOpen || !capabilities.requestGuard || typeof showConfirm !== 'function') return;
    const pid = compactSelectedId;
    const uid = viewerId;
    const item = cleanItem(rows.get(pid));
    if (!pid || !uid || !item || mono() - listAt > FRESH_MS ||
        !basicEligibility(rows.get(pid), uid, balance, currentClock(), true)) {
      renderCompact();
      return;
    }
    const selection = { uid, prophetId: pid, answer, item, phase: 'confirm',
      nonce: configuration.nonce, generation };
    compactPending = selection;
    compactFeedback = null;
    // The real option click records intent before opening the same trusted
    // browser confirmation used by the official cards. Cancel never restores auto.
    markManual(uid, pid, answer, item.ticket);
    // A storage failure disables auto but preserves explicit manual operation.
    // The confirmation belongs to the resulting in-memory generation.
    selection.generation = generation;
    renderCompact();
    try {
      const label = answer === 1 ? item.answerA : item.answerB;
      const response = await showConfirm({ title: item.question || '参与本次预言',
        content: '我猜：' + (label || ('选项 ' + (answer === 1 ? 'A' : 'B'))) +
          '\n门票：' + item.ticket + ' 枚硬币 · 当前赔率 ' + compactOdds(item, answer),
        confirmText: '确认参与 · ' + item.ticket + ' 硬币', cancelText: '取消' });
      if (response?.confirm !== true) {
        if (viewerId === uid) setCompactFeedback(pid, '已取消，本题不会自动参与');
        return;
      }
      if (compactPending !== selection || !compactVisible() || generation !== selection.generation ||
          viewerId !== uid || configuration.nonce !== selection.nonce || !detailVisible()) return;
      selection.phase = 'submitting';
      renderCompact();
      const result = await guardedManual(API.join, { anchor_id: originalRoute.anchorId,
        uid, prophet_id: pid, answer }, 'queryString');
      if (viewerId === uid && compactPending === selection) {
        if (result?.code === 0) setCompactFeedback(pid, '已参与 ' + (answer === 1 ? 'A' : 'B') + '，等待预言结果', 'success');
        else setCompactFeedback(pid, '未能完成参与，请查看提示', 'warn');
      }
    } catch (_) {
      if (viewerId === uid) setCompactFeedback(pid, '参与状态暂不可用，请查看完整面板', 'warn');
    } finally {
      if (compactPending === selection) compactPending = null;
      snapshot(true);
    }
  }
  function snapshot(force = false) {
    if (!force && mono() - lastSnapshotAt < 1000) return;
    lastSnapshotAt = mono();
    const time = currentClock();
    postParent('snapshot', {
      items: Array.from(rows.values()).map(cleanItem).filter(Boolean),
      viewerId, balance, serverNowMs: time.serverNowMs, clockAgeMs: time.clockAgeMs,
      capabilities: { ...capabilities }, autoState: busy ? 'busy' : 'idle'
    });
    paintCards();
    renderCompact();
  }
  function getCardItem(card) {
    let component = card?.__vue__;
    for (let i = 0; component && i < 4; i += 1, component = component.$parent) {
      const item = component.item || component.$props?.item;
      if (id(item?.prophet?.prophet_id)) return { item, component };
    }
    return null;
  }
  function basicEligibility(item, uid, amount, time, forManual = false) {
    const p = item?.prophet;
    const pid = id(p?.prophet_id);
    if (!pid || !uid || uid === originalRoute.anchorId || p.prophet_status !== 1 ||
        item.my_answer !== 0 || !whole(p.smh_spend) || p.smh_spend <= 0 ||
        !whole(amount) || amount < p.smh_spend || !whole(p.count_down_time) ||
        !Number.isSafeInteger(p.count_down_time * 1000) || !time.serverNowMs ||
        p.count_down_time * 1000 <= time.serverNowMs) return false;
    return !attemptMarked(uid, pid, forManual);
  }
  function paintCards() {
    if (disposed) return;
    const time = currentClock();
    for (const card of doc.querySelectorAll('.content-prohets-box')) {
      const found = getCardItem(card);
      const pid = id(found?.item?.prophet?.prophet_id);
      if (!pid) continue;
      const current = rows.get(pid);
      const eligible = !!current && mono() - listAt <= FRESH_MS &&
        basicEligibility(current, viewerId, balance, time, true);
      card.dataset.bp3ProphetId = pid;
      card.dataset.bp3Joinable = String(eligible);
      card.classList.toggle('bp3-joinable', eligible);
      card.dataset.bp3ManualIntent = String(!!viewerId && manualMarked(viewerId, pid));
    }
  }
  function captureManual(event) {
    if (!event.isTrusted || disposed || !sameRoute() || !detailVisible()) return;
    const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
    const block = target?.closest?.('.block');
    const card = block?.closest('.content-prohets-box');
    if (!card || !doc.documentElement.contains(card)) return;
    const choices = Array.from(card.querySelectorAll('.bigbox .box .block'));
    const answer = choices.indexOf(block) + 1;
    if (![1, 2].includes(answer)) return;
    const found = getCardItem(card);
    const pid = id(found?.item?.prophet?.prophet_id);
    if (!pid) return;
    // This runs before the official Vue click and before its confirmation.
    // Canceling that confirmation intentionally keeps the manual-intent marker.
    const uid = id(found.component.userInfo?.uid) || viewerId;
    markManual(uid, pid, answer, found.item.prophet.smh_spend);
    snapshot(true);
  }
  function contextValid(epoch, uid, automatic) {
    if (disposed || suspended || generation !== epoch || !sameRoute() || !detailVisible() ||
        viewerId !== uid || !capabilities.requestGuard) return false;
    if (!automatic) return true;
    if (!embedded || !configuration || mono() - heartbeatAt > HEARTBEAT_MS ||
        configuration.active === false || configuration.controlsOpen || dialogOpen || manualBusy ||
        storageFault || !capabilities.locks || !configuration.settings.enabled) return false;
    return configuration.settings.authorizedViewerId === uid &&
      configuration.settings.authorizedAnchorId === originalRoute.anchorId;
  }
  function autoReason() {
    if (!configuration?.settings.enabled) return '自动参与已关闭';
    if (!embedded || mono() - heartbeatAt > HEARTBEAT_MS) return '直播间连接已中断，自动参与暂停';
    if (!viewerId) return '等待网页登录状态';
    if (configuration.settings.authorizedViewerId !== viewerId ||
        configuration.settings.authorizedAnchorId !== originalRoute.anchorId) {
      return '账号已变化，请重新开启自动参与';
    }
    if (!capabilities.locks) return '浏览器不支持账号锁，自动参与不可用';
    if (storageFault) return '本地去重记录不可用，自动参与已停止';
    if (!capabilities.requestGuard) return '等待官方请求模块';
    if (suspended || configuration.active === false) return '直播间暂未激活，自动参与暂停';
    if (!detailVisible()) return '查看历史或规则期间，自动参与暂停';
    if (configuration.controlsOpen) return '正在修改设置，自动参与暂停';
    if (dialogOpen) return '正在手动确认，自动参与暂停';
    if (!currentClock().serverNowMs || mono() - listAt > FRESH_MS) return '正在校准官方时间和预言状态';
    return '自动参与已开启：仅在最后 5 秒检查，手动选择优先';
  }
  async function refreshReadOnly() {
    if (!client || refreshing || disposed || suspended || !sameRoute()) return;
    refreshing = true;
    lastRefreshAt = mono();
    try {
      const uid = mono() - identityAt >= 10000 ? await freshIdentity() : viewerId;
      if (!uid || disposed || !sameRoute()) { snapshot(true); return; }
      const start = mono();
      const [list, time] = await deadlineRead(Promise.all([
        rawGet.call(client, API.list, { anchor_id: originalRoute.anchorId, uid, with_history: true }),
        rawGet.call(client, API.time, {})
      ]));
      if (disposed || !sameRoute() || viewerId !== uid) return;
      ingestList(list, uid, start);
      ingestTime(time, start);
      snapshot(true);
    } catch (_) {
      // Read errors are deliberately kept generic: SDK error objects can contain
      // request configuration and must never be exposed through postMessage.
      if (mono() - listAt > FRESH_MS) status('官方只读请求暂不可用，自动参与暂停', 'warn');
    } finally { refreshing = false; }
  }
  function blockResult(message) {
    status(message, 'warn', 4500);
    toast(message);
    return { code: -40901, message, data: {} };
  }
  async function freshUnderLock(uid, epoch, automatic) {
    const currentUid = await freshIdentity();
    if (currentUid !== uid || !contextValid(epoch, uid, automatic)) return null;
    const start = mono();
    const [list, funds, time] = await deadlineRead(Promise.all([
      rawGet.call(client, API.list, { anchor_id: originalRoute.anchorId, uid, with_history: true }),
      rawGet.call(client, API.balance, { anchor_id: originalRoute.anchorId, uid }),
      rawGet.call(client, API.time, {})
    ]));
    if (!contextValid(epoch, uid, automatic)) return null;
    const sample = parseTime(time, start);
    if (!validBusiness(list) || !Array.isArray(list.data.prophets) ||
        !validBusiness(funds) || !whole(funds.data.smh_num) ||
        !whole(list.data.user_smh_num) || !sample) throw new Error('preflight_failed');
    ingestList(list, uid, start);
    if (!clock || start >= clock.startedAt) clock = sample;
    // Both official balance sources must be valid. Use the smaller value if
    // they disagree during a concurrent account update.
    const freshBalance = Math.min(list.data.user_smh_num, funds.data.smh_num);
    if (start >= balanceStartedAt) { balance = freshBalance; balanceStartedAt = start; }
    snapshot(true);
    const freshRows = new Map(list.data.prophets.map(item => [id(item?.prophet?.prophet_id), item]).filter(pair => pair[0]));
    return { rows: freshRows, balance: freshBalance, time: sampleClock(sample), sample, startedAt: start };
  }
  function policyFor(item, uid, fresh = null) {
    const pid = id(item?.prophet?.prophet_id);
    const time = fresh ? sampleClock(fresh.sample) : currentClock();
    let amount = fresh ? fresh.balance : balance;
    if (fresh && balanceStartedAt >= fresh.startedAt) amount = whole(balance) ? Math.min(amount, balance) : null;
    return policy.evaluateAutoCandidate({ item, viewerId: uid,
      anchorId: originalRoute.anchorId, balance: amount,
      serverNowMs: time.serverNowMs, clockAgeMs: time.clockAgeMs,
      settings: configuration?.settings || { enabled: false },
      manualIntent: !pid || manualMarked(uid, pid),
      attempted: !pid || attemptMarked(uid, pid) });
  }
  function noNewContradiction(fresh, pid) {
    if (listStartedAt < fresh.startedAt) return true;
    const current = rows.get(pid);
    const checked = fresh.rows.get(pid);
    return !!current && !!checked && current.my_answer === 0 &&
      current.prophet.prophet_status === 1 &&
      current.prophet.smh_spend === checked.prophet.smh_spend &&
      current.prophet.count_down_time === checked.prophet.count_down_time;
  }
  async function commitJoin(uid, pid, answer, mode, epoch, fresh) {
    const automatic = mode === 'auto';
    if (!contextValid(epoch, uid, automatic) || attemptMarked(uid, pid, !automatic) ||
        (automatic && manualMarked(uid, pid))) return null;
    const time = sampleClock(fresh.sample);
    const remaining = fresh.rows.get(pid)?.prophet?.count_down_time * 1000 - time.serverNowMs;
    if (!time.serverNowMs || time.uncertaintyMs === null ||
        !noNewContradiction(fresh, pid) || !(remaining > time.uncertaintyMs)) {
      status('已接近封盘，跳过本次请求', 'info', 4000);
      return null;
    }
    const persisted = markAttempt(uid, pid, mode, answer, 'submitting', true);
    if (!persisted && automatic) return null;
    // No await between the verified durable marker and the official POST.
    // The Web Lock remains held until the actual request settles, even when
    // the UI has reported an unknown outcome; no Promise.race releases it.
    let unknown = false;
    const timeout = timer(() => {
      unknown = true;
      markAttempt(uid, pid, mode, answer, 'unknown', true);
      status('参与结果暂未返回；已保留去重记录，不会自动重试', 'warn', 15000);
      if (viewerId === uid) {
        setCompactFeedback(pid, '结果暂未返回，本题不会重复提交', 'warn', 15000);
        renderCompact();
      }
    }, 12000);
    let result;
    try {
      result = await rawPost.call(client, API.join, {
        anchor_id: originalRoute.anchorId, uid, prophet_id: pid, answer
      }, 'queryString');
    } catch (_) { result = { code: 500, message: '请求失败', data: {} }; }
    finally { stopTimer(timeout); }
    const success = record(result) && result.code === 0;
    markAttempt(uid, pid, mode, answer, success ? 'succeeded' : 'failed', true);
    if (!disposed && sameRoute()) {
      const message = success
        ? (automatic ? '已自动参与选项 ' + (answer === 1 ? 'A' : 'B') : '手动参与请求已成功')
        : '参与请求未成功；已记录本题，不会自动重试';
      status(message, success ? 'info' : 'warn', 6500);
      if (viewerId === uid) setCompactFeedback(pid, success
        ? (automatic ? '已自动参与 ' : '已参与 ') + (answer === 1 ? 'A' : 'B') + '，等待预言结果'
        : '参与请求未成功，本题不会自动重试', success ? 'success' : 'warn');
      if (automatic || unknown) toast(message);
      refreshOfficialStore();
      refreshReadOnly();
      snapshot(true);
    }
    // Preserve the official wrapper's result shape. Never send its raw error
    // body to our parent, logs or storage.
    return record(result) ? result : { code: 500, message: '请求失败', data: {} };
  }
  function refreshOfficialStore() {
    for (const card of doc.querySelectorAll('.content-prohets-box')) {
      const store = getCardItem(card)?.component?.$store;
      if (store && typeof store.dispatch === 'function') {
        try { Promise.resolve(store.dispatch('requestProphets')).catch(noop); } catch (_) {}
        return;
      }
    }
  }
  async function runAuto(item) {
    const uid = viewerId;
    const pid = id(item?.prophet?.prophet_id);
    const epoch = generation;
    if (busy || !uid || !pid || !contextValid(epoch, uid, true)) return;
    busy = true;
    try {
      await win.navigator.locks.request(PREFIX + 'account:' + uid,
        { mode: 'exclusive', ifAvailable: true }, async lock => {
          if (!lock || !contextValid(epoch, uid, true) || manualMarked(uid, pid) || attemptMarked(uid, pid)) return;
          let fresh;
          try { fresh = await freshUnderLock(uid, epoch, true); }
          catch (_) {
            if (contextValid(epoch, uid, true)) {
              markAttempt(uid, pid, 'auto', 0, 'preflight-failed', false);
              status('参与前检查失败，本题不再自动重试', 'warn', 6000);
            }
            return;
          }
          if (!fresh || !contextValid(epoch, uid, true)) return;
          let decision = policyFor(fresh.rows.get(pid), uid, fresh);
          if (!decision.ok) return;
          // Give already queued trusted clicks a chance to record manual intent.
          await new Promise(resolve => timer(resolve, 0));
          if (!contextValid(epoch, uid, true)) return;
          decision = policyFor(fresh.rows.get(pid), uid, fresh);
          if (!decision.ok) return;
          await commitJoin(uid, pid, decision.answer, 'auto', epoch, fresh);
        });
    } catch (_) {
      capabilities.locks = false;
      status('账号锁不可用，自动参与已停止', 'error', 6000);
    } finally { busy = false; snapshot(true); }
  }
  async function guardedManual(url, data, contentType) {
    const uid = id(data?.uid);
    const anchor = id(data?.anchor_id);
    const pid = id(data?.prophet_id);
    const answer = data?.answer;
    if (!uid || !pid || anchor !== originalRoute.anchorId || ![1, 2].includes(answer)) {
      return blockResult('参与参数无法核验，请重新打开预言');
    }
    const source = manualSource.get(itemKey(uid, pid));
    if (!source || source.answer !== answer || !manualMarked(uid, pid)) {
      return blockResult('请亲自在预言卡片选择选项并确认');
    }
    const epoch = generation;
    if (!contextValid(epoch, uid, false)) return blockResult('页面或账号已变化，请重新选择');
    if (attemptMarked(uid, pid, true)) return blockResult('本题已有参与请求，请查看参与状态');
    if (manualBusy) return blockResult('本页有参与请求正在处理，请稍后查看状态');
    manualBusy = true;
    try {
      const submit = async lock => {
          if (!lock) return blockResult('该账号有另一笔参与请求正在处理，请稍后查看状态');
          if (!contextValid(epoch, uid, false) || attemptMarked(uid, pid, true)) {
            return blockResult('本题已有请求或页面已变化，请查看状态');
          }
          let fresh;
          try { fresh = await freshUnderLock(uid, epoch, false); }
          catch (_) { return blockResult('官方状态校验失败，本次没有发送参与请求'); }
          if (!fresh || !contextValid(epoch, uid, false) ||
              !basicEligibility(fresh.rows.get(pid), uid, fresh.balance, fresh.time, true)) {
            return blockResult('预言已变化、余额不足或已经封盘，本次没有发送请求');
          }
          if (!whole(source.ticket) || source.ticket <= 0 ||
              fresh.rows.get(pid).prophet.smh_spend !== source.ticket) {
            return blockResult('门票金额已变化，请查看最新金额后重新选择');
          }
          return await commitJoin(uid, pid, answer, 'manual', epoch, fresh) ||
            blockResult('已接近封盘或状态变化，本次没有发送请求');
        };
      if (!capabilities.locks) {
        // Auto is disabled whenever Web Locks are unavailable. An explicitly
        // confirmed official manual request still works, guarded once per page.
        return await submit({ manualLocalOnly: true });
      }
      return await win.navigator.locks.request(PREFIX + 'account:' + uid,
        { mode: 'exclusive', ifAvailable: true }, submit);
    } catch (_) { return blockResult('账号锁暂不可用，本次没有发送参与请求'); }
    finally { manualBusy = false; }
  }
  function installRequestHooks() {
    if (client || disposed) return;
    let candidate;
    try {
      if (!runtime?.m?.[6151]) return;
      candidate = runtime(6151).E;
      if (!candidate || typeof candidate.get !== 'function' || typeof candidate.post !== 'function') return;
      rawGet = candidate.get;
      rawPost = candidate.post;
      getHook = function(url, params) {
        const start = mono();
        const uid = viewerId;
        return Promise.resolve(rawGet.apply(this, arguments)).then(result => {
          try { observeGet(url, params, result, start, uid); } catch (_) {}
          return result;
        });
      };
      postHook = function(url, data, contentType) {
        return apiPath(url) === API.join
          ? guardedManual(url, data, contentType)
          : rawPost.apply(this, arguments);
      };
      candidate.get = getHook;
      candidate.post = postHook;
      if (candidate.get !== getHook || candidate.post !== postHook) throw new Error('request_hook_failed');
      client = candidate;
      capabilities.requestGuard = true;
      refreshReadOnly();
    } catch (_) {
      try { if (candidate?.get === getHook) candidate.get = rawGet; } catch (_) {}
      try { if (candidate?.post === postHook) candidate.post = rawPost; } catch (_) {}
      status('官方请求模块发生变化，自动参与不可用', 'warn');
    }
  }
  function receive(event) {
    if (!embedded || disposed || event.source !== win.parent || event.origin !== ORIGIN) return;
    const data = event.data;
    if (!record(data) || data.channel !== CHANNEL || data.type !== 'configure' ||
        typeof data.nonce !== 'string' || data.nonce.length < 8 || data.nonce.length > 200 ||
        id(data.roomId) !== originalRoute.roomId || id(data.anchorId) !== originalRoute.anchorId || !sameRoute()) return;
    const result = policy.normalizeSettings(data.settings);
    if (!result.ok) return;
    const settings = { ...result.settings,
      authorizedViewerId: id(data.settings.authorizedViewerId),
      authorizedAnchorId: id(data.settings.authorizedAnchorId) };
    const next = { nonce: data.nonce, settings,
      presentation: ['overlay', 'dock', 'closed'].includes(data.presentation) ? data.presentation : 'closed',
      controlsOpen: data.controlsOpen === true, active: data.active !== false };
    const changed = !configuration || configuration.nonce !== next.nonce ||
      JSON.stringify(configuration.settings) !== JSON.stringify(settings);
    const previousPresentation = configuration?.presentation;
    const wasExpired = mono() - heartbeatAt > HEARTBEAT_MS;
    if (changed || wasExpired) generation += 1;
    configuration = next;
    heartbeatAt = mono();
    const revealId = id(data.revealId);
    if (revealId && revealId !== lastRevealId && next.presentation === 'overlay') {
      lastRevealId = revealId;
      if (!compactPending && !dialogOpen) {
        compactSelectedId = revealId;
        compactFeedback = null;
      }
      if (!detailVisible()) win.location.hash = '/';
    }
    if ((next.presentation === 'closed' || next.controlsOpen ||
        (previousPresentation === 'overlay' && next.presentation !== 'overlay' && compactPending)) && dialogOpen) {
      try { cancelDialog?.(); } catch (_) {}
    }
    applyCompactPresentation();
    reportCompactHeight(previousPresentation !== next.presentation);
    if (changed) lastStatusKey = '';
    snapshot(true);
    if (changed || wasExpired) refreshReadOnly();
  }
  function publishDialog(open) {
    if (disposed) return;
    dialogOpen = open === true;
    postParent('dialog', { open: dialogOpen });
    renderCompact();
    reportCompactHeight(true);
    if (dialogOpen) timer(() => reportCompactHeight(true), 0);
  }
  function routeChanged() {
    generation += 1;
    clock = null;
    lastRefreshAt = -Infinity;
    compactFeedback = null;
    try { cancelDialog?.(); } catch (_) {}
    applyCompactPresentation();
    snapshot(true);
  }
  function visibilityChanged() {
    generation += 1;
    clock = null;
    heartbeatAt = -Infinity;
    if (doc.visibilityState !== 'visible') try { cancelDialog?.(); } catch (_) {}
    // Hidden tabs may continue if their timers and verified parent heartbeat
    // keep running. Resumption always requires a fresh server-time sample.
    refreshReadOnly();
  }
  function pageHide(event) {
    generation += 1;
    suspended = true;
    clock = null;
    heartbeatAt = -Infinity;
    applyCompactPresentation();
    if (!event.persisted) dispose();
  }
  function pageShow() {
    suspended = false;
    generation += 1;
    heartbeatAt = -Infinity;
    clock = null;
    applyCompactPresentation();
    refreshReadOnly();
  }
  function storageChanged(event) {
    if (event.key?.startsWith(PREFIX + 'manual:') || event.key?.startsWith(PREFIX + 'attempt:')) snapshot(true);
  }
  function tick() {
    if (disposed) return;
    installRequestHooks();
    const key = JSON.stringify(route());
    if (key !== lastRouteKey) { lastRouteKey = key; routeChanged(); }
    if (mono() - lastRefreshAt >= 4000 && !busy) refreshReadOnly();
    snapshot();
    if (!busy && mono() > statusUntil) status(autoReason(), 'info');
    if (!viewerId || busy || mono() - identityAt > FRESH_MS || mono() - listAt > FRESH_MS ||
        !contextValid(generation, viewerId, true)) return;
    for (const item of rows.values()) {
      const candidate = policyFor(item, viewerId);
      if (candidate.ok && candidate.remainingMs > currentClock().uncertaintyMs) {
        runAuto(item);
        break;
      }
    }
  }
  const style = doc.createElement('style');
  style.dataset.bp3ChildStyle = 'true';
  style.textContent = `
    .content-prohets-box{transition:background-color .16s,border-color .16s;box-sizing:border-box}
    .content-prohets-box.bp3-joinable{background:#213047!important;border:2px solid #00a8df!important;box-shadow:0 3px 12px #00aeec20;color:#fff!important}
    .content-prohets-box.bp3-joinable .unselected{opacity:1!important}
    .content-prohets-box.bp3-joinable .bigbox:first-child .box{background:#146581!important;color:#fff!important}
    .content-prohets-box.bp3-joinable .bigbox:last-child .box{background:#963752!important;color:#fff!important}
    .content-prohets-box.bp3-joinable .bigbox .box .block{border:1px solid #ffffff55!important;color:#fff!important;cursor:pointer}
    .content-prohets-box.bp3-joinable .bigbox .box .block:hover{filter:brightness(1.16)}
    .content-prohets-box.bp3-joinable .bigbox .box .block::after{content:'点击参与';display:block;color:#fff;font-size:11px;opacity:.85;margin-top:3px}
    .content-prohets-box.bp3-joinable .bigbox .box .block:focus-visible{outline:2px solid #008bbe;outline-offset:2px}
    html[data-bp4-compact="true"],html[data-bp4-compact="true"] body{margin:0!important;padding:0!important;
      min-height:0!important;height:auto!important;background:#151e2b!important;overflow:hidden!important}
    html[data-bp4-compact="true"] body>:not(#bili-prophecy-compact):not(#bili-live-prophecy-compat):not(script):not(style):not(link){display:none!important}
    @media(max-height:480px){.user-detail-content .content-prohets-box{padding:10px 12px!important;margin-bottom:9px!important}
      .user-detail-content>.content{padding-top:8px!important;padding-bottom:8px!important}
      .content-prohets-box .text-line{margin-bottom:6px!important}.user-game-footer{padding-top:8px!important;padding-bottom:8px!important}}
  `;
  (doc.head || doc.documentElement).append(style);
  function compactElement(tag, className, value) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  }
  const compactHost = compactElement('div');
  compactHost.id = 'bili-prophecy-compact';
  compactHost.hidden = true;
  const compactShadow = compactHost.attachShadow({ mode: 'open' });
  const compactStyle = compactElement('style');
  compactStyle.textContent = `
    :host{display:block;width:100%;max-height:100dvh;overflow:auto;overscroll-behavior:contain;color-scheme:dark;color:#f4f7fc;
      font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
    :host([hidden]),[hidden]{display:none!important}*{box-sizing:border-box}
    .compact-card{width:100%;padding:10px 14px 12px;background:#151e2bec;overflow:hidden}
    .meta{display:flex;align-items:center;gap:9px;min-height:22px;font-size:11px;font-weight:550;color:#aab8ca}
    .ticket{background:#29384c;color:#d8e6f7;padding:2px 7px;border-radius:5px;white-space:nowrap}
    .countdown{font-variant-numeric:tabular-nums;color:#b7c9dd;white-space:nowrap}
    .countdown.urgent{color:#ffbd80}
    .pagination{display:flex;align-items:center;gap:5px;margin-left:auto;font-size:10px}
    .pagination button{border:0;border-radius:4px;width:24px;height:23px;background:#29384c;
      color:#dce9fa;padding:0;font-family:inherit;font-size:15px;line-height:1;cursor:pointer}
    .pagination button:hover{background:#3a4c64}.pagination button:disabled{opacity:.4;cursor:default}
    .position{min-width:31px;text-align:center;color:#b6c6da;font-variant-numeric:tabular-nums}
    .question{font-size:17px;line-height:1.4;font-weight:650;letter-spacing:.15px;margin:7px 0 10px;
      overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .choices{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:9px}
    .option{display:flex;flex-direction:column;align-items:stretch;justify-content:space-between;gap:6px;
      min-width:0;min-height:65px;padding:9px 11px;border:1px solid #38b5f366;border-radius:9px;
      text-align:left;background:#0c5b81;color:#eff9ff;font:inherit;cursor:pointer;transition:background .15s,transform .15s}
    .option[data-answer="2"]{border-color:#ff82a066;background:#863550;color:#fff3f7}
    .option:hover:not(:disabled){background:#12749d;transform:translateY(-1px)}
    .option[data-answer="2"]:hover:not(:disabled){background:#a64665}
    .option:focus-visible,.pagination button:focus-visible{outline:2px solid #c8ebff;outline-offset:2px}
    .option:disabled{cursor:default;background:#253243;border-color:#46576c;color:#b4c4d6}
    .option.joined{border-color:#78d8b2;background:#234b44;color:#c0f5df}
    .option-title{display:flex;align-items:flex-start;gap:7px;min-width:0;font-size:14px;font-weight:600;line-height:1.3}
    .letter{font-size:11px;border:1px solid currentColor;border-radius:4px;min-width:18px;height:18px;
      line-height:16px;text-align:center;opacity:.8;flex:none;margin-top:1px}
    .label{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
    .option-bottom{display:flex;justify-content:space-between;gap:4px;align-items:center;font-size:11px;opacity:.9}
    .odds{font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.action{font-size:10px;white-space:nowrap;opacity:.85}
    .compact-status{font-size:11px;line-height:1.4;color:#a8bacf;margin:8px 0 0;overflow-wrap:anywhere;
      min-height:15px;white-space:normal}
    .compact-status[data-level="warn"]{color:#ffce97}.compact-status[data-level="success"]{color:#a0e9cb}
    @media(max-width:360px){.compact-card{padding-left:10px;padding-right:10px}.question{font-size:15px}
      .option{padding:8px;min-height:64px}.option-title{font-size:13px}.meta{gap:6px}}
    @media(prefers-reduced-motion:reduce){.option{transition:none}}
  `;
  const compactCard = compactElement('section', 'compact-card');
  compactCard.setAttribute('aria-label', '当前可参与的预言');
  const compactMeta = compactElement('div', 'meta');
  const compactTicket = compactElement('span', 'ticket', '实时预言');
  const compactCountdown = compactElement('span', 'countdown');
  const compactPagination = compactElement('div', 'pagination');
  compactPagination.hidden = true;
  const compactPrevious = compactElement('button', 'previous', '‹');
  compactPrevious.type = 'button'; compactPrevious.setAttribute('aria-label', '上一条可参与预言');
  const compactPosition = compactElement('span', 'position');
  const compactNext = compactElement('button', 'next', '›');
  compactNext.type = 'button'; compactNext.setAttribute('aria-label', '下一条可参与预言');
  compactPrevious.addEventListener('click', event => stepCompact(event, -1));
  compactNext.addEventListener('click', event => stepCompact(event, 1));
  compactPagination.append(compactPrevious, compactPosition, compactNext);
  compactMeta.append(compactTicket, compactCountdown, compactPagination);
  const compactQuestion = compactElement('h2', 'question', '正在加载当前预言…');
  const compactChoices = compactElement('div', 'choices');
  const compactOptions = [1, 2].map(answer => {
    const button = compactElement('button', 'option');
    button.type = 'button'; button.dataset.answer = String(answer); button.disabled = true;
    const top = compactElement('span', 'option-title');
    const letter = compactElement('span', 'letter', answer === 1 ? 'A' : 'B');
    const label = compactElement('span', 'label');
    top.append(letter, label);
    const bottom = compactElement('span', 'option-bottom');
    const odds = compactElement('span', 'odds');
    const action = compactElement('span', 'action', '参与');
    bottom.append(odds, action); button.append(top, bottom);
    button.addEventListener('click', event => { void chooseCompact(event, answer); });
    compactChoices.append(button);
    return { button, label, odds, action };
  });
  const compactStatus = compactElement('p', 'compact-status');
  compactStatus.setAttribute('role', 'status'); compactStatus.setAttribute('aria-live', 'polite');
  compactCard.append(compactMeta, compactQuestion, compactChoices, compactStatus);
  compactShadow.append(compactStyle, compactCard);
  doc.body.append(compactHost);
  if (typeof win.ResizeObserver === 'function') {
    compactResizeObserver = new win.ResizeObserver(() => reportCompactHeight());
    compactResizeObserver.observe(compactCard);
  }
  probeStorage();
  doc.addEventListener('click', captureManual, true);
  doc.addEventListener('visibilitychange', visibilityChanged);
  win.addEventListener('message', receive);
  win.addEventListener('hashchange', routeChanged);
  win.addEventListener('popstate', routeChanged);
  win.addEventListener('pagehide', pageHide);
  win.addEventListener('pageshow', pageShow);
  win.addEventListener('storage', storageChanged);
  const interval = win.setInterval(tick, 250);
  function dispose() {
    if (disposed) return;
    disposed = true;
    generation += 1;
    identitySequence += 1;
    for (const controller of navControllers) controller.abort();
    navControllers.clear();
    win.clearInterval(interval);
    for (const handle of pendingTimers) win.clearTimeout(handle);
    pendingTimers.clear();
    doc.removeEventListener('click', captureManual, true);
    doc.removeEventListener('visibilitychange', visibilityChanged);
    win.removeEventListener('message', receive);
    win.removeEventListener('hashchange', routeChanged);
    win.removeEventListener('popstate', routeChanged);
    win.removeEventListener('pagehide', pageHide);
    win.removeEventListener('pageshow', pageShow);
    win.removeEventListener('storage', storageChanged);
    try { if (client?.get === getHook) client.get = rawGet; } catch (_) {}
    try { if (client?.post === postHook) client.post = rawPost; } catch (_) {}
    try { cancelDialog?.(); } catch (_) {}
    delete doc.documentElement.dataset.bp4Compact;
    if (compactCompatHost) delete compactCompatHost.dataset.presentation;
    compactCompatStyle?.remove();
    compactResizeObserver?.disconnect();
    compactHost.remove();
    compactPending = compactFeedback = compactCurrent = null;
    style.remove();
    for (const card of doc.querySelectorAll('.content-prohets-box')) {
      card.classList.remove('bp3-joinable');
      delete card.dataset.bp3ProphetId;
      delete card.dataset.bp3Joinable;
      delete card.dataset.bp3ManualIntent;
    }
  }
  installRequestHooks();
  return { dispose, publishDialog };
}

  const MESSAGE_CHANNEL = 'bili-prophecy-v3';
  const SETTINGS_PREFIX = 'bili-prophecy:v3:settings:';
  const DEFAULT_SETTINGS = Object.freeze({ version: 1, overlayEnabled: true,
    enabled: false, strategy: 'lower', maxTicket: 1, minBalance: 10,
    authorizedViewerId: null, authorizedAnchorId: null });

  function normalizeSettings(value) {
    if (!value || value.version !== 1) return { ...DEFAULT_SETTINGS };
    const validBudget = Number.isSafeInteger(value.maxTicket) && value.maxTicket >= 1 &&
      Number.isSafeInteger(value.minBalance) && value.minBalance >= 0;
    const validStrategy = ['higher', 'lower'].includes(value.strategy);
    const authorizedViewerId = numericId(value.authorizedViewerId);
    const authorizedAnchorId = numericId(value.authorizedAnchorId);
    return { version: 1, overlayEnabled: value.overlayEnabled !== false,
      enabled: value.enabled === true && validBudget && validStrategy && Boolean(authorizedViewerId && authorizedAnchorId),
      strategy: validStrategy ? value.strategy : DEFAULT_SETTINGS.strategy,
      maxTicket: validBudget ? value.maxTicket : DEFAULT_SETTINGS.maxTicket,
      minBalance: validBudget ? value.minBalance : DEFAULT_SETTINGS.minBalance,
      authorizedViewerId, authorizedAnchorId };
  }

  function mount(win, doc) {
    if (win.top !== win.self || win.location.hostname !== 'live.bilibili.com') return null;
    if (!roomIdFromPath(win.location.pathname) || doc.getElementById(HOST_ID)) return null;

    function el(tag, className, content) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (content !== undefined) node.textContent = content;
      return node;
    }
    function button(className, content, handler) {
      const node = el('button', className, content);
      node.type = 'button';
      node.addEventListener('click', handler);
      return node;
    }

    let route = win.location.pathname;
    let context = null;
    let frame = null;
    let nonce = null;
    let controller = null;
    let requestSequence = 0;
    let disposed = false;
    let suspended = false;
    let mode = 'closed';
    let settingsOpen = false;
    let settings = readSettings();
    let seen = new Set();
    let pendingNew = [];
    let revealId = null;
    let lastSnapshot = null;
    let snapshotAt = 0;
    let compatReady = false;
    let frameStartedAt = 0;
    let manualDialogOpen = false;
    let compactHeight = 188;
    let geometryFrame = null;
    let fullscreenTimer = null;
    let nativeFullscreen = null;
    const fullscreenHooks = [];

    const host = el('div');
    host.id = HOST_ID;
    host.dataset.version = '1.0.0';
    host.dataset.mode = mode;
    host.dataset.engineState = 'idle';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = el('style');
    style.textContent = `
      :host { all: initial; display: block !important; visibility: visible !important;
        position: fixed; z-index: 2147483646; right: 16px; bottom: 78px;
        color: #edf2f8; font: 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",
        "Microsoft YaHei",sans-serif; color-scheme: dark; }
      :host([hidden]), [hidden] { display: none !important; }
      * { box-sizing: border-box; }
      button,input,select,a { font: inherit; }
      button { cursor: pointer; }
      button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible {
        outline: 2px solid #8ae5f2; outline-offset: 3px; }
      .launcher { position: fixed; inset: auto; right: 16px; bottom: 78px; margin: 0;
        width: auto; height: auto; max-width: none; max-height: none;
        border: 1px solid #5b627b; border-radius: 24px; color: #f5f2f7;
        background: #202333; padding: 10px 17px; box-shadow: 0 5px 22px #0006; }
      .launcher:hover { background: #303347; border-color: #fc92b2; }
      .launcher[data-auto="true"] { border-color: #78d9ae; }
      .launcher[data-new="true"]::after { content: ' · 新'; color: #ffc37e; }
      .launcher::backdrop { background: transparent; pointer-events: none; }
      .panel { position: fixed; inset: auto; margin: 0; padding: 0; display: flex;
        flex-direction: column; overflow: hidden; max-width: none; max-height: none;
        border: 1px solid #535c74; border-radius: 14px; background: #171b29; color: #edf2f8;
        box-shadow: 0 16px 54px #0009; font: inherit; z-index: 100002; }
      .panel::backdrop { background: transparent; pointer-events: none; }
      .panel[data-mode="overlay"] { border-color: #ffffff30; border-radius: 16px;
        background: #111a29ef; box-shadow: 0 12px 40px #0008;
        backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); }
      .panel[data-mode="overlay"] .header { padding: 8px 12px 0; min-height: 34px; gap: 8px; }
      .panel[data-mode="overlay"] .title { font-size: 11px; color: #b7c9de;
        font-weight: 600; letter-spacing: .08em; }
      .panel[data-mode="overlay"] .title::before { content: '✦'; color: #6bcaf5; margin-right: 6px; }
      .panel[data-mode="overlay"] .badge,
      .panel[data-mode="overlay"] .tools,
      .panel[data-mode="overlay"] .footer { display: none; }
      .panel[data-mode="overlay"] .frame-area,
      .panel[data-mode="overlay"] iframe { background: transparent; }
      .compact-detail { display: none; }
      .panel[data-mode="overlay"] .compact-detail { display: inline-block; }
      .compact-detail,.panel[data-mode="overlay"] .settings-button,
      .panel[data-mode="overlay"] .collapse { background: transparent; color: #a9bbd0;
        border: 0; border-radius: 5px; font-size: 11px; padding: 3px 5px; }
      .compact-detail:hover,.panel[data-mode="overlay"] .settings-button:hover,
      .panel[data-mode="overlay"] .collapse:hover { background: #ffffff12; color: #fff; }
      .header { display: flex; align-items: center; gap: 8px; padding: 10px 12px 7px; flex-shrink: 0; }
      .title { margin: 0; font-size: 16px; font-weight: 650; }
      .badge { color: #fdb6cb; background: #fc729917; border: 1px solid #fc72992b;
        font-size: 10px; border-radius: 5px; padding: 1px 5px; white-space: nowrap; }
      .header-spacer { flex: 1; }
      .settings-button,.collapse,.dock-button { color: #d5dcf0; border: 0; border-radius: 5px;
        background: #ffffff09; font-size: 12px; padding: 4px 6px; white-space: nowrap; }
      .settings-button:hover,.collapse:hover,.dock-button:hover { background: #ffffff1d; }
      .tools { display: flex; align-items: center; gap: 9px; padding: 0 12px 8px;
        color: #a8b4ca; border-bottom: 1px solid #343a4e; font-size: 11px; flex-shrink: 0; }
      .room { flex: 1; }
      .open-link { color: #8ae5f2; text-decoration: none; white-space: nowrap; }
      .open-link:hover { text-decoration: underline; }
      .frame-area { position: relative; flex: 1; min-height: 0; background: #12101a; }
      iframe { display: block; width: 100%; height: 100%; border: 0; background: #12101a; }
      .message { padding: 30px 20px; color: #c8d0e1; text-align: center; line-height: 1.8; }
      .message p { margin: 0 0 12px; overflow-wrap: anywhere; }
      .retry,.save-settings { color: #171523; background: #fb94b4; border: 1px solid #fb94b4;
        padding: 7px 14px; border-radius: 7px; font-weight: 650; }
      .footer { color: #b5bfd3; background: #1b2030; border-top: 1px solid #343a4e;
        padding: 7px 12px; font-size: 11px; line-height: 1.6; flex-shrink: 0; }
      .engine-status { margin: 0; overflow-wrap: anywhere; }
      .engine-status[data-level="error"],.settings-feedback[data-error="true"] { color: #ffbaac; }
      .engine-status[data-level="warn"] { color: #ffcf91; }
      .settings { padding: 14px 16px; overflow: auto; flex: 1; min-height: 0; }
      .settings h3 { margin: 0 0 12px; font-size: 15px; }
      .setting-toggle { display: flex; gap: 10px; align-items: start; padding: 10px 0; }
      .setting-toggle input { margin: 4px 0 0; accent-color: #fb94b4; width: 17px; height: 17px; }
      .setting-toggle span { flex: 1; }
      .setting-toggle small,.help { display: block; color: #aebad0; font-size: 11px; line-height: 1.7; }
      .budget { border: 1px solid #444d64; padding: 12px; margin: 10px 0 12px; border-radius: 9px; }
      .field { display: grid; grid-template-columns: 1fr 128px; align-items: center; gap: 10px; margin: 0 0 12px; }
      .field:last-child { margin-bottom: 0; }
      input[type="number"],select { width: 100%; background: #252c3f; color: #f2f5fb;
        border: 1px solid #69718a; border-radius: 6px; padding: 7px 8px; min-width: 0; }
      .help { margin: 10px 0; }
      .settings-feedback { margin: 10px 0 0; min-height: 18px; font-size: 12px; color: #96e2bd; }
      .settings-actions { display: flex; align-items: center; gap: 10px; }
      @media (max-width: 480px) { :host,.launcher { right: 12px; bottom: 20px; }
        .header { gap: 5px; } .badge { font-size: 9px; } }
    `;
    const launcher = button('launcher', '✦ 预言', () => reopenPanel());
    launcher.setAttribute('aria-label', '打开 B 站预言与设置');
    launcher.setAttribute('aria-expanded', 'false');
    if (typeof launcher.showPopover === 'function') launcher.setAttribute('popover', 'manual');
    const panel = el('section', 'panel');
    panel.id = 'prophecy-panel';
    panel.hidden = true;
    panel.setAttribute('aria-label', 'B 站直播预言');
    // Top-layer placement keeps the same iframe alive over inline and full-screen video.
    if (typeof panel.showPopover === 'function') panel.setAttribute('popover', 'manual');
    const header = el('header', 'header');
    const title = el('h2', 'title', '预言');
    const badge = el('span', 'badge', 'v1.0.0');
    const compactDetail = button('compact-detail', '完整面板', () => openPanel('dock', true));
    const settingsButton = button('settings-button', '设置', () => toggleSettings());
    settingsButton.setAttribute('aria-expanded', 'false');
    const collapseButton = button('collapse', '收起 ×', () => closePanel());
    collapseButton.setAttribute('aria-label', '收起预言，保留已开启的监测');
    header.append(title, badge, el('span', 'header-spacer'), compactDetail, settingsButton, collapseButton);
    const toolsRow = el('div', 'tools');
    const roomLabel = el('span', 'room', '房间 —');
    const dockButton = button('dock-button', '移到侧边', () => openPanel('dock', true));
    dockButton.hidden = true;
    const independent = el('a', 'open-link', '独立打开 ↗');
    independent.target = '_blank'; independent.rel = 'noopener noreferrer'; independent.hidden = true;
    toolsRow.append(roomLabel, dockButton, independent);
    const settingsArea = el('form', 'settings');
    settingsArea.hidden = true;
    settingsArea.append(el('h3', '', '当前直播间的偏好'));
    function toggle(id, label, description) {
      const wrap = el('label', 'setting-toggle');
      const input = el('input'); input.type = 'checkbox'; input.id = id;
      const copy = el('span', '', label); copy.append(el('small', '', description));
      wrap.append(input, copy); settingsArea.append(wrap); return input;
    }
    const overlayInput = toggle('setting-overlay', '新预言显示在视频上', '在视频底部居中显示精简参与卡片，全屏时也可选择和确认。');
    const autoInput = toggle('setting-auto', '最后 5 秒自动参与', '仅在你没有点过该题选项时执行；默认关闭。');
    const budget = el('div', 'budget');
    function field(id, label, input) {
      const row = el('label', 'field'); input.id = id;
      row.append(el('span', '', label), input); budget.append(row); return input;
    }
    const strategyInput = el('select');
    for (const [value, copy] of [['lower', '赔率较低'], ['higher', '赔率较高']]) {
      const option = el('option', '', copy); option.value = value; strategyInput.append(option);
    }
    field('setting-strategy', '自动选择', strategyInput);
    const maxInput = el('input'); maxInput.type = 'number'; maxInput.min = '1'; maxInput.step = '1'; maxInput.required = true;
    field('setting-max-ticket', '单题门票最多', maxInput);
    const minInput = el('input'); minInput.type = 'number'; minInput.min = '0'; minInput.step = '1'; minInput.required = true;
    field('setting-min-balance', '参与前硬币至少', minInput);
    settingsArea.append(budget,
      el('p', 'help', '赔率按提交前双方人数、计入你这一票后比较；相同则选左侧 A。票价上限是每道题的上限。余额下限按扣除本次门票前判断。'),
      el('p', 'help', '开启自动参与并保存后，对当前账号和直播间生效，收起面板仍会执行。点过选项的题目不再自动参与；失败或结果不明时不自动重试。关闭直播页即停止。'));
    const settingsActions = el('div', 'settings-actions');
    const saveButton = button('save-settings', '保存设置', () => {}); saveButton.type = 'submit';
    settingsActions.append(saveButton);
    const settingsFeedback = el('p', 'settings-feedback'); settingsFeedback.setAttribute('role', 'status');
    settingsArea.append(settingsActions, settingsFeedback);
    const frameArea = el('div', 'frame-area');
    const footer = el('div', 'footer');
    const engineStatus = el('p', 'engine-status', '自动参与已关闭 · 手动选择后仍需确认');
    engineStatus.setAttribute('role', 'status'); footer.append(engineStatus);
    panel.append(header, toolsRow, settingsArea, frameArea, footer);
    shadow.append(style, launcher, panel); doc.body.append(host);
    const homeParent = host.parentNode;
    const homeSibling = host.nextSibling;
    const fullscreenStyle = el('style');
    fullscreenStyle.dataset.bp4FullscreenStyle = 'true';
    fullscreenStyle.textContent = `
      [data-bp4-native-fullscreen="true"]:fullscreen { background: #000 !important; }
      [data-bp4-native-fullscreen="true"]:fullscreen [data-bp4-fullscreen-video="true"],
      :host([data-bp4-native-fullscreen="true"]:fullscreen) [data-bp4-fullscreen-video="true"] {
        position: absolute !important; inset: 0 !important; width: 100% !important; height: 100% !important;
        max-width: none !important; max-height: none !important; object-fit: contain !important;
      }
    `;
    (doc.head || doc.documentElement).append(fullscreenStyle);

    function settingsKey() { return SETTINGS_PREFIX + roomIdFromPath(route); }
    function readSettings() {
      try { return normalizeSettings(JSON.parse(win.localStorage.getItem(SETTINGS_PREFIX + roomIdFromPath(route)))); }
      catch (_) { return { ...DEFAULT_SETTINGS }; }
    }
    function storageAvailable() {
      const key = SETTINGS_PREFIX + 'storage-check';
      try { win.localStorage.setItem(key, 'ok'); const ok = win.localStorage.getItem(key) === 'ok'; win.localStorage.removeItem(key); return ok; }
      catch (_) { return false; }
    }
    function fillSettings() {
      overlayInput.checked = settings.overlayEnabled; autoInput.checked = settings.enabled;
      strategyInput.value = settings.strategy; maxInput.value = String(settings.maxTicket); minInput.value = String(settings.minBalance);
    }
    function report(text, level = 'info') {
      engineStatus.textContent = text; engineStatus.dataset.level = level;
    }
    function updateLauncher() {
      launcher.dataset.auto = String(settings.enabled);
      launcher.textContent = settings.enabled ? '✦ 预言 · 自动开' : '✦ 预言';
      badge.textContent = settings.enabled ? '自动已开启' : 'v1.0.0';
    }
    function wantsFrame() { return !suspended && (mode !== 'closed' || settings.overlayEnabled || settings.enabled); }
    function removeFrame() {
      configureChild(true);
      if (frame) frame.remove(); frame = null; nonce = null; compatReady = false;
      manualDialogOpen = false; frameArea.replaceChildren();
    }
    function message(text, retry) {
      removeFrame(); const box = el('div', 'message'); box.setAttribute('role', 'status');
      box.append(el('p', '', text)); if (retry) box.append(button('retry', '重试', () => loadRoom())); frameArea.append(box);
    }
    function configureChild(stop = false) {
      if (!frame || !context || !nonce) return;
      try { frame.contentWindow.postMessage({ channel: MESSAGE_CHANNEL, type: 'configure', nonce,
        roomId: context.roomId, anchorId: context.anchorId,
        settings: { ...settings, enabled: !stop && !suspended && settings.enabled },
        presentation: mode, controlsOpen: settingsOpen, revealId, active: !stop && !suspended }, 'https://live.bilibili.com'); }
      catch (_) { /* A navigation invalidates the old frame; never fall back to a broad origin. */ }
    }
    function createFrame() {
      if (frame || !context || !wantsFrame() || disposed) return;
      frameArea.replaceChildren();
      nonce = typeof win.crypto.randomUUID === 'function' ? win.crypto.randomUUID() :
        Array.from(win.crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join('-');
      const url = officialUrl(context); independent.href = url; independent.hidden = false;
      roomLabel.textContent = `房间 ${context.roomId}`;
      frame = el('iframe'); frame.title = 'B 站官方直播预言'; frame.src = url;
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      frame.addEventListener('load', () => configureChild());
      frameStartedAt = win.performance.now(); compatReady = false;
      host.dataset.engineState = 'loading';
      frameArea.append(frame);
    }
    async function loadRoom() {
      const roomId = roomIdFromPath(route);
      if (!roomId || !wantsFrame() || disposed) return;
      if (context) { createFrame(); return; }
      if (controller) return;
      const current = new win.AbortController(); controller = current;
      const sequence = ++requestSequence; roomLabel.textContent = `房间 ${roomId}`;
      independent.hidden = true; message('正在读取直播间信息…', false);
      const timeout = win.setTimeout(() => current.abort(), 12000);
      try {
        const url = new URL(ROOM_INFO); url.searchParams.set('room_id', roomId);
        const response = await win.fetch(url.href, { method: 'GET', credentials: 'omit', redirect: 'error',
          cache: 'no-store', signal: current.signal });
        if (!response.ok) throw new Error(`直播间接口暂不可用（HTTP ${response.status}）。`);
        const resolved = parseRoomResponse(await response.json());
        if (disposed || !wantsFrame() || sequence !== requestSequence || roomIdFromPath(win.location.pathname) !== roomId) return;
        context = resolved; createFrame();
      } catch (error) {
        if (disposed || sequence !== requestSequence) return;
        message(error && error.name === 'AbortError' ? '读取直播间信息超时，请重试。' :
          error instanceof Error && /^直播间接口/.test(error.message) ? error.message : '暂时无法读取直播间信息，请重试。', true);
        report('预言页面未加载，请打开面板重试', 'warn');
      } finally { win.clearTimeout(timeout); if (controller === current) controller = null; }
    }

    function fullscreenSurface() {
      let current = doc.fullscreenElement || doc.webkitFullscreenElement || null;
      // In a shadow tree the document exposes the host, while its shadow root
      // exposes the actual full-screen surface.
      while (current?.shadowRoot?.fullscreenElement) current = current.shadowRoot.fullscreenElement;
      return current;
    }
    function restoreNativeFullscreen() {
      const previous = nativeFullscreen;
      nativeFullscreen = null;
      if (!previous) return;
      for (const [node, name, value] of previous.attributes) {
        if (value === null) node.removeAttribute(name); else node.setAttribute(name, value);
      }
      previous.shadowStyle?.remove();
    }
    function installFullscreenHook() {
      const prototype = win.Element?.prototype;
      const original = prototype?.requestFullscreen;
      if (typeof original !== 'function') return;
      const wrapped = function (...args) {
        // A native <video> is a replaced element: its fallback DOM children
        // cannot host interactive controls. Ask its existing player container
        // to enter fullscreen during the SAME user gesture instead.
        if (disposed || this?.ownerDocument !== doc || this.nodeName !== 'VIDEO' ||
            !this.isConnected || !roomIdFromPath(win.location.pathname)) return Reflect.apply(original, this, args);
        const target = this.parentElement || this.getRootNode()?.host;
        if (!target || ['BODY', 'HTML', 'VIDEO', 'IFRAME'].includes(target.nodeName) ||
            typeof target.moveBefore !== 'function' || !target.isConnected) return Reflect.apply(original, this, args);
        if (nativeFullscreen) {
          const existing = nativeFullscreen;
          if (existing.video === this && existing.target === target) {
            // Rejected repeated requests must leave the current fullscreen
            // styling intact, including while the initial request is pending.
            return Promise.resolve(Reflect.apply(original, target, args)).then(value => {
              if (nativeFullscreen === existing && fullscreenSurface() === target) existing.entered = true;
              return value;
            });
          }
          // Another media request keeps its native behavior; never tear down
          // the currently active video's style before that request succeeds.
          return Reflect.apply(original, this, args);
        }
        restoreNativeFullscreen();
        const state = { video: this, target, entered: false, attributes: [
          [target, 'data-bp4-native-fullscreen', target.getAttribute('data-bp4-native-fullscreen')],
          [this, 'data-bp4-fullscreen-video', this.getAttribute('data-bp4-fullscreen-video')]
        ], shadowStyle: null };
        nativeFullscreen = state;
        target.setAttribute('data-bp4-native-fullscreen', 'true');
        this.setAttribute('data-bp4-fullscreen-video', 'true');
        const root = this.getRootNode();
        if (root !== doc && root?.host) {
          state.shadowStyle = fullscreenStyle.cloneNode(true);
          root.append(state.shadowStyle);
        }
        try {
          const result = Reflect.apply(original, target, args);
          return Promise.resolve(result).then(value => {
            if (nativeFullscreen === state) {
              state.entered = true;
              if (fullscreenSurface() !== target) restoreNativeFullscreen();
            }
            return value;
          }).catch(error => {
            if (nativeFullscreen === state) restoreNativeFullscreen();
            throw error;
          });
        } catch (error) {
          if (nativeFullscreen === state) restoreNativeFullscreen();
          throw error;
        }
      };
      try {
        prototype.requestFullscreen = wrapped;
        if (prototype.requestFullscreen === wrapped) fullscreenHooks.push([prototype, original, wrapped]);
      } catch (_) { /* Container fullscreen remains supported without this convenience hook. */ }
    }
    function syncFullscreenHost() {
      const fullscreen = fullscreenSurface();
      if (nativeFullscreen && fullscreen === nativeFullscreen.target) nativeFullscreen.entered = true;
      else if (nativeFullscreen?.entered) restoreNativeFullscreen();
      if (!host.isConnected) return false;
      // A shadow host's unslotted light DOM does not participate in its flat
      // tree; place our host in its open shadow root when that is the surface.
      const target = fullscreen ? (fullscreen.shadowRoot || fullscreen) : (homeParent.isConnected ? homeParent : doc.body);
      if (!target || target.ownerDocument !== doc || target === host || !target.isConnected) return false;
      if (fullscreen && ['VIDEO', 'IFRAME', 'EMBED', 'OBJECT'].includes(fullscreen.nodeName)) return false;
      if (fullscreen ? target.contains(host) : host.parentNode === target) return true;
      if (typeof target.moveBefore !== 'function') return false;
      try {
        // Atomic relocation preserves the iframe document, SDK, confirmation,
        // pending request and account lock. appendChild would destroy that state.
        target.moveBefore(host, !fullscreen && homeSibling?.parentNode === target ? homeSibling : null);
        return true;
      } catch (_) { return false; }
    }
    function visibleRect(node, minWidth = 240, minHeight = 140) {
      if (!node?.isConnected || typeof node.getBoundingClientRect !== 'function') return null;
      try {
        const rect = node.getBoundingClientRect();
        const left = Math.max(0, rect.left); const top = Math.max(0, rect.top);
        const right = Math.min(win.innerWidth, rect.right); const bottom = Math.min(win.innerHeight, rect.bottom);
        if (right - left < minWidth || bottom - top < minHeight) return null;
        const css = win.getComputedStyle(node);
        if (css.display === 'none' || css.visibility === 'hidden') return null;
        return { left, top, right, bottom, width: right - left, height: bottom - top };
      } catch (_) { return null; }
    }
    function videosWithin(root) {
      const result = [];
      const roots = [root];
      const visited = new Set();
      while (roots.length) {
        const scope = roots.pop();
        if (!scope || visited.has(scope)) continue;
        visited.add(scope);
        if (scope.nodeName === 'VIDEO') result.push(scope);
        if (!scope.querySelectorAll) continue;
        result.push(...scope.querySelectorAll('video'));
        // Player wrappers can keep their video inside an open shadow root.
        // Never walk the script's own iframe or any unrelated frame document.
        if (scope.shadowRoot && scope !== host) roots.push(scope.shadowRoot);
        for (const node of scope.querySelectorAll('*')) {
          if (node !== host && node.shadowRoot) roots.push(node.shadowRoot);
        }
      }
      return result;
    }
    function findVideoRect() {
      const fullscreen = fullscreenSurface();
      let best = null; let area = 0;
      for (const video of videosWithin(fullscreen || doc)) {
        const rect = visibleRect(video);
        if (!rect) continue;
        const visibleArea = rect.width * rect.height;
        if (visibleArea > area) { area = visibleArea; best = rect; }
      }
      // During a native full-screen transition the video can be replaced or
      // briefly have zero dimensions. The confirmed full-screen element is
      // still a usable surface, including a full-screen player iframe.
      return best || (fullscreen ? visibleRect(fullscreen) : null);
    }
    function positionPanel() {
      if (mode === 'closed') return true;
      let left, top, width, height;
      if (mode === 'overlay') {
        const rect = findVideoRect();
        if (!rect) return false;
        width = Math.min(500, rect.width - 24);
        const desiredHeight = (manualDialogOpen ? Math.max(320, compactHeight) : compactHeight) + 36;
        const preferredGap = fullscreenSurface() ? 76 : 60;
        const gap = Math.max(8, Math.min(preferredGap, rect.height - desiredHeight - 16));
        height = Math.min(desiredHeight, rect.height - gap - 8);
        left = rect.left + (rect.width - width) / 2;
        top = rect.bottom - gap - height;
      } else {
        width = Math.min(420, win.innerWidth - 24); height = Math.min(680, win.innerHeight - 48);
        left = win.innerWidth - width - 12; top = Math.max(12, win.innerHeight - height - 24);
      }
      Object.assign(panel.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
      return true;
    }
    function showLauncher(reorder = false) {
      if (disposed || host.hidden) return;
      launcher.hidden = false;
      if (launcher.hasAttribute('popover')) {
        try {
          if (reorder && launcher.matches(':popover-open')) launcher.hidePopover();
          if (!launcher.matches(':popover-open')) launcher.showPopover();
        } catch (_) { /* Keep the capability and retry after the transition. */ }
      }
    }
    function hideLauncher() {
      if (launcher.hasAttribute('popover')) {
        try { if (launcher.matches(':popover-open')) launcher.hidePopover(); } catch (_) {}
      }
      launcher.hidden = true;
    }
    function showTopLayer() {
      panel.hidden = false;
      if (panel.hasAttribute('popover')) {
        try { if (!panel.matches(':popover-open')) panel.showPopover(); }
        catch (_) { /* A temporary transition must not permanently remove top-layer support. */ }
      }
    }
    function hideTopLayer() {
      if (panel.hasAttribute('popover')) {
        try { if (panel.matches(':popover-open')) panel.hidePopover(); } catch (_) { /* Already detached. */ }
      }
      panel.hidden = true;
    }
    function reopenPanel() {
      if (fullscreenSurface() && settings.overlayEnabled && lastSnapshot) {
        const now = lastSnapshot.serverNowMs + win.performance.now() - snapshotAt;
        const item = lastSnapshot.items.find(item => item.status === 1 && item.myAnswer === 0 && item.deadlineMs > now);
        if (item) {
          revealId = String(item.prophetId);
          openPanel('overlay', true);
          if (mode === 'overlay') return;
        }
      }
      openPanel('dock', true);
    }
    function openPanel(nextMode = 'dock', focus = false) {
      syncRoute(); if (disposed || suspended || !roomIdFromPath(route)) return;
      syncFullscreenHost();
      if (nextMode === 'overlay' && (!settings.overlayEnabled || settingsOpen || manualDialogOpen)) return;
      const previous = mode; mode = nextMode;
      if (!positionPanel()) { mode = previous; launcher.dataset.new = 'true'; showLauncher(); return; }
      host.dataset.mode = panel.dataset.mode = mode;
      host.dataset.geometry = 'ready';
      title.textContent = mode === 'overlay' ? '直播预言' : '预言';
      collapseButton.textContent = mode === 'overlay' ? '×' : '收起 ×';
      dockButton.hidden = mode !== 'overlay';
      hideLauncher(); launcher.dataset.new = 'false';
      launcher.setAttribute('aria-expanded', 'true');
      showTopLayer(); configureChild();
      if (focus) collapseButton.focus();
      void loadRoom();
    }
    function closePanel(restoreFocus = true) {
      pendingNew = []; launcher.dataset.new = 'false';
      mode = 'closed'; host.dataset.mode = panel.dataset.mode = mode;
      settingsOpen = false; settingsArea.hidden = true; frameArea.hidden = false;
      settingsButton.textContent = '设置'; settingsButton.setAttribute('aria-expanded', 'false');
      hideTopLayer(); showLauncher(); launcher.setAttribute('aria-expanded', 'false');
      configureChild();
      if (!wantsFrame()) {
        requestSequence += 1; if (controller) controller.abort(); controller = null; removeFrame();
      }
      if (restoreFocus && !host.hidden) launcher.focus();
    }
    function toggleSettings() {
      if (!settingsOpen) { openPanel('dock'); fillSettings(); settingsFeedback.textContent = ''; }
      settingsOpen = !settingsOpen;
      settingsArea.hidden = !settingsOpen; frameArea.hidden = settingsOpen;
      settingsButton.textContent = settingsOpen ? '返回预言' : '设置';
      settingsButton.setAttribute('aria-expanded', String(settingsOpen));
      configureChild();
      if (settingsOpen) overlayInput.focus();
    }
    function applySettings(next, persist) {
      if (persist) {
        if (next.enabled && !storageAvailable()) throw new Error('浏览器无法保存防重复记录，自动参与保持关闭。');
        win.localStorage.setItem(settingsKey(), JSON.stringify(next));
      }
      settings = next; updateLauncher(); configureChild();
      if (!settings.overlayEnabled && mode === 'overlay') closePanel(false);
      if (!settings.overlayEnabled) pendingNew = [];
      report(settings.enabled ? '自动参与已开启 · 按配置等待最后 5 秒' : '自动参与已关闭 · 手动选择后仍需确认');
      if (wantsFrame()) void loadRoom(); else removeFrame();
    }
    settingsArea.addEventListener('submit', event => {
      event.preventDefault();
      if (!event.isTrusted) return;
      const ticket = maxInput.value.trim(); const balance = minInput.value.trim();
      const next = { version: 1, overlayEnabled: overlayInput.checked, enabled: autoInput.checked,
        strategy: strategyInput.value, maxTicket: ticket ? Number(ticket) : NaN, minBalance: balance ? Number(balance) : NaN,
        authorizedViewerId: null, authorizedAnchorId: null };
      if (!Number.isSafeInteger(next.maxTicket) || next.maxTicket < 1 || !Number.isSafeInteger(next.minBalance) ||
          next.minBalance < 0 || !['lower', 'higher'].includes(next.strategy)) {
        settingsFeedback.dataset.error = 'true'; settingsFeedback.textContent = '请输入有效预算：门票上限为正整数，余额下限为非负整数。'; return;
      }
      if (next.enabled) {
        if (!context || !lastSnapshot || !numericId(lastSnapshot.viewerId) ||
            win.performance.now() - snapshotAt > 15000 || !compatReady) {
          settingsFeedback.dataset.error = 'true'; settingsFeedback.textContent = '请先等待官方面板读取登录状态，再保存开启自动参与。'; return;
        }
        next.authorizedViewerId = String(lastSnapshot.viewerId);
        next.authorizedAnchorId = context.anchorId;
      }
      try {
        applySettings(next, true); settingsFeedback.dataset.error = 'false';
        settingsFeedback.textContent = next.enabled ? '已保存，自动参与已开启。收起面板后仍生效。' : '已保存，自动参与已关闭。';
      } catch (error) {
        settings.enabled = false; autoInput.checked = false; updateLauncher(); configureChild();
        settingsFeedback.dataset.error = 'true'; settingsFeedback.textContent = error.message || '保存失败，自动参与保持关闭。';
      }
    });
    autoInput.addEventListener('change', event => {
      if (!event.isTrusted || autoInput.checked || !settings.enabled) return;
      // Turning automatic spending off is immediate, even before saving other edits.
      const next = { ...settings, enabled: false };
      try { applySettings(next, true); }
      catch (_) { applySettings(next, false); }
      settingsFeedback.dataset.error = 'false'; settingsFeedback.textContent = '自动参与已立即关闭。';
    });

    function handleSnapshot(data) {
      if (!Array.isArray(data.items) || data.items.length > 200) return;
      const now = Number(data.serverNowMs);
      if (!Number.isFinite(now) || now <= 0 || !Number.isFinite(data.clockAgeMs) || data.clockAgeMs > 15000) return;
      lastSnapshot = data; snapshotAt = win.performance.now();
      host.dataset.engineState = 'ready';
      const active = data.items.filter(item => numericId(item.prophetId) && item.status === 1 && item.myAnswer === 0 &&
        Number.isFinite(item.deadlineMs) && item.deadlineMs > now);
      const fresh = active.filter(item => !seen.has(String(item.prophetId)));
      for (const item of active) seen.add(String(item.prophetId));
      if (seen.size > 2000) seen = new Set([...seen].slice(-1000));
      if (fresh.length && settings.overlayEnabled && mode !== 'dock') {
        pendingNew.push(...fresh.map(item => String(item.prophetId)));
        launcher.dataset.new = 'true'; maybeOverlay();
      }
    }
    function maybeOverlay() {
      if (!pendingNew.length || !lastSnapshot || !settings.overlayEnabled || settingsOpen || manualDialogOpen ||
          mode === 'dock' || doc.visibilityState === 'hidden') return;
      const now = lastSnapshot.serverNowMs + win.performance.now() - snapshotAt;
      pendingNew = pendingNew.filter(id => lastSnapshot.items.some(item => String(item.prophetId) === id &&
        item.status === 1 && item.myAnswer === 0 && item.deadlineMs > now));
      if (!pendingNew.length) { launcher.dataset.new = 'false'; return; }
      if (!findVideoRect()) return;
      revealId = pendingNew[0];
      openPanel('overlay');
      if (mode === 'overlay') pendingNew = [];
    }
    function onMessage(event) {
      if (disposed || suspended || !frame || event.source !== frame.contentWindow || event.origin !== 'https://live.bilibili.com') return;
      const data = event.data;
      if (!data || data.channel !== MESSAGE_CHANNEL || data.nonce !== nonce || !context ||
          String(data.roomId) !== context.roomId || String(data.anchorId) !== context.anchorId) return;
      if (data.type === 'ready' || data.type === 'snapshot' || data.type === 'status') compatReady = true;
      if (data.type === 'snapshot') handleSnapshot(data);
      if (data.type === 'dialog') {
        manualDialogOpen = data.open === true;
        if (mode === 'overlay') onGeometry();
      }
      if (data.type === 'compact-layout' && Number.isFinite(data.height) && data.height >= 80 && data.height <= 1400) {
        compactHeight = Math.max(140, Math.min(640, Math.ceil(data.height)));
        if (mode === 'overlay') onGeometry();
      }
      if (data.type === 'status' && typeof data.text === 'string') report(data.text.slice(0, 240), ['warn', 'error'].includes(data.level) ? data.level : 'info');
    }
    function syncRoute() {
      if (disposed) return;
      const next = win.location.pathname;
      if (!suspended && !host.isConnected && doc.body) {
        // A player may replace its entire fullscreen subtree. Its old iframe
        // has already unloaded; explicitly rebuild from persisted attempt and
        // settings records instead of keeping stale frame/confirmation objects.
        removeFrame(); context = null; lastSnapshot = null; snapshotAt = 0;
        doc.body.append(host); closePanel(false);
        report('正在恢复预言状态…');
        if (roomIdFromPath(next) && wantsFrame()) void loadRoom();
      }
      if (route !== next) {
        configureChild(true); requestSequence += 1;
        if (controller) controller.abort(); controller = null;
        closePanel(false); removeFrame(); context = null; route = next;
        seen = new Set(); pendingNew = []; revealId = null; lastSnapshot = null; compactHeight = 188; settings = readSettings();
        fillSettings(); updateLauncher();
        if (roomIdFromPath(route) && wantsFrame()) void loadRoom();
      }
      host.hidden = !roomIdFromPath(next);
      syncFullscreenHost();
      if (host.hidden) hideLauncher();
      else if (mode === 'closed') showLauncher();
    }
    function onStorage(event) {
      if (event.key !== settingsKey()) return;
      applySettings(readSettings(), false);
      if (settingsOpen) { fillSettings(); settingsFeedback.textContent = '已同步其他页面的设置。'; }
    }
    function onFullscreen() {
      function reorder() {
        if (disposed || suspended) return;
        syncFullscreenHost();
        if (mode === 'closed') showLauncher(true);
        else {
          // Fullscreen and popovers share the browser's top layer. Re-enter
          // after fullscreen has been added, without moving the live iframe.
          hideTopLayer();
          onGeometry();
        }
        maybeOverlay();
      }
      reorder();
      if (geometryFrame !== null) win.cancelAnimationFrame(geometryFrame);
      geometryFrame = win.requestAnimationFrame(() => { geometryFrame = null; reorder(); });
      win.clearTimeout(fullscreenTimer);
      fullscreenTimer = win.setTimeout(reorder, 180);
    }
    function onGeometry() {
      if (mode !== 'closed') {
        if (!positionPanel()) {
          // Zero-sized/replaced video during fullscreen is transient. Keep the
          // reminder, iframe, selection and automation state for the next pass.
          host.dataset.geometry = 'waiting'; hideTopLayer(); showLauncher();
        } else {
          host.dataset.geometry = 'ready'; hideLauncher(); showTopLayer();
        }
      }
      maybeOverlay();
    }
    function scheduleGeometry() {
      if (geometryFrame !== null) return;
      geometryFrame = win.requestAnimationFrame(() => { geometryFrame = null; onGeometry(); });
    }
    function onPageHide(event) {
      suspended = true; configureChild(true); closePanel(false); removeFrame();
      if (!event.persisted) dispose();
    }
    function onPageShow() {
      suspended = false; syncRoute(); settings = readSettings(); updateLauncher();
      if (wantsFrame()) void loadRoom();
    }
    function dispose() {
      if (disposed) return;
      configureChild(true); disposed = true;
      if (controller) controller.abort(); requestSequence += 1; removeFrame(); hideTopLayer();
      win.clearInterval(routeTimer); win.clearInterval(heartbeatTimer);
      if (geometryFrame !== null) win.cancelAnimationFrame(geometryFrame);
      win.clearTimeout(fullscreenTimer); hideLauncher();
      for (const [target, event, handler, options] of listeners) target.removeEventListener(event, handler, options);
      for (const [name, original, wrapped] of historyHooks) if (win.history[name] === wrapped) win.history[name] = original;
      for (const [prototype, original, wrapped] of fullscreenHooks) {
        if (prototype.requestFullscreen === wrapped) prototype.requestFullscreen = original;
      }
      restoreNativeFullscreen(); fullscreenStyle.remove();
      host.remove();
    }
    const listeners = [
      [win, 'message', onMessage], [win, 'storage', onStorage], [win, 'popstate', syncRoute],
      [win, 'pagehide', onPageHide], [win, 'pageshow', onPageShow],
      [win, 'resize', scheduleGeometry], [win, 'scroll', scheduleGeometry, { capture: true, passive: true }],
      [doc, 'fullscreenchange', onFullscreen, true], [doc, 'webkitfullscreenchange', onFullscreen, true],
      [doc, 'visibilitychange', maybeOverlay]
    ];
    for (const [target, event, handler, options] of listeners) target.addEventListener(event, handler, options);
    // In fullscreen the toolbar is inside the player. Its controls must not
    // bubble into the player's click-to-pause or keyboard shortcuts.
    for (const name of ['click', 'dblclick', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'keydown', 'keyup', 'wheel']) {
      shadow.addEventListener(name, event => event.stopPropagation(), { passive: true });
    }
    shadow.addEventListener('keydown', event => {
      if (event.key === 'Escape' && mode !== 'closed') { event.stopPropagation(); closePanel(); }
    });
    const historyHooks = [];
    for (const name of ['pushState', 'replaceState']) {
      const original = win.history[name];
      const wrapped = function (...args) { const result = Reflect.apply(original, this, args); syncRoute(); return result; };
      try { win.history[name] = wrapped; historyHooks.push([name, original, wrapped]); } catch (_) { /* Timer fallback. */ }
    }
    const routeTimer = win.setInterval(() => { syncRoute(); onGeometry(); }, 1000);
    const heartbeatTimer = win.setInterval(() => {
      configureChild();
      if (frame && !compatReady && win.performance.now() - frameStartedAt > 22000) {
        host.dataset.engineState = 'error';
        report('子页面脚本未就绪：请确认油猴允许在 iframe 中运行，再刷新直播间。自动参与未启动。', 'warn');
      }
    }, 2000);
    installFullscreenHook(); syncFullscreenHost();
    fillSettings(); updateLauncher();
    showLauncher();
    if (settings.enabled) report('自动参与已开启 · 沿用此直播间已保存的配置');
    if (wantsFrame()) void loadRoom();
    return Object.freeze({ dispose });
  }

  // Offline tests exercise the exact policy and helpers in the shipped script.
  if (typeof window === 'undefined' && typeof module === 'object' && module.exports) {
    module.exports = { numericId, roomIdFromPath, parseRoomResponse, officialUrl,
      isOfficialLocation, installOfficialCompatibility, mount, normalizeSettings,
      DEFAULT_SETTINGS, ProphecyPolicy, createChildEngine };
    return;
  }
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (isOfficialLocation(window.location)) installOfficialCompatibility(window, document);
    else mount(window, document);
  }
})();
