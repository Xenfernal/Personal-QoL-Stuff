// ==UserScript==
// @name        Hide Read Posts & Watched YouTube Videos
// @namespace   https://github.com/Xenfernal
// @version     1.0.0
// @icon        https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @description Hide watched videos marked by "Mark Watched YouTube Videos" userscript by jcunews. Toggle with Alt+H or via Userscript manager menu.
// @author      Xen
// @match       https://www.youtube.com/*
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_registerMenuCommand
// @homepageURL https://github.com/Xenfernal/Personal-QoL-Stuff/tree/main/Userscripts
// @downloadURL https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/HWYTV.user.js
// @updateURL   https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/HWYTV.user.js
// @license     MIT
// @run-at      document-start
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------
  // Configuration
  // ---------------------------
  const CONFIG = {
    storageKey: 'HideWatchedVideos_Enabled',
    hideClass: 'mwyv-hide-watched',
    emptySectionClass: 'mwyv-section-empty',

    // Batching delays (ms)
    mutationBatchDelay: 120,
    navRescanDelay: 450,

    mutationObserverConfig: {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
      attributeOldValue: true
    },

    // Marker selectors MUST match MWYTV.
    markerSelectorList: ['.watched', '.readpost'],

    // Containers where MWYTV may apply markers (broader)
    // Note: some of these are inner nodes; they are kept here for marker discovery, but are NOT necessarily the best hide targets.
    containerSelectorList: [
      // Videos + Shorts
      'ytd-rich-item-renderer',
      'ytd-rich-grid-media',
      'ytd-rich-grid-slim-media',
      'ytd-video-renderer',
      'ytd-compact-video-renderer',
      'ytd-compact-radio-renderer',
      'ytd-playlist-video-renderer',
      'ytd-playlist-panel-video-renderer',
      'ytd-grid-video-renderer',
      'ytd-reel-item-renderer',
      'yt-lockup-view-model',
      '.yt-lockup-view-model',
      '.yt-lockup-view-model-wiz',
      '.yt-shelf-grid-item',
      '.video-list-item',
      '.pl-video',

      // Posts
      'ytd-backstage-post-thread-renderer',
      'ytd-backstage-post-renderer',
      'ytd-post-renderer',
      'ytd-shared-post-renderer'
    ],

    // Hide targets (layout items). These are the elements we actually hide to avoid leaving "holes".
    // Intentionally excludes inner media nodes like ytd-rich-grid-media which can leave empty wrappers behind.
    hideTargetSelectorList: [
      // Videos + Shorts (outer layout items)
      'ytd-rich-item-renderer',
      'ytd-video-renderer',
      'ytd-compact-video-renderer',
      'ytd-compact-radio-renderer',
      'ytd-playlist-video-renderer',
      'ytd-playlist-panel-video-renderer',
      'ytd-grid-video-renderer',
      'ytd-reel-item-renderer',
      'yt-lockup-view-model',
      '.yt-lockup-view-model',
      '.yt-lockup-view-model-wiz',
      '.yt-shelf-grid-item',
      '.video-list-item',
      '.pl-video',

      // Posts (already layout items)
      'ytd-backstage-post-thread-renderer',
      'ytd-backstage-post-renderer',
      'ytd-post-renderer',
      'ytd-shared-post-renderer'
    ],

    // Sections we may want to collapse when they end up empty
    sectionSelectorList: [
      'ytd-item-section-renderer',
      '.ytd-section-list-renderer',
      '.shelf-content',
      'ytd-reel-shelf-renderer'
    ],

    // If a section still contains a continuation/spinner, do NOT collapse it.
    continuationSelector: 'ytd-continuation-item-renderer, ytd-spinner, tp-yt-paper-spinner-lite, [aria-busy="true"]',

    // Badge retry control (prevents tight infinite retry loops on unusual layouts)
    badgeRetryDelay: 500,
    badgeMaxRetries: 10
  };

  // ---------------------------
  // Helpers: safe selector building (prevents early crashes)
  // ---------------------------
  const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);

  const CONTAINER_SELECTOR = list(CONFIG.containerSelectorList).join(',');
  const HIDE_TARGET_SELECTOR = (list(CONFIG.hideTargetSelectorList).length ? list(CONFIG.hideTargetSelectorList) : list(CONFIG.containerSelectorList)).join(',');
  const SECTION_SELECTOR = list(CONFIG.sectionSelectorList).join(',');
  const MARKER_SELECTOR = (list(CONFIG.markerSelectorList).length ? list(CONFIG.markerSelectorList) : ['.watched', '.readpost']).join(',');

  // ---------------------------
  // State
  // ---------------------------
  let isEnabled = true;
  let observer = null;
  let mastheadObserver = null;

  // Batching state
  const tileQueue = new Set();
  const sectionQueue = new Set();
  let flushTimer = 0;
  let fullRescanTimer = 0;

  // Badge retry state
  let badgeRetries = 0;
  let badgeRetryTimer = 0;

  // CSS
  const hideStyles = `
    /* Hide anything we mark explicitly */
    .${CONFIG.hideClass} { display: none !important; }

    /* Collapse sections we detected as empty (class-based to avoid inline style writes) */
    .${CONFIG.emptySectionClass} { display: none !important; }

    /* Visual indicator when hiding is active - placed in masthead */
    .mwyv-hiding-active-indicator {
      display: inline-flex; align-items: center; background: #ff4444; color: #fff;
      padding: 4px 8px; border-radius: 12px; font-size: 11px; font-weight: 500;
      margin: 0 8px; white-space: nowrap; height: 24px;
    }

    /* Hide indicator in fullscreen (masthead usually hidden anyway) */
    .html5-video-player:fullscreen ~ .mwyv-hiding-active-indicator,
    .html5-video-player:-webkit-full-screen ~ .mwyv-hiding-active-indicator,
    .html5-video-player:-moz-full-screen ~ .mwyv-hiding-active-indicator { display: none !important; }
  `;

  // ---------------------------
  // Boot guard (fixes missed DOMContentLoaded / early failures)
  // ---------------------------
  let _inited = false;
  function initOnce() {
    if (_inited) return;
    _inited = true;
    try {
      init();
    } catch (e) {
      console.error('[HWYTV] init failed:', e);
      // Allow a second attempt after a short delay in case YouTube injected late globals.
      setTimeout(() => {
        try {
          // Re-try only if still enabled and we haven't successfully started observers.
          if (!observer && GM_getValue(CONFIG.storageKey, true)) {
            console.warn('[HWYTV] retrying init...');
            init();
          }
        } catch (e2) {
          console.error('[HWYTV] init retry failed:', e2);
        }
      }, 800);
    }
  }

  // ---------------------------
  // Init
  // ---------------------------
  function init() {
    isEnabled = GM_getValue(CONFIG.storageKey, true);

    injectStyles();
    setupKeyboardShortcut();
    registerMenuCommands();

    // Clean any legacy inline display:none from prior versions (guarded)
    resetLegacyInlineDisplay();

    // Observers & UI
    setupMastheadObserver();
    updateVisibilityState();

    if (isEnabled) {
      startObservers();
      fullRescan();
    }

    setupNavigationHandler();

    console.log('[HWYTV] initialised. enabled =', isEnabled);
  }

  function injectStyles() {
    if (document.getElementById('mwyv-hide-styles')) return;
    const styleEl = document.createElement('style');
    styleEl.id = 'mwyv-hide-styles';
    styleEl.textContent = hideStyles;
    (document.head || document.documentElement).appendChild(styleEl);
  }

  // ---------------------------
  // Observers
  // ---------------------------
  function getObserveRoot() {
    return document.querySelector('ytd-app') || document.querySelector('#page-manager') || document.body;
  }

  function startObservers() {
    stopObservers();

    const root = getObserveRoot();
    if (!root) {
      // DOM not ready yet; retry shortly.
      setTimeout(startObservers, 250);
      return;
    }

    observer = new MutationObserver(onMutations);
    observer.observe(root, CONFIG.mutationObserverConfig);
  }

  function stopObservers() {
    if (observer) {
      try { observer.disconnect(); } catch (_) {}
      observer = null;
    }
    clearTimeout(flushTimer);
    flushTimer = 0;
    tileQueue.clear();
    sectionQueue.clear();
  }

  function setupMastheadObserver() {
    if (mastheadObserver) mastheadObserver.disconnect();
    const masthead = document.querySelector('#masthead');
    if (!masthead) return; // will be retried on navigation

    mastheadObserver = new MutationObserver(() => {
      if (isEnabled && !document.querySelector('.mwyv-hiding-active-indicator')) {
        updateVisibilityState();
      }
    });
    mastheadObserver.observe(masthead, { childList: true, subtree: true });
  }

  // ---------------------------
  // Incremental processing
  // ---------------------------
  function classStringHasToken(cls, token) {
    // Robust token check without regex
    return (` ${cls || ''} `).indexOf(` ${token} `) !== -1;
  }

  function resolveTileFromAny(el) {
    if (!(el instanceof Element)) return null;

    // Prefer hiding the outer layout item so we don't leave empty wrappers/holes behind.
    if (el.matches && el.matches(HIDE_TARGET_SELECTOR)) return el;
    const outer = el.closest ? el.closest(HIDE_TARGET_SELECTOR) : null;
    if (outer) return outer;

    // Fallback: if the marker is on an element which is itself a (known) container.
    if (el.matches && el.matches(CONTAINER_SELECTOR)) return el;
    const c = el.closest ? el.closest(CONTAINER_SELECTOR) : null;
    return c || null;
  }

  function isTileMarked(tile) {
    if (!(tile instanceof Element)) return false;

    // MWYTV marks the container itself.
    if (tile.classList.contains('watched') || tile.classList.contains('readpost')) return true;

    // Defensive: in case a future MWYTV version marks a descendant
    return !!tile.querySelector(MARKER_SELECTOR);
  }

  function queueTileUpdate(el) {
    const tile = resolveTileFromAny(el);
    if (!tile) return;
    tileQueue.add(tile);

    const sec = tile.closest(SECTION_SELECTOR);
    if (sec) sectionQueue.add(sec);
  }

  function queueSectionUpdateFrom(el) {
    if (!(el instanceof Element)) return;
    const sec = el.closest(SECTION_SELECTOR);
    if (sec) sectionQueue.add(sec);
  }

  function scheduleFlush(delay) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushQueues, delay == null ? CONFIG.mutationBatchDelay : delay);
  }

  function flushQueues() {
    flushTimer = 0;
    if (!isEnabled) {
      tileQueue.clear();
      sectionQueue.clear();
      return;
    }

    // 1) Apply hide/unhide to queued tiles
    tileQueue.forEach((tile) => {
      if (!(tile instanceof Element)) return;
      const marked = isTileMarked(tile);
      tile.classList.toggle(CONFIG.hideClass, marked);
    });
    tileQueue.clear();

    // 2) Update emptiness for affected sections only
    sectionQueue.forEach((sec) => updateSectionEmptyState(sec));
    sectionQueue.clear();
  }

  function scanForMarkers(root) {
    if (!(root instanceof Element)) return;

    // If the added node itself is marked, update it.
    if (root.matches && root.matches(MARKER_SELECTOR)) queueTileUpdate(root);

    // Scan descendants for marked containers
    if (root.querySelectorAll) {
      const marked = root.querySelectorAll(MARKER_SELECTOR);
      for (let i = 0; i < marked.length; i++) queueTileUpdate(marked[i]);
    }

    // Also update closest section of the insertion point so we can un-collapse
    queueSectionUpdateFrom(root);
  }

  function onMutations(mutations) {
    if (!isEnabled) return;

    let queued = false;

    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];

      if (m.type === 'attributes' && m.attributeName === 'class') {
        const t = m.target;
        if (!(t instanceof Element)) continue;

        // Only react when the marker state changes.
        const oldCls = m.oldValue || '';
        const oldHadMarker = classStringHasToken(oldCls, 'watched') || classStringHasToken(oldCls, 'readpost');
        const newHadMarker = t.classList.contains('watched') || t.classList.contains('readpost');

        if (oldHadMarker !== newHadMarker) {
          queueTileUpdate(t);
          queued = true;
        }

        continue;
      }

      if (m.type === 'childList') {
        // Update section state for this area (important for un-collapsing when new content appears)
        if (m.target instanceof Element) {
          queueSectionUpdateFrom(m.target);
          queued = true;
        }

        const added = m.addedNodes;
        if (added && added.length) {
          for (let j = 0; j < added.length; j++) {
            const n = added[j];
            if (n && n.nodeType === 1) {
              scanForMarkers(n);
              queued = true;
            }
          }
        }
      }
    }

    if (queued) scheduleFlush();
  }

  // ---------------------------
  // Empty-section logic (behaviour-improving)
  // ---------------------------
  function updateSectionEmptyState(sec) {
    if (!(sec instanceof Element)) return;

    // If YouTube is still loading more content here, do NOT collapse the section.
    if (sec.querySelector(CONFIG.continuationSelector)) {
      sec.classList.remove(CONFIG.emptySectionClass);
      return;
    }

    // Consider a section non-empty if it contains any visible (not hidden) layout item.
    const visibleTile = sec.querySelector(`${HIDE_TARGET_SELECTOR}:not(.${CONFIG.hideClass})`);
    sec.classList.toggle(CONFIG.emptySectionClass, !visibleTile);
  }

  // ---------------------------
  // Full scan (navigation / enable)
  // ---------------------------
  function fullRescan() {
    if (!isEnabled) return;

    // Clear any stale hide marks first (YouTube can reuse DOM across SPA nav)
    document.querySelectorAll(`.${CONFIG.hideClass}`).forEach((el) => el.classList.remove(CONFIG.hideClass));

    // Apply hiding to all currently marked containers
    const marked = document.querySelectorAll(MARKER_SELECTOR);
    for (let i = 0; i < marked.length; i++) {
      queueTileUpdate(marked[i]);
    }

    // Refresh all sections once (post-nav correctness)
    document.querySelectorAll(SECTION_SELECTOR).forEach((sec) => sectionQueue.add(sec));

    // Flush immediately
    flushQueues();
  }

  function scheduleFullRescan(delay) {
    // Hardening/perf: if disabled, avoid scheduling any work at all.
    if (!isEnabled) return;

    clearTimeout(fullRescanTimer);
    fullRescanTimer = setTimeout(() => {
      if (!isEnabled) return;
      setupMastheadObserver();
      updateVisibilityState();
      fullRescan();
    }, delay == null ? CONFIG.navRescanDelay : delay);
  }

  // ---------------------------
  // Toggle & UI
  // ---------------------------
  function toggleHiding() {
    isEnabled = !isEnabled;
    GM_setValue(CONFIG.storageKey, isEnabled);

    updateVisibilityState();

    if (isEnabled) {
      startObservers();
      scheduleFullRescan(0);
    } else {
      stopObservers();

      // Hardening/perf: fully stop all scheduled work & masthead observation when disabled.
      if (mastheadObserver) {
        try { mastheadObserver.disconnect(); } catch (_) {}
        mastheadObserver = null;
      }
      clearTimeout(fullRescanTimer);
      fullRescanTimer = 0;
      clearTimeout(badgeRetryTimer);
      badgeRetryTimer = 0;
      badgeRetries = 0;

      // Remove our hide class everywhere and un-collapse sections
      document.querySelectorAll(`.${CONFIG.hideClass}`).forEach((el) => el.classList.remove(CONFIG.hideClass));
      document.querySelectorAll(SECTION_SELECTOR).forEach((sec) => sec.classList.remove(CONFIG.emptySectionClass));
      resetLegacyInlineDisplay();
    }

    showNotification(isEnabled ? 'Hiding read posts / watched videos' : 'Showing read posts / watched videos');
  }

  function updateVisibilityState() {
    const existing = document.querySelector('.mwyv-hiding-active-indicator');
    if (existing) existing.remove();

    clearTimeout(badgeRetryTimer);
    badgeRetryTimer = 0;

    if (!isEnabled) return;

    const pos = findIndicatorPosition();
    if (!pos) {
      // Retry a bounded number of times (masthead might not be ready yet)
      if (badgeRetries < CONFIG.badgeMaxRetries) {
        badgeRetries++;
        badgeRetryTimer = setTimeout(updateVisibilityState, CONFIG.badgeRetryDelay);
      }
      return;
    }

    badgeRetries = 0;

    const badge = document.createElement('div');
    badge.className = 'mwyv-hiding-active-indicator';
    badge.textContent = 'Hiding Read / Watched';

    if (pos.insertAfter) pos.insertAfter.parentNode.insertBefore(badge, pos.insertAfter.nextSibling);
    else pos.parent.insertBefore(badge, pos.parent.firstChild);
  }

  function findIndicatorPosition() {
    const endContainer = document.querySelector('#end #buttons, ytd-masthead #end, #end');
    if (!endContainer) return null;
    const buttons = endContainer.children;
    let microphoneIndex = -1;
    let createIndex = -1;

    for (let i = 0; i < buttons.length; i++) {
      const button = buttons[i];
      if (button.querySelector('ytd-button-renderer, button[aria-label*="microphone" i], button[aria-label*="voice" i]')) {
        microphoneIndex = i;
      }
      if (button.querySelector('ytd-button-renderer, button[aria-label*="create" i], button[aria-label*="upload" i], ytd-topbar-menu-button-renderer')) {
        createIndex = i;
        break;
      }
    }

    if (microphoneIndex !== -1 && createIndex !== -1 && createIndex > microphoneIndex) {
      return { parent: endContainer, insertAfter: buttons[microphoneIndex] };
    }
    return { parent: endContainer, insertAfter: null };
  }

  function setupKeyboardShortcut() {
    // Install only once
    if (setupKeyboardShortcut._installed) return;
    setupKeyboardShortcut._installed = true;

    document.addEventListener('keydown', (event) => {
      // Ignore when typing in inputs or content-editables
      const t = event.target;
      if (t && ((t instanceof HTMLElement && t.isContentEditable) || (t.tagName && /^(INPUT|TEXTAREA|SELECT)$/i.test(t.tagName)))) return;

      if (event.altKey && (event.key === 'h' || event.key === 'H')) {
        event.preventDefault();
        event.stopPropagation();
        toggleHiding();
      }
    }, true);
  }

  function registerMenuCommands() {
    // Register only once (Tampermonkey can re-run scripts during hot reloads)
    if (registerMenuCommands._installed) return;
    registerMenuCommands._installed = true;

    GM_registerMenuCommand('Toggle Hide Watched / Read', toggleHiding);
    GM_registerMenuCommand('Hide Watched / Read Info', showInfo);
    GM_registerMenuCommand('Force Rescan (Watched/Read)', () => scheduleFullRescan(0));
  }

  function showNotification(message) {
    const doShow = () => {
      const existing = document.querySelector('.mwyv-notification');
      if (existing) existing.remove();

      const n = document.createElement('div');
      n.className = 'mwyv-notification';
      n.textContent = message;
      n.style.cssText = [
        'position:fixed', 'top:50px', 'right:10px', 'background:#333', 'color:#fff',
        'padding:10px 15px', 'border-radius:5px', 'font-size:14px', 'z-index:10000', 'opacity:0.9', 'transition:opacity .3s'
      ].join(';');

      document.body.appendChild(n);
      setTimeout(() => { n.style.opacity = '0'; setTimeout(() => n.remove(), 300); }, 2000);
    };

    if (document.body) doShow();
    else setTimeout(doShow, 250);
  }

  function showInfo() {
    const info = `Hide Watched / Read YouTube Items

Status: ${isEnabled ? 'Enabled' : 'Disabled'}
Shortcut: Alt+H to toggle
Menu: Use "Toggle Hide Watched / Read"

Companion marker script: "Mark Read Posts & Watched YouTube Videos"
• watched => .watched
• read posts => .readpost

This script hides the outer layout item to avoid blank grid holes.`;
    alert(info);
  }

  // Remove inline display set by older versions (guard for odd components)
  function resetLegacyInlineDisplay() {
    if (!SECTION_SELECTOR) return;
    document.querySelectorAll(SECTION_SELECTOR).forEach((sec) => {
      try {
        if (sec instanceof Element && sec.style && typeof sec.style === 'object') sec.style.display = '';
      } catch (_) { /* ignore components that proxy style unusually */ }
    });
  }

  // ---------------------------
  // SPA navigation
  // ---------------------------
  function setupNavigationHandler() {
    if (setupNavigationHandler._installed) return;
    setupNavigationHandler._installed = true;

    // Prefer YouTube SPA events when available
    document.addEventListener('yt-navigate-finish', () => scheduleFullRescan(), true);
    document.addEventListener('yt-page-data-updated', () => scheduleFullRescan(), true);
    window.addEventListener('popstate', () => scheduleFullRescan(), true);

    // Fallback URL poll (covers cases where events don't fire)
    let currentUrl = location.href;
    setInterval(() => {
      if (location.href !== currentUrl) {
        currentUrl = location.href;
        scheduleFullRescan();
      }
    }, 1500);
  }

  // ---------------------------
  // Boot
  // ---------------------------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initOnce, { once: true });
  } else {
    initOnce();
  }
  // Fallback in case DOMContentLoaded was missed / delayed unusually
  setTimeout(initOnce, 2000);
})();
