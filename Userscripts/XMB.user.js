// ==UserScript==
// @name         Mute/Block X followers automatically
// @namespace    https://github.com/Xenfernal
// @version      1.4
// @description  Mute/Block users automatically found on follower pages/lists with an exclude feature.
// @author       Xen
// @match        https://x.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=x.com
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @homepageURL  https://github.com/Xenfernal/Personal-QoL-Stuff/tree/main/Userscripts
// @downloadURL  https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/XMB.user.js
// @updateURL    https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/XMB.user.js
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const DEBUG = false;

  const SELECTORS = {
    verifiedFollowersTimeline: '[aria-label="Timeline: Verified Followers"]',
    followersTimeline: '[aria-label="Timeline: Followers"]',
    followingTimeline: '[aria-label="Timeline: Following"]',
    followersYouKnowTimeline: '[aria-label="Timeline: Followers you know"]',

    userActions: '[data-testid="userActions"]',
    dropdown: '[data-testid="Dropdown"]',
    sheetDialog: '[data-testid="sheetDialog"]',
    confirmBlock: '[data-testid="confirmationSheetConfirm"]',

    viewport: '[data-viewportview="true"]',

    // Common X row substructure hints (best-effort; safe if absent)
    userCell: '[data-testid="UserCell"]',
    cellInnerDiv: '[data-testid="cellInnerDiv"]',
  };

  const WAIT = {
    intervalMs: 75,
    fastIntervalMs: 50,
    userActionsTimeoutMs: 15000,
    dropdownTimeoutMs: 15000,
    confirmTimeoutMs: 15000,
    returnTimeoutMs: 15000,
    scrollMaxMs: 15000,
    scrollStuckMs: 2000,
    mutationDebounceMs: 250,

    jitterMs: 20,
    actionPostClickDelayMs: 150,
    actionPostClickJitterMs: 80,
  };

  // Surgical mitigation knobs
  const RUN = {
    maxFailuresPerUser: 2,        // retry transient failures up to N times
    deferOnFailure: true,         // try other users before retrying a failing one
    retryNoActionOnce: true,      // NEW: retry action lookup once (open menu again) before terminal-skip
  };

  const STORAGE = {
    excludedUsersKey: 'excludedUsers',
  };

  const BAD_FIRST_SEGMENTS = new Set([
    'home', 'explore', 'notifications', 'messages', 'i', 'settings',
    'compose', 'search', 'login', 'logout', 'signup', 'intent'
  ]);

  let isRunning = false;
  let stopRequested = false;

  // Tracks success/terminal-skip per run (only set on success OR after giving up)
  let affectedAccountUrls = Object.create(null);

  // Tracks transient failures per user per run
  let failureCounts = Object.create(null);

  // Avoid repeatedly hammering the same failing row when others exist
  let deferredKeys = new Set();

  // Emergency stop
  window.__xMuteBlockStop = () => { stopRequested = true; };

  // ESC to stop while running
  window.addEventListener('keydown', (e) => {
    if (!isRunning) return;
    if (e.key === 'Escape') stopRequested = true;
  }, { capture: true });

  function log(...args) {
    if (!DEBUG) return;
    console.log('[Mute/Block X Followers]', ...args);
  }

  function randInt(min, max) {
    const a = Math.ceil(min);
    const b = Math.floor(max);
    return Math.floor(Math.random() * (b - a + 1)) + a;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function sleepJitter(ms, jitterMs = WAIT.jitterMs) {
    const j = Math.max(0, jitterMs | 0);
    const delta = j ? randInt(-j, j) : 0;
    return sleep(Math.max(0, ms + delta));
  }

  async function waitFor(getterFn, {
    timeoutMs = 10000,
    intervalMs = WAIT.intervalMs,
    label = 'waitFor',
  } = {}) {
    const start = performance.now();
    while (true) {
      if (stopRequested) return null;

      let value = null;
      try { value = getterFn(); } catch (_) { value = null; }

      if (value) return value;

      if (performance.now() - start >= timeoutMs) {
        log(`Timeout: ${label} (${timeoutMs}ms)`);
        return null;
      }
      await sleepJitter(intervalMs, WAIT.jitterMs);
    }
  }

  function waitForSelector(selector, opts = {}) {
    return waitFor(() => document.querySelector(selector), { ...opts, label: opts.label || `selector ${selector}` });
  }

  function waitForAnySelector(selectors, opts = {}) {
    return waitFor(() => {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return { el, selector: sel };
      }
      return null;
    }, { ...opts, label: opts.label || `anySelector ${selectors.join(' OR ')}` });
  }

  function safeClick(el) {
    if (!el) return false;
    try { el.click(); return true; } catch (e) { log('Click failed', e); return false; }
  }

  function isElementVisible(el) {
    if (!el) return false;
    try {
      if (!el.isConnected) return false;
      const rects = el.getClientRects();
      if (!rects || rects.length === 0) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  function getActiveFollowersTimelineEl() {
    const verified = document.querySelector(SELECTORS.verifiedFollowersTimeline);
    const followers = document.querySelector(SELECTORS.followersTimeline);

    if (isElementVisible(verified)) return verified;
    if (isElementVisible(followers)) return followers;

    return verified || followers || null;
  }

  function getFollowersSection() {
    return getActiveFollowersTimelineEl();
  }

  function getFollowingSection() {
    return document.querySelector(SELECTORS.followingTimeline) || document.querySelector(SELECTORS.followersYouKnowTimeline);
  }

  // -------------------------
  // Canonical keying (idempotent; never grows "@@")
  // -------------------------

  function canonicalKey(input) {
    if (typeof input !== 'string') return '';
    const s = input.trim();
    if (!s) return '';

    if (s.startsWith('@')) {
      const handle = s.replace(/^@+/, '').trim();
      if (!handle) return '';
      return '@' + handle.toLowerCase();
    }

    try {
      const url = new URL(s, location.origin);
      const parts = url.pathname.split('/').filter(Boolean);
      if (!parts.length) return '';

      let first = (parts[0] || '').trim();
      if (!first) return '';

      first = first.replace(/^@+/, '');
      if (!first) return '';

      const lower = first.toLowerCase();
      if (BAD_FIRST_SEGMENTS.has(lower)) return '';

      return '@' + lower;
    } catch (_) {
      return '';
    }
  }

  // -------------------------
  // Storage (no writes on load)
  // -------------------------

  function readExcludedStorage() {
    const stored = GM_getValue(STORAGE.excludedUsersKey, []);
    if (Array.isArray(stored)) return stored;

    if (typeof stored === 'string') {
      try {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) return parsed;
      } catch (_) {}
    }
    return [];
  }

  function loadExcludedUsers() {
    const raw = readExcludedStorage();
    const set = new Set();
    for (const item of raw) {
      if (typeof item !== 'string' || !item) continue;
      const key = canonicalKey(item);
      if (key) set.add(key);
    }
    return set;
  }

  const excludedUsers = loadExcludedUsers();

  function persistExcludedUsers() {
    const arr = [...excludedUsers].filter(Boolean).sort();
    try {
      GM_setValue(STORAGE.excludedUsersKey, arr);
    } catch (e) {
      log('Persist as array failed, falling back to JSON string', e);
      try { GM_setValue(STORAGE.excludedUsersKey, JSON.stringify(arr)); }
      catch (e2) { log('Persist failed', e2); }
    }
  }

  function isExcludedKey(keyOrHref) {
    const key = canonicalKey(keyOrHref);
    return Boolean(key && excludedUsers.has(key));
  }

  function addExcludeKey(keyOrHref) {
    const key = canonicalKey(keyOrHref);
    if (!key) return;
    excludedUsers.add(key);
    persistExcludedUsers();
  }

  function removeExcludeKey(keyOrHref) {
    const key = canonicalKey(keyOrHref);
    if (!key) return;
    excludedUsers.delete(key);
    persistExcludedUsers();
  }

  // -------------------------
  // Row parsing (IMPROVEMENT 1)
  // -------------------------

  function looksLikeProfileHref(href) {
    if (!href) return false;
    try {
      const u = new URL(href, location.origin);
      if (u.origin !== 'https://x.com') return false;
      if (u.pathname.includes('/status/')) return false;
      return Boolean(canonicalKey(u.href));
    } catch (_) {
      return false;
    }
  }

  function extractPrimaryHandleFromRow(row) {
    // Prefer the visible handle line inside the user cell to avoid bio mentions
    const userCell = row.querySelector(SELECTORS.userCell) || row;

    const candidates = Array.from(userCell.querySelectorAll('span, div, a'))
      .map(el => (el.textContent || '').trim())
      .filter(t => t.startsWith('@') && t.length > 1 && !/\s/.test(t))
      .slice(0, 8);

    for (const t of candidates) {
      const k = canonicalKey(t);
      if (k) return k;
    }
    return '';
  }

  function findProfileLinkInRow(row) {
    if (!row) return null;

    const expectedKey = extractPrimaryHandleFromRow(row);

    const userCell = row.querySelector(SELECTORS.userCell);

    const collectAnchors = (root) => Array.from(root.querySelectorAll('a[href]'))
      .filter(a => a instanceof HTMLAnchorElement)
      .filter(a => looksLikeProfileHref(a.href));

    // Prefer anchors inside the UserCell region first (reduces wrong-clicking bio mentions)
    const preferredAnchors = userCell ? collectAnchors(userCell) : [];
    const allAnchors = collectAnchors(row);

    const chooseByKey = (anchors) => {
      if (!expectedKey) return null;
      for (const a of anchors) {
        const k = canonicalKey(a.href);
        if (k && k === expectedKey) return a;
      }
      return null;
    };

    let a = chooseByKey(preferredAnchors) || chooseByKey(allAnchors) || null;
    if (!a && preferredAnchors.length) a = preferredAnchors[0];
    if (!a && allAnchors.length) a = allAnchors[0];

    if (a && a.href) {
      const key = canonicalKey(a.href) || a.href;
      return { link: a, href: a.href, key };
    }

    // Legacy fallback (guarded)
    try {
      const element = row;
      const accountLink =
        element?.firstChild?.firstChild?.firstChild?.firstChild?.children?.[1]
          ?.firstChild?.firstChild?.firstChild?.firstChild?.firstChild;

      if (accountLink && accountLink.href) {
        const key = canonicalKey(accountLink.href) || accountLink.href;
        return { link: accountLink, href: accountLink.href, key };
      }
    } catch (_) {}

    return null;
  }

  function getFollowerRowElements() {
    const timeline = getActiveFollowersTimelineEl();
    if (!timeline) return [];

    // Primary path (original structure)
    let rows = Array.from(timeline.querySelectorAll(':scope > div > div'));

    // Fallback path: if X changes the row wrapper structure, derive rows from UserCell nodes
    if (!rows.length) {
      const userCells = Array.from(timeline.querySelectorAll(SELECTORS.userCell));
      const uniq = new Set();
      const out = [];
      for (const uc of userCells) {
        const row =
          uc.closest('div[role="listitem"]') ||
          uc.closest(SELECTORS.cellInnerDiv) ||
          uc.closest('div');
        if (row && !uniq.has(row)) { uniq.add(row); out.push(row); }
      }
      rows = out;
    }

    return rows;
  }

  function rowHasBlockedPill(row) {
    if (!row) return false;
    const byTestId = row.querySelector('[data-testid*="blocked" i]');
    if (byTestId) return true;

    const clickables = Array.from(row.querySelectorAll('button, div[role="button"], a[role="button"]'));
    return clickables.some(el => (el.textContent || '').trim() === 'Blocked');
  }

  function getNextPerson({ skipKeys } = {}) {
    const rows = getFollowerRowElements();

    for (const row of rows) {
      if (rowHasBlockedPill(row)) continue;

      const found = findProfileLinkInRow(row);
      if (!found || !found.href || !found.key) continue;

      if (skipKeys && skipKeys.has(found.key)) continue;

      if (affectedAccountUrls[found.key]) continue;
      if (isExcludedKey(found.key)) continue;

      return { ...found, row };
    }
    return null;
  }

  // -------------------------
  // Menu action finding
  // -------------------------

  function findActionButton(dropdownRoot, actionType) {
    if (!dropdownRoot) return null;
    const want = String(actionType || '').trim().toLowerCase();
    if (!want) return null;

    if (want === 'block' || want === 'mute') {
      const byTestId = dropdownRoot.querySelector(`[data-testid="${want}"]`);
      if (byTestId) return byTestId;
    }

    const candidates = Array.from(
      dropdownRoot.querySelectorAll('[role="menuitem"], button, a, div[role="button"]')
    );

    for (const el of candidates) {
      const txt = (el.textContent || '').trim().toLowerCase();
      if (!txt) continue;
      if (txt === want || txt.startsWith(want + ' @')) return el;
    }

    const children = Array.from(dropdownRoot.children || []);
    for (const child of children) {
      const txt = (child.textContent || '').trim().toLowerCase();
      if (!txt) continue;
      if (txt === want || txt.startsWith(want + ' @')) return child;
    }

    return null;
  }

  // -------------------------
  // Navigation back
  // -------------------------

  function tryNavigateBack() {
    const backCandidates = [
      '[data-testid="app-bar-back"]',
      'a[aria-label="Back"]',
      'button[aria-label="Back"]',
      '[role="button"][aria-label="Back"]'
    ];

    for (const sel of backCandidates) {
      const el = document.querySelector(sel);
      if (el && safeClick(el)) return true;
    }

    try { history.back(); return true; } catch (_) { return false; }
  }

  function pickUserActionsOverflowButton(userActions) {
    const preferred = userActions.querySelector(
      'button[aria-label="More"], button[aria-label*="More"], ' +
      '[role="button"][aria-label="More"], [role="button"][aria-label*="More"], ' +
      '[data-testid*="overflow" i], [data-testid*="Overflow" i]'
    );
    if (preferred) return preferred;

    const hasPopup = userActions.querySelector('button[aria-haspopup="menu"], [role="button"][aria-haspopup="menu"]');
    if (hasPopup) return hasPopup;

    const clickables = Array.from(userActions.querySelectorAll('button, div[role="button"], [tabindex="0"]'));
    if (clickables.length) return clickables[clickables.length - 1];

    return userActions.lastElementChild || userActions.firstElementChild;
  }

  async function returnToTimelineWithRetry() {
    const timelines = [SELECTORS.verifiedFollowersTimeline, SELECTORS.followersTimeline];

    const attempt = async (label) => {
      const info = await waitForAnySelector(timelines, {
        timeoutMs: WAIT.returnTimeoutMs,
        intervalMs: WAIT.intervalMs,
        label,
      });
      return Boolean(info && info.el);
    };

    if (await attempt('return-to-timeline')) return true;

    if (stopRequested) return false;
    tryNavigateBack();
    return attempt('return-to-timeline (retry)');
  }

  // -------------------------
  // Scroll selection (IMPROVEMENT 3)
  // -------------------------

  function isScrollable(el) {
    if (!el) return false;
    try {
      const ch = el.clientHeight || 0;
      const sh = el.scrollHeight || 0;
      if (sh <= ch + 20) return false;
      const cs = getComputedStyle(el);
      const oy = (cs.overflowY || cs.overflow || '').toLowerCase();
      return oy.includes('auto') || oy.includes('scroll') || oy.includes('overlay') || oy === '';
    } catch (_) {
      return false;
    }
  }

  function getBestScrollElement() {
    const timeline = getActiveFollowersTimelineEl();

    // Best: nearest scrollable ancestor of the active timeline
    if (timeline) {
      let cur = timeline.parentElement;
      for (let i = 0; i < 14 && cur; i++) {
        if (isScrollable(cur)) return cur;
        cur = cur.parentElement;
      }
    }

    // Next: X viewport container
    const vp = document.querySelector(SELECTORS.viewport);
    if (vp && isScrollable(vp)) return vp;

    // Fallback: document scroller
    return document.scrollingElement || document.documentElement || document.body;
  }

  // -------------------------
  // Core action runner
  // -------------------------

  /**
   * Returns: { ok: boolean, retryable: boolean }
   */
  async function performActionOnPerson(person, actionType) {
    if (!person || !person.link || !person.href || !person.key) return { ok: false, retryable: false };
    if (stopRequested) return { ok: false, retryable: true };

    try { person.row?.scrollIntoView?.({ block: 'center', inline: 'nearest' }); } catch (_) {}

    safeClick(person.link);

    const userActions = await waitForSelector(SELECTORS.userActions, {
      timeoutMs: WAIT.userActionsTimeoutMs,
      intervalMs: WAIT.fastIntervalMs,
      label: 'userActions',
    });

    if (!userActions) {
      tryNavigateBack();
      await returnToTimelineWithRetry();
      return { ok: false, retryable: true };
    }

    const openMenuBtn = pickUserActionsOverflowButton(userActions);
    if (!safeClick(openMenuBtn)) {
      tryNavigateBack();
      await returnToTimelineWithRetry();
      return { ok: false, retryable: true };
    }

    const getDropdownRoot = async (label) => {
      const dropdownInfo = await waitForAnySelector([SELECTORS.dropdown, SELECTORS.sheetDialog], {
        timeoutMs: WAIT.dropdownTimeoutMs,
        intervalMs: WAIT.fastIntervalMs,
        label,
      });
      return dropdownInfo?.el || null;
    };

    let dropdownRoot = await getDropdownRoot('dropdown/sheetDialog');
    if (!dropdownRoot) {
      tryNavigateBack();
      await returnToTimelineWithRetry();
      return { ok: false, retryable: true };
    }

    let button = findActionButton(dropdownRoot, actionType);

    // IMPROVEMENT 2: if action not found, retry once (re-open overflow menu) before treating as terminal
    if (!button && RUN.retryNoActionOnce) {
      try { document.body.click(); } catch (_) {}
      await sleepJitter(60, 40);

      if (!safeClick(openMenuBtn)) {
        tryNavigateBack();
        await returnToTimelineWithRetry();
        return { ok: false, retryable: true };
      }

      dropdownRoot = await getDropdownRoot('dropdown/sheetDialog (retry)');
      if (dropdownRoot) button = findActionButton(dropdownRoot, actionType);
    }

    if (!button) {
      // Non-actionable (already muted/blocked -> menu shows Unmute/Unblock, protected, UI variant, etc.)
      tryNavigateBack();
      await returnToTimelineWithRetry();
      return { ok: false, retryable: false };
    }

    safeClick(button);

    if (actionType === 'Block') {
      const confirm = await waitForSelector(SELECTORS.confirmBlock, {
        timeoutMs: WAIT.confirmTimeoutMs,
        intervalMs: WAIT.fastIntervalMs,
        label: 'block-confirm',
      });
      if (confirm) safeClick(confirm);
    }

    await sleepJitter(WAIT.actionPostClickDelayMs, WAIT.actionPostClickJitterMs);

    tryNavigateBack();
    const backOk = await returnToTimelineWithRetry();

    return { ok: Boolean(backOk), retryable: Boolean(backOk) };
  }

  async function scrollToNewPeople({ skipKeys } = {}) {
    const element = getBestScrollElement();

    let prevScrollTop = element.scrollTop;
    let lastMovedAt = performance.now();
    const start = performance.now();

    while (!getNextPerson({ skipKeys })) {
      if (stopRequested) return;
      if (performance.now() - start >= WAIT.scrollMaxMs) return;

      try {
        if (typeof element.scrollBy === 'function') element.scrollBy(0, 250);
        else element.scrollTop += 250;
      } catch (_) {
        try { element.scrollTop += 250; } catch (_) {}
      }

      try { element.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (_) {}

      if (prevScrollTop === element.scrollTop) {
        if (performance.now() - lastMovedAt >= WAIT.scrollStuckMs) return;
      } else {
        lastMovedAt = performance.now();
      }

      prevScrollTop = element.scrollTop;
      await sleepJitter(WAIT.intervalMs, WAIT.jitterMs);
    }
  }

  async function performActionOnPeople(actionType) {
    let count = 0;

    affectedAccountUrls = Object.create(null);
    failureCounts = Object.create(null);
    deferredKeys = new Set();

    while (true) {
      if (stopRequested) {
        alert(`Stopped. ${count} people ${actionType === 'Mute' ? 'muted' : 'blocked'}.`);
        return;
      }

      await scrollToNewPeople({ skipKeys: deferredKeys });

      if (stopRequested) {
        alert(`Stopped. ${count} people ${actionType === 'Mute' ? 'muted' : 'blocked'}.`);
        return;
      }

      let nextPerson = getNextPerson({ skipKeys: deferredKeys });

      if (!nextPerson && deferredKeys.size > 0) {
        deferredKeys.clear();
        nextPerson = getNextPerson({ skipKeys: deferredKeys });
      }

      if (!nextPerson) {
        alert(`${count} people ${actionType === 'Mute' ? 'muted' : 'blocked'}.`);
        return;
      }

      const key = nextPerson.key;
      const result = await performActionOnPerson(nextPerson, actionType);

      if (result.ok) {
        affectedAccountUrls[key] = true;
        count++;
        deferredKeys.delete(key);
        failureCounts[key] = 0;
        continue;
      }

      failureCounts[key] = (failureCounts[key] || 0) + 1;

      const exceeded = failureCounts[key] >= RUN.maxFailuresPerUser;
      const terminal = !result.retryable;

      if (terminal || exceeded) {
        affectedAccountUrls[key] = true;
        deferredKeys.delete(key);
      } else if (RUN.deferOnFailure) {
        deferredKeys.add(key);
      }
    }
  }

  // -------------------------
  // UI injection
  // -------------------------

  let stylesAdded = false;

  function ensureStyles() {
    if (stylesAdded) return;
    stylesAdded = true;

    GM_addStyle(`
      #mute-block-container {
        position: relative;
        border-radius: 12px;
        box-shadow: 0px 4px 10px rgba(0, 0, 0, 0.3);
        display: flex;
        flex-direction: row;
        justify-content: center;
        gap: 12px;
        z-index: 9999;
        width: auto;
        min-width: 300px;
        padding: 0;
        margin: 0;
      }

      #mute-all-button, #block-all-button {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        font-size: 16px;
        font-weight: bold;
        color: #ffffff;
        border: 2px solid #ffffff;
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.3s ease-in-out;
        width: 48.5%;
        text-align: center;
        padding: 8px 12px;
      }

      #mute-all-button::before { content: "🔇"; font-size: 18px; }
      #mute-all-button { background: #2c2c2c; }
      #mute-all-button:hover { background: #444; }
      #mute-all-button:active { background: #1a1a1a; }

      #block-all-button::before { content: "🚫"; font-size: 18px; }
      #block-all-button { background: #ff4c4c; }
      #block-all-button:hover { background: #d93b3b; }
      #block-all-button:active { background: #b82e2e; }

      .xen-follow-row {
        display: inline-flex;
        flex-direction: row;
        align-items: center;
        justify-content: flex-end;
        gap: 12px;
        flex-wrap: nowrap;
      }

      .exclude-button-wrapper {
        display: inline-flex;
        align-items: center;
        flex: 0 0 auto;
        margin: 0;
        padding: 0;
      }

      .exclude-button {
        font-size: 14px;
        font-weight: bold;
        color: #ffffff;
        border: none;
        border-radius: 9999px;
        cursor: pointer;
        padding: 8px 14px;
        white-space: nowrap;
        transition: background-color 0.3s ease, transform 0.2s ease;
      }

      .exclude-button.include { background-color: #2c2c2c; }
      .exclude-button.include:hover { background-color: #444; }
      .exclude-button.include:active { background-color: #1a1a1a; }

      .exclude-button.exclude { background-color: #ff4c4c; }
      .exclude-button.exclude:hover { background-color: #d93b3b; }
      .exclude-button.exclude:active { background-color: #b82e2e; }

      #mute-block-container button[disabled] {
        opacity: 0.6;
        cursor: not-allowed;
      }
    `);
  }

  function addMuteBlockContainer() {
    if (document.getElementById('mute-block-container')) return;

    const followersSection = getFollowersSection();
    if (!followersSection) return;

    ensureStyles();

    const muteBlockContainer = document.createElement('div');
    muteBlockContainer.id = 'mute-block-container';

    const muteButton = document.createElement('button');
    muteButton.id = 'mute-all-button';
    muteButton.textContent = 'Mute All';

    const blockButton = document.createElement('button');
    blockButton.id = 'block-all-button';
    blockButton.textContent = 'Block All';

    muteBlockContainer.appendChild(muteButton);
    muteBlockContainer.appendChild(blockButton);

    followersSection.insertBefore(muteBlockContainer, followersSection.firstChild);

    const setButtonsEnabled = (enabled) => {
      muteButton.disabled = !enabled;
      blockButton.disabled = !enabled;
    };

    muteButton.addEventListener('click', async () => {
      if (isRunning) return;
      if (window.confirm('Mute all users on this page?')) {
        isRunning = true;
        stopRequested = false;
        setButtonsEnabled(false);
        try { await performActionOnPeople('Mute'); }
        finally { isRunning = false; setButtonsEnabled(true); }
      }
    });

    blockButton.addEventListener('click', async () => {
      if (isRunning) return;
      if (window.confirm('Block all users on this page?')) {
        isRunning = true;
        stopRequested = false;
        setButtonsEnabled(false);
        try { await performActionOnPeople('Block'); }
        finally { isRunning = false; setButtonsEnabled(true); }
      }
    });
  }

  // Find Follow/Following button inside the row
  function findFollowButton(row) {
    const btns = Array.from(row.querySelectorAll('button, div[role="button"]'));
    for (const b of btns) {
      const t = (b.textContent || '').trim();
      if (t === 'Follow' || t === 'Following' || t === 'Unfollow' || t === 'Requested' || t === 'Follow back') return b;
    }
    const dt = row.querySelector('button[data-testid*="follow" i], div[role="button"][data-testid*="follow" i]');
    return dt || null;
  }

  function findFollowPlacement(row) {
    const followBtn = findFollowButton(row);
    if (!followBtn) return null;

    let followNode = followBtn;
    let container = followNode.parentElement;

    for (let i = 0; i < 8 && container && container !== row; i++) {
      if (container.childElementCount > 1) break;
      followNode = container;
      container = followNode.parentElement;
    }

    if (!container || container === row) {
      container = followBtn.parentElement;
      followNode = followBtn;
    }

    while (followNode.parentElement && followNode.parentElement !== container && followNode.parentElement !== row) {
      followNode = followNode.parentElement;
    }

    if (!container || !container.contains(followBtn)) return null;
    return { container, followNode };
  }

  function syncExcludeButtonAppearance(btn, accountKey) {
    const excluded = isExcludedKey(accountKey);
    btn.textContent = excluded ? 'Exclude' : 'Include';
    btn.classList.toggle('exclude', excluded);
    btn.classList.toggle('include', !excluded);
  }

  function buildExcludeControl(accountKey) {
    const buttonWrapper = document.createElement('span');
    buttonWrapper.className = 'exclude-button-wrapper';
    buttonWrapper.dataset.xenAccountKey = accountKey || '';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'exclude-button';
    syncExcludeButtonAppearance(button, accountKey);

    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();

      if (isExcludedKey(accountKey)) removeExcludeKey(accountKey);
      else addExcludeKey(accountKey);

      syncExcludeButtonAppearance(button, accountKey);
    }, { capture: true });

    buttonWrapper.appendChild(button);
    return buttonWrapper;
  }

  function addExcludeButtons() {
    const rows = getFollowerRowElements();

    for (const row of rows) {
      const found = findProfileLinkInRow(row);
      if (!found || !found.href) continue;

      const accountKey = canonicalKey(found.href);
      if (!accountKey) continue;

      const existingWrap = row.querySelector('.xen-follow-row');
      if (existingWrap) {
        if ((existingWrap.dataset.xenAccountKey || '') === accountKey) {
          const btn = existingWrap.querySelector('.exclude-button');
          if (btn) syncExcludeButtonAppearance(btn, accountKey);
          continue;
        } else {
          const parent = existingWrap.parentElement;
          const followNode = existingWrap.lastElementChild;
          if (parent && followNode) parent.insertBefore(followNode, existingWrap);
          existingWrap.remove();
        }
      }

      const placement = findFollowPlacement(row);
      if (!placement) continue;

      const { container, followNode } = placement;

      const wrap = document.createElement('span');
      wrap.className = 'xen-follow-row';
      wrap.dataset.xenAccountKey = accountKey;

      const includeControl = buildExcludeControl(accountKey);

      try {
        container.insertBefore(wrap, followNode);
        wrap.appendChild(includeControl);
        wrap.appendChild(followNode);
      } catch (e) {
        log('Failed to wrap Follow control', e);
      }
    }
  }

  function removeMuteBlockContainer() {
    const muteBlockContainer = document.getElementById('mute-block-container');
    if (muteBlockContainer) muteBlockContainer.remove();
  }

  // -------------------------
  // MutationObserver (debounced)
  // -------------------------

  let observerScheduled = false;

  function onDomChange() {
    const followersSection = getFollowersSection();
    const followingSection = getFollowingSection();

    if (followersSection && !followingSection) {
      addMuteBlockContainer();
      addExcludeButtons();
    } else {
      removeMuteBlockContainer();
    }
  }

  const observer = new MutationObserver(() => {
    if (observerScheduled) return;
    observerScheduled = true;
    setTimeout(() => {
      observerScheduled = false;
      onDomChange();
    }, WAIT.mutationDebounceMs);
  });

  observer.observe(document.body, { childList: true, subtree: true });

  onDomChange();
})();
