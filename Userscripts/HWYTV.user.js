// ==UserScript==
// @name        Hide Watched YouTube Videos
// @namespace   https://github.com/Xenfernal
// @version     0.0.4
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

  // Configuration
  const CONFIG = {
    storageKey: 'HideWatchedVideos_Enabled',
    hideClass: 'mwyv-hide-watched',
    emptySectionClass: 'mwyv-section-empty',
    observerDebounce: 100,
    mutationObserverConfig: {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    },
    // All known containers that visually represent a video/shorts tile
    containerSelectorList: [
      'ytd-rich-item-renderer',
      'ytd-video-renderer',
      'ytd-grid-video-renderer',
      'ytd-compact-video-renderer',
      'ytd-playlist-video-renderer',
      // Shorts
      'ytd-reel-item-renderer',
      'ytd-reel-video-renderer'
    ],
    // Sections we may want to collapse when they end up empty
    sectionSelectorList: [
      'ytd-item-section-renderer',
      '.ytd-section-list-renderer',
      '.shelf-content',
      'ytd-reel-shelf-renderer'
    ]
  };

  const CONTAINER_SELECTOR = CONFIG.containerSelectorList.join(',');
  const SECTION_SELECTOR = CONFIG.sectionSelectorList.join(',');

  // State
  let isEnabled = true;
  let observer = null;
  let processTimeout = null;
  let mastheadObserver = null;

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

  // ---- init ----
  function init() {
    isEnabled = GM_getValue(CONFIG.storageKey, true);
    injectStyles();
    setupMutationObserver();
    setupKeyboardShortcut();
    registerMenuCommands();
    setupMastheadObserver();
    updateVisibilityState();

    // Clean any legacy inline display:none from prior versions (guarded)
    resetLegacyInlineDisplay();

    // Initial processing
    processWatchedVideos();
    // Start SPA nav watcher
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

  // ---- observers ----
  function setupMastheadObserver() {
    if (mastheadObserver) mastheadObserver.disconnect();
    const masthead = document.querySelector('#masthead');
    if (!masthead) return; // will be retried on SPA nav

    mastheadObserver = new MutationObserver(() => {
      if (isEnabled && !document.querySelector('.mwyv-hiding-active-indicator')) {
        updateVisibilityState();
      }
    });
    mastheadObserver.observe(masthead, { childList: true, subtree: true });
  }

  function setupMutationObserver() {
    observer = new MutationObserver(() => {
      clearTimeout(processTimeout);
      processTimeout = setTimeout(() => {
        if (isEnabled) processWatchedVideos();
      }, CONFIG.observerDebounce);
    });

    const startObserving = () => {
      const observeTarget = document.querySelector('#contents') || document.body;
      if (observeTarget) observer.observe(observeTarget, CONFIG.mutationObserverConfig);
      ['#primary', '#secondary', '#items', '.ytd-rich-grid-renderer'].forEach((sel) => {
        const t = document.querySelector(sel);
        if (t) observer.observe(t, CONFIG.mutationObserverConfig);
      });
    };

    if (document.body) startObserving();
    else document.addEventListener('DOMContentLoaded', startObserving);
  }

  // ---- toggling & UI ----
  function toggleHiding() {
    isEnabled = !isEnabled;
    GM_setValue(CONFIG.storageKey, isEnabled);

    updateVisibilityState();

    if (isEnabled) {
      processWatchedVideos();
    } else {
      // Remove our hide class everywhere and un-collapse sections
      document.querySelectorAll(`.${CONFIG.hideClass}`).forEach((el) => el.classList.remove(CONFIG.hideClass));
      document.querySelectorAll(SECTION_SELECTOR).forEach((sec) => sec.classList.remove(CONFIG.emptySectionClass));
      resetLegacyInlineDisplay();
    }

    showNotification(isEnabled ? 'Hiding watched videos' : 'Showing watched videos');
  }

  function updateVisibilityState() {
    const existing = document.querySelector('.mwyv-hiding-active-indicator');
    if (existing) existing.remove();
    if (!isEnabled) return;

    const pos = findIndicatorPosition();
    if (!pos) {
      // Retry shortly if masthead not ready
      setTimeout(updateVisibilityState, 500);
      return;
    }

    const badge = document.createElement('div');
    badge.className = 'mwyv-hiding-active-indicator';
    badge.textContent = 'Hiding Watched Videos';

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
        createIndex = i; break;
      }
    }

    if (microphoneIndex !== -1 && createIndex !== -1 && createIndex > microphoneIndex) {
      return { parent: endContainer, insertAfter: buttons[microphoneIndex] };
    }
    return { parent: endContainer, insertAfter: null };
  }

  function setupKeyboardShortcut() {
    document.addEventListener('keydown', (event) => {
      // Ignore when typing in inputs or content-editables
      const t = event.target;
      if (t && ((t instanceof HTMLElement && t.isContentEditable) || /^(INPUT|TEXTAREA|SELECT)$/i.test(t.tagName))) return;

      if (event.altKey && (event.key === 'h' || event.key === 'H')) {
        event.preventDefault();
        event.stopPropagation();
        toggleHiding();
      }
    }, true);
  }

  function registerMenuCommands() {
    GM_registerMenuCommand('Toggle Hide Watched Videos', toggleHiding);
    GM_registerMenuCommand('Hide Watched Videos Info', showInfo);
  }

  function showNotification(message) {
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
  }

  function showInfo() {
    const info = `Hide Watched YouTube Videos\n\nStatus: ${isEnabled ? 'Enabled' : 'Disabled'}\nShortcut: Alt+H to toggle\nMenu: Use "Toggle Hide Watched Videos"\n\nThis script works with a companion marker that adds the class \"watched\" to completed items.\n\nKey notes in this build:\n• Fix: history page TypeError caused by writing inline style on internal components.\n• Now uses class-based section collapsing.\n• More robust container targeting (Shorts included).`;
    alert(info);
  }

  // ---- core logic ----
  function processWatchedVideos() {
    if (!isEnabled) return;

    // 1) Hide tiles corresponding to any descendant marked .watched
    document.querySelectorAll('.watched').forEach((node) => {
      // climb to the visible tile container when marker is on an inner node
      const tile = (node instanceof Element) ? (node.closest(CONTAINER_SELECTOR) || node) : null;
      if (tile && tile instanceof Element) tile.classList.add(CONFIG.hideClass);
    });

    // 2) Collapse sections that now have no visible children (class-based, no inline style writes)
    cleanupEmptySections();
  }

  function cleanupEmptySections() {
    document.querySelectorAll(SECTION_SELECTOR).forEach((sec) => {
      if (!(sec instanceof Element)) return;
      // Find any direct child that is NOT hidden by our class (ignore continuations)
      const visible = sec.querySelector(`:scope > *:not(.${CONFIG.hideClass}):not(ytd-continuation-item-renderer)`);
      sec.classList.toggle(CONFIG.emptySectionClass, !visible);
      // Do not touch inline style here (avoids history-page TypeError)
    });
  }

  // Remove inline display set by older versions (guard for odd components)
  function resetLegacyInlineDisplay() {
    document.querySelectorAll(SECTION_SELECTOR).forEach((sec) => {
      try {
        if (sec instanceof Element && sec.style && typeof sec.style === 'object') sec.style.display = '';
      } catch (_) { /* ignore components that proxy style unusually */ }
    });
  }

  // ---- SPA navigation ----
  function setupNavigationHandler() {
    let currentUrl = location.href;
    const check = () => {
      if (location.href !== currentUrl) {
        currentUrl = location.href;
        setTimeout(() => {
          if (isEnabled) processWatchedVideos();
          setupMastheadObserver();
          updateVisibilityState();
        }, 500);
      }
    };
    setInterval(check, 1000);
  }

  // ---- boot ----
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
