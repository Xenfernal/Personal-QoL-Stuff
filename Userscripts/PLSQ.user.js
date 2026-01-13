// ==UserScript==
// @name         Prefer lowest stream quality on Twitch
// @namespace    https://github.com/Xenfernal
// @version      1.3
// @icon         https://www.google.com/s2/favicons?sz=64&domain=twitch.tv
// @license      MIT
// @author       Xen
// @description  Selects the lowest available Twitch quality per stream (SPA-safe) with minimal UI spam.
// @match        https://www.twitch.tv/*
// @grant        none
// @homepageURL  https://github.com/Xenfernal/Personal-QoL-Stuff/tree/main/Userscripts
// @downloadURL  https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/PLSQ.user.js
// @updateURL    https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/PLSQ.user.js
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';

  /* ===== Config ===== */
  const SETTLE_MS = 1200;
  const FALLBACK_TIMEOUT_MS = 4500;
  const NAV_DEBOUNCE_MS = 150;

  const TARGET_LOWEST_GROUP = '160p30';

  const ADS_BITRATE_BPS = 230000;
  const ADS_EXPIRE_MS = 180 * 24 * 60 * 60 * 1000;

  const STORAGE_PRIME_PATHS = new Set([
    '/directory/following/autolurk',
  ]);

  const LS_KEYS = {
    videoQuality: 'video-quality',
    qualityBitrate: 'quality-bitrate',
    sourceTs: 's-qs-ts',
    adsBitrate: 'ads_bitrate_bps',
  };

  const SEL = {
    settingsBtn: 'button[data-a-target="player-settings-button"]',
    menuRoot: '[data-a-target="player-settings-menu"]',
    qualityMenuItem: 'button[data-a-target="player-settings-menu-item-quality"]',
    qualityOption: '[data-a-target="player-settings-submenu-quality-option"]',
  };

  const CONSERVATIVE_BITRATES = new Map([
    ['160p30', 230000],
    ['360p30', 600000],
    ['480p30', 1450000],
    ['540p30', 1700000],
    ['540p60', 2300000],
    ['720p30', 2400000],
    ['720p60', 3450000],
    ['900p30', 3500000],
    ['900p60', 4500000],
    ['1080p30', 4500000],
    ['1080p60', 6000000],
    ['1440p30', 7000000],
    ['1440p60', 9000000],
  ]);

  const RESERVED_TOPLEVEL = new Set([
    '', 'directory', 'downloads', 'jobs', 'p', 'settings', 'wallet', 'subscriptions',
    'inventory', 'drops', 'turbo', 'prime', 'friends', 'search', 'videos', 'clips',
  ]);

  /* ===== State ===== */
  const state = {
    currentChannel: null,
    currentHref: location.href,
    navTimer: null,
    fallbackTimer: null,
    appliedThisNav: false,
    manualOverrideThisNav: false,
    scriptClickInProgress: false,
    navToken: 0,
  };

  /* ===== Utilities ===== */
  function isTopWindow() {
    return window.top === window.self;
  }

  function normalisedPathname() {
    const p = location.pathname || '/';
    return p.length > 1 ? p.replace(/\/+$/, '') : p;
  }

  function shouldPrimeStorageHere() {
    return isTopWindow() && STORAGE_PRIME_PATHS.has(normalisedPathname());
  }

  function getExistingQualityBitrate() {
    const v = Number(localStorage.getItem(LS_KEYS.qualityBitrate));
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  function bitrateForGroup(group) {
    if (CONSERVATIVE_BITRATES.has(group)) return CONSERVATIVE_BITRATES.get(group);

    const m = /^(\d+)p(\d+)$/.exec(group);
    if (!m) return null;

    const height = Number(m[1]);
    const fps = Number(m[2]);

    const baseline = 2400000;
    const relRes = height / 720;
    const relFps = fps / 30;
    const est = baseline * relRes * relRes * relFps;

    const clamped = Math.max(200000, Math.min(12000000, est));
    return Math.floor(clamped);
  }

  function setLocalStorageAdBitrate() {
    try {
      const payload = {
        value: ADS_BITRATE_BPS,
        __expireTimeEpoch: Date.now() + ADS_EXPIRE_MS,
      };
      localStorage.setItem(LS_KEYS.adsBitrate, JSON.stringify(payload));
    } catch {
      // best-effort
    }
  }

  // IMPORTANT: keep 1.0.1 behaviour (always write), to avoid “sticky” higher quality across reload/nav.
  function setLocalStorageQuality(group, bitrateBps) {
    try {
      localStorage.setItem(LS_KEYS.sourceTs, String(Date.now()));
      localStorage.setItem(LS_KEYS.videoQuality, JSON.stringify({ default: group }));
      if (typeof bitrateBps === 'number' && Number.isFinite(bitrateBps) && bitrateBps > 0) {
        localStorage.setItem(LS_KEYS.qualityBitrate, String(Math.floor(bitrateBps)));
      }
    } catch {
      // best-effort
    }
  }

  function isLiveChannelPath(pathname) {
    const parts = (pathname || '').split('/').filter(Boolean);
    if (parts.length !== 1) return false;
    const seg = parts[0].toLowerCase();
    if (RESERVED_TOPLEVEL.has(seg)) return false;
    if (seg.includes('.')) return false;
    return true;
  }

  function getChannelFromLocation() {
    if (!isLiveChannelPath(location.pathname)) return null;
    const seg = location.pathname.split('/').filter(Boolean)[0];
    return seg || null;
  }

  function schedule(fn) {
    if (state.navTimer) clearTimeout(state.navTimer);
    state.navTimer = setTimeout(fn, NAV_DEBOUNCE_MS);
  }

  function cancelFallback() {
    if (state.fallbackTimer) clearTimeout(state.fallbackTimer);
    state.fallbackTimer = null;
  }

  function waitForElement(selector, root, timeoutMs) {
    const base = root || document;
    const existing = base.querySelector(selector);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve) => {
      let done = false;

      const observer = new MutationObserver(() => {
        const el = base.querySelector(selector);
        if (el && !done) {
          done = true;
          clearTimeout(to);
          observer.disconnect();
          resolve(el);
        }
      });

      const to = setTimeout(() => {
        if (done) return;
        done = true;
        observer.disconnect();
        resolve(null);
      }, timeoutMs);

      observer.observe(base === document ? document.documentElement : base, { childList: true, subtree: true });
    });
  }

  function clickElement(el) {
    if (!el) return false;
    state.scriptClickInProgress = true;
    try {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    } finally {
      queueMicrotask(() => { state.scriptClickInProgress = false; });
    }
  }

  function parseQualityOptionText(text) {
    const t = (text || '').trim();
    if (!t) return null;

    if (/audio\s*only/i.test(t)) return { type: 'audio' };
    if (/^auto\b/i.test(t)) return { type: 'auto', group: 'auto' };
    if (/source/i.test(t)) return { type: 'source', group: 'chunked' };

    const m = /(\d+)\s*p(?:\s*(\d+))?/i.exec(t.replace(/\s+/g, ' '));
    if (!m) return null;

    const height = Number(m[1]);
    const fps = m[2] ? Number(m[2]) : 30;

    if (!Number.isFinite(height) || height <= 0) return null;
    if (!Number.isFinite(fps) || fps <= 0) return null;

    return { type: 'video', height, fps, group: `${height}p${fps}` };
  }

  function chooseLowestOption(optionButtons) {
    const parsed = [];

    for (const btn of optionButtons) {
      const info = parseQualityOptionText(btn.textContent);
      if (!info) continue;
      if (info.type === 'audio') continue;
      parsed.push({ btn, info });
    }

    const hasVideo = parsed.some(x => x.info.type === 'video');
    if (hasVideo) {
      parsed.sort((a, b) => {
        if (a.info.type === 'video' && b.info.type === 'video') {
          if (a.info.height !== b.info.height) return a.info.height - b.info.height;
          return a.info.fps - b.info.fps;
        }
        if (a.info.type === 'video') return -1;
        if (b.info.type === 'video') return 1;
        return 0;
      });
      return parsed[0];
    }

    const source = parsed.find(x => x.info.type === 'source');
    return source || null;
  }

  function stillValid(navToken) {
    return state.navToken === navToken && !state.appliedThisNav && !state.manualOverrideThisNav;
  }

  async function uiFallbackSelectLowest(navToken) {
    if (!stillValid(navToken)) return;

    const settingsBtn = await waitForElement(SEL.settingsBtn, document, FALLBACK_TIMEOUT_MS);
    if (!stillValid(navToken) || !settingsBtn) return;

    const menuAlreadyOpen = !!document.querySelector(SEL.menuRoot);
    if (!menuAlreadyOpen) clickElement(settingsBtn);

    const qualityMenuItem = await waitForElement(SEL.qualityMenuItem, document, FALLBACK_TIMEOUT_MS);
    if (!stillValid(navToken) || !qualityMenuItem) return;

    clickElement(qualityMenuItem);

    // Mitigation #1: remove redundant "optionBtn" variable; just wait for first option then read all options.
    const firstOption = await waitForElement(SEL.qualityOption, document, FALLBACK_TIMEOUT_MS);
    if (!stillValid(navToken) || !firstOption) return;

    // Mitigation #2: single query for options after submenu is present (no extra waits/queries).
    const options = Array.from(document.querySelectorAll(SEL.qualityOption));
    const chosen = chooseLowestOption(options);
    if (!chosen) return;

    clickElement(chosen.btn);

    const chosenGroup = chosen.info.group;
    if (chosenGroup && chosenGroup !== 'auto') {
      let bitrate = null;
      if (chosenGroup === 'chunked') {
        bitrate = getExistingQualityBitrate() ?? 8000000;
      } else {
        bitrate = bitrateForGroup(chosenGroup);
      }
      setLocalStorageQuality(chosenGroup, bitrate);
    }

    state.appliedThisNav = true;

    if (!menuAlreadyOpen) {
      const settingsBtn2 = document.querySelector(SEL.settingsBtn);
      if (settingsBtn2) clickElement(settingsBtn2);
    }
  }

  function applyForThisNavigation() {
    cancelFallback();

    const channel = getChannelFromLocation();
    const primeHere = shouldPrimeStorageHere();

    // Mitigation: do not write ads_bitrate_bps on non-player pages (unless prime path).
    if (!channel && !primeHere) {
      state.currentChannel = null;
      state.appliedThisNav = false;
      state.manualOverrideThisNav = false;
      return;
    }

    setLocalStorageAdBitrate();

    if (!channel) {
      const bitrate = bitrateForGroup(TARGET_LOWEST_GROUP);
      setLocalStorageQuality(TARGET_LOWEST_GROUP, bitrate);
      state.currentChannel = null;
      state.appliedThisNav = false;
      state.manualOverrideThisNav = false;
      return;
    }

    if (state.currentChannel !== channel) {
      state.currentChannel = channel;
      state.manualOverrideThisNav = false;
    }

    state.appliedThisNav = false;

    const bitrate = bitrateForGroup(TARGET_LOWEST_GROUP);
    setLocalStorageQuality(TARGET_LOWEST_GROUP, bitrate);

    const navToken = state.navToken;
    state.fallbackTimer = setTimeout(() => {
      uiFallbackSelectLowest(navToken);
    }, SETTLE_MS);
  }

  function onNavigationMaybe() {
    if (state.currentHref === location.href) return;
    state.currentHref = location.href;

    state.navToken += 1;
    state.appliedThisNav = false;
    state.manualOverrideThisNav = false;

    schedule(applyForThisNavigation);
  }

  function hookHistory() {
    const origPush = history.pushState;
    const origReplace = history.replaceState;

    history.pushState = function (...args) {
      const ret = origPush.apply(this, args);
      queueMicrotask(onNavigationMaybe);
      return ret;
    };

    history.replaceState = function (...args) {
      const ret = origReplace.apply(this, args);
      queueMicrotask(onNavigationMaybe);
      return ret;
    };

    addEventListener('popstate', () => queueMicrotask(onNavigationMaybe), true);
  }

  function hookManualOverride() {
    document.addEventListener('click', (e) => {
      if (state.scriptClickInProgress) return;

      const el = e.target instanceof Element ? e.target : null;
      if (!el) return;

      const opt = el.closest?.(SEL.qualityOption);
      if (!opt) return;

      // User choice: do nothing more until next navigation/reload.
      state.manualOverrideThisNav = true;
      state.appliedThisNav = true;
      cancelFallback();
    }, true);
  }

  /* ===== Init ===== */
  if (!isTopWindow() && !isLiveChannelPath(location.pathname)) return;

  hookHistory();
  hookManualOverride();

  queueMicrotask(() => {
    state.navToken += 1;
    schedule(applyForThisNavigation);
  });
})();
