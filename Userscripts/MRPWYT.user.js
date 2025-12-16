// ==UserScript==
// @name        Mark Read Posts & Watched YouTube Videos
// @namespace   https://github.com/Xenfernal
// @version     2.4
// @icon        https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @license     AGPL v3
// @author      Xen
// @description Add an indicator for Read Posts and Watched Videos on YouTube. Use GM menus to display history statistics, backup history, and restore/merge history. Based on the userscript by jcunews.
// @match       *://www.youtube.com/*
// @grant       GM_getValue
// @grant       GM_registerMenuCommand
// @grant       GM_setValue
// @grant       unsafeWindow
// @homepageURL https://github.com/Xenfernal/Personal-QoL-Stuff/tree/main/Userscripts
// @downloadURL https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/MRPWYT.user.js
// @updateURL   https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/MRPWYT.user.js
// @run-at      document-start
// ==/UserScript==

/*
- Use ALT+LeftClick or ALT+RightClick on a video list item to manually toggle the watched or read marker. The mouse button is defined in the script and can be changed.
- For restoring/merging history, source file can also be a YouTube's history data JSON (downloadable from https://support.google.com/accounts/answer/3024190?hl=en). Or a list of YouTube video URLs (using current time as timestamps).
*/

(() => {
  //=== config start ===
  var maxWatchedVideoAge = 10 * 365; // days; set to 0 to disable (not recommended)
  var maxReadPostAge = 10 * 365; // days; set to 0 to disable
  // Reduced default delay to improve perceived responsiveness on SPA navigations.
  // If your network/browser is slow, increase this back (e.g. 600).
  var contentLoadMarkDelay = 175; // ms; increase if slow network/browser
  var markerMouseButtons = [0, 2]; // MouseEvent.button: 0=left, 1=middle, 2=right
  //=== config end ===

  const KEY_WATCHED = "watchedVideos";
  const KEY_READPOSTS = "readPosts";

  let watchedVideos;
  let readPosts;

  const ageMultiplier = 24 * 60 * 60 * 1000;

  // Video IDs
  const xu = /(?:\/watch(?:\?|.*?&)v=|\/embed\/)([^\/\?&]+)|\/shorts\/([^\/\?]+)|\/live\/([^\/\?]+)/;

  // Layout helpers
  const querySelector = Element.prototype.querySelector;

  // Keep the video anchor selector strictly video-only (do NOT include /post/ here).
  const videoAnchorSelector = 'a#thumbnail[href], a#video-title[href], a[href*="/watch?v="], a[href^="/shorts/"], a[href*="/embed/"], a[href^="/live/"]';

  // Post anchor selector (kept separate to avoid interfering with video matching).
  const postAnchorSelector = 'a[href^="/post/"], a[href*="/post/"], a[href*="community?lb="], a[href*="?lb="]';

  // Post containers used by the community feed.
  const postContainerSelector = "ytd-backstage-post-thread-renderer,ytd-backstage-post-renderer,ytd-post-renderer,ytd-shared-post-renderer";

  // Containers where we apply .watched (videos)
  const watchedContainerSelector = [
    "ytd-rich-item-renderer",
    "ytd-rich-grid-media",
    "ytd-rich-grid-slim-media",
    "ytd-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-compact-radio-renderer",
    "ytd-playlist-video-renderer",
    "ytd-playlist-panel-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-reel-item-renderer",
    "yt-lockup-view-model",
    ".yt-lockup-view-model",
    ".yt-lockup-view-model-wiz",
    ".yt-shelf-grid-item",
    ".video-list-item",
    ".pl-video"
  ].join(",");

  function getVideoId(url) {
    let m = url && url.match && url.match(xu);
    if (m) return m[1] || m[2] || m[3];
    return null;
  }

  function getPostId(url) {
    try {
      const u = new URL(url, location.origin);
      if (u.pathname && u.pathname.startsWith("/post/")) {
        const parts = u.pathname.split("/");
        return parts[2] || null;
      }
      const lb = u.searchParams.get("lb");
      return lb || null;
    } catch (_) {
      return null;
    }
  }

  function watched(vid) {
    return !!(watchedVideos && watchedVideos.entries && watchedVideos.entries[vid]);
  }

  function read(pid) {
    return !!(readPosts && readPosts.entries && readPosts.entries[pid]);
  }

  // --- data parsing (shared) ---
  let dc;
  function parseData(s, a) {
    try {
      dc = false;
      s = JSON.parse(s);
      // old: [{id:<str>, timestamp:<num>}, ...]
      // new: {entries:{<id>:<num>, ...}, index:[<id>, ...]}
      if (Array.isArray(s) && (!s.length || ((typeof s[0] === "object") && s[0].id && s[0].timestamp))) {
        a = s;
        s = { entries: {}, index: [] };
        a.forEach((o) => {
          s.entries[o.id] = o.timestamp;
          s.index.push(o.id);
        });
      } else if ((typeof s !== "object") || (typeof s.entries !== "object") || !Array.isArray(s.index)) {
        return null;
      }

      // reconstruct index if broken
      if (s.index.length !== (a = Object.keys(s.entries)).length) {
        s.index = a.map((k) => [k, s.entries[k]]).sort((x, y) => x[1] - y[1]).map((v) => v[0]);
        dc = true;
      }
      return s;
    } catch (_) {
      return null;
    }
  }

  function getHistory(key) {
    let raw = GM_getValue(key);
    if (raw === undefined) {
      raw = '{"entries": {}, "index": []}';
      GM_setValue(key, raw);
      return JSON.parse(raw);
    }
    if (typeof raw === "object") raw = JSON.stringify(raw);
    const parsed = parseData(raw);
    if (parsed) {
      if (dc) GM_setValue(key, JSON.stringify(parsed));
      return parsed;
    }
    const init = { entries: {}, index: [] };
    GM_setValue(key, JSON.stringify(init));
    return init;
  }

  function saveHistory(key, store) {
    GM_setValue(key, JSON.stringify(store));
  }

  function addEntry(store, key, id, time, noSave, i) {
    if (!id) return;
    if (!store.entries[id]) {
      store.index.push(id);
    } else {
      i = store.index.indexOf(id);
      if (i >= 0) store.index.push(store.index.splice(i, 1)[0]);
    }
    store.entries[id] = time;
    if (!noSave) saveHistory(key, store);
  }

  function delEntry(store, key, index, noSave) {
    delete store.entries[store.index[index]];
    store.index.splice(index, 1);
    if (!noSave) saveHistory(key, store);
  }

  function mergeDataInto(target, incoming) {
    incoming.index.forEach((id) => {
      if (target.entries[id]) {
        if (target.entries[id] < incoming.entries[id]) target.entries[id] = incoming.entries[id];
      } else {
        target.entries[id] = incoming.entries[id];
      }
    });
    const keys = Object.keys(target.entries);
    target.index = keys.map((k) => [k, target.entries[k]]).sort((x, y) => x[1] - y[1]).map((v) => v[0]);
  }

  // YouTube Takeout watch history import (videos only)
  function parseYouTubeData(s, a) {
    try {
      s = JSON.parse(s);
      // old: [{titleUrl:<strUrl>, time:<strIsoDate>}, ...]
      if (Array.isArray(s) && (!s.length || ((typeof s[0] === "object") && s[0].titleUrl && s[0].time))) {
        a = s;
        s = { entries: {}, index: [] };
        a.forEach((o, m, t) => {
          if (o.titleUrl && (m = o.titleUrl.match(xu))) {
            if (isNaN((t = new Date(o.time).getTime()))) t = Date.now();
            const id = m[1] || m[2] || m[3];
            s.entries[id] = t;
            s.index.push(id);
          }
        });
        s.index.reverse();
        return s;
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  // --- marking: videos (original behaviour) ---
  function processVideoItems(selector) {
    const items = document.querySelectorAll(selector);
    for (let i = items.length - 1; i >= 0; i--) {
      const link = querySelector.call(items[i], videoAnchorSelector);
      if (link && link.href) {
        const v = getVideoId(link.href);
        if (v && watched(v)) items[i].classList.add("watched");
        else items[i].classList.remove("watched");
      }
    }
  }

  function processAllVideoItems() {
    // home page
    processVideoItems(`.yt-uix-shelfslider-list>.yt-shelf-grid-item`);
    processVideoItems(`
#contents.ytd-rich-grid-renderer>ytd-rich-item-renderer,
#contents.ytd-rich-shelf-renderer ytd-rich-item-renderer.ytd-rich-shelf-renderer,
#contents.ytd-rich-grid-renderer>ytd-rich-grid-row ytd-rich-grid-media`);
    // subscriptions page
    processVideoItems(`.multirow-shelf>.shelf-content>.yt-shelf-grid-item`);
    // history:watch page
    processVideoItems(`ytd-section-list-renderer[page-subtype="history"] .ytd-item-section-renderer>ytd-video-renderer`);
    processVideoItems("yt-lockup-view-model");
    processVideoItems(".yt-lockup-view-model");
    // channel/user home page
    processVideoItems(`
#contents>.ytd-item-section-renderer>.ytd-newspaper-renderer,
#items>.yt-horizontal-list-renderer`);
    processVideoItems(`
#contents>.ytd-channel-featured-content-renderer,
#contents>.ytd-shelf-renderer>#grid-container>.ytd-expanded-shelf-contents-renderer`);
    // channel/user video page
    processVideoItems(`
.yt-uix-slider-list>.featured-content-item,
.channels-browse-content-grid>.channels-content-item,
#items>.ytd-grid-renderer,
#contents>.ytd-rich-grid-renderer`);
    // channel/user shorts page
    processVideoItems(`
ytd-rich-item-renderer ytd-rich-grid-slim-media`);
    // playlist pages
    processVideoItems(`
.expanded-shelf>.expanded-shelf-content-list>.expanded-shelf-content-item-wrapper,
ytd-playlist-video-list-renderer ytd-playlist-video-renderer,
ytd-playlist-video-renderer,
ytd-playlist-video-list-renderer .yt-lockup-view-model`);
    // playlist item page
    processVideoItems(`
.pl-video-list .pl-video-table .pl-video,
ytd-playlist-panel-video-renderer`);
    // channel/user search page
    if (/^\/(?:(?:c|channel|user)\/)?[^/]+\/search/.test(location.pathname)) {
      processVideoItems(`.ytd-browse #contents>.ytd-item-section-renderer`);
    }
    // search page
    processVideoItems(`
#results>.section-list .item-section>li,
#browse-items-primary>.browse-list-item-container`);
    processVideoItems(`
.ytd-search #contents>ytd-video-renderer,
.ytd-search #contents>ytd-playlist-renderer,
.ytd-search #items>ytd-video-renderer`);
    // video page
    processVideoItems(`
.watch-sidebar-body>.video-list>.video-list-item,
.playlist-videos-container>.playlist-videos-list>li`);
    processVideoItems(`
.ytd-compact-video-renderer,
.ytd-compact-radio-renderer,
ytd-watch-next-secondary-results-renderer .yt-lockup-view-model-wiz`);
  }

  // --- marking: posts (READ) ---
  function getPostIdFromContainer(c) {
    if (!c) return null;
    const a = querySelector.call(c, postAnchorSelector);
    return (a && a.href) ? getPostId(a.href) : null;
  }

  function processPostItems(selector) {
    const items = document.querySelectorAll(selector);
    for (let i = items.length - 1; i >= 0; i--) {
      const id = getPostIdFromContainer(items[i]);
      if (id && read(id)) items[i].classList.add("readpost");
      else items[i].classList.remove("readpost");
    }
  }

  function processAllPostItems() {
    processPostItems(postContainerSelector);
  }

  // --- second-pass scheduling & incremental marking ---
  let fullProcessTimer = 0;
  let lastFullProcessAt = 0;
  // Reduced from 2000ms to improve SPA responsiveness.
  const FULL_PROCESS_MIN_INTERVAL = 250;

  function scheduleFullProcess(delay) {
    delay = (delay == null) ? Math.floor(contentLoadMarkDelay / 2) : delay;
    const now = Date.now();
    const minDelay = Math.max(0, FULL_PROCESS_MIN_INTERVAL - (now - lastFullProcessAt));
    if (delay < minDelay) delay = minDelay;
    clearTimeout(fullProcessTimer);
    fullProcessTimer = setTimeout(doProcessPage, delay);
  }

  const moQueue = new Set();
  let moTimer = 0;
  // Reduced from 180ms to tighten perceived lag.
  const partialMarkDelay = 30;

  function queueNodeForMark(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.id === "mwyvrh_ujs" || node.id === "mwyprh_ujs") return;
    if (node.closest && (node.closest("#mwyvrh_ujs") || node.closest("#mwyprh_ujs"))) return;

    const hasAnchor = (node.matches && (node.matches(videoAnchorSelector) || node.matches(postAnchorSelector))) ||
      (node.querySelector && (node.querySelector(videoAnchorSelector) || node.querySelector(postAnchorSelector)));
    if (!hasAnchor) return;

    moQueue.add(node);
  }

  function markVideoAnchor(a) {
    if (!a || !a.href) return;
    const v = getVideoId(a.href);
    if (!v) return;
    const c = a.closest ? a.closest(watchedContainerSelector) : null;
    if (!c) return;
    if (watched(v)) c.classList.add("watched");
    else c.classList.remove("watched");
  }

  function markPostAnchor(a) {
    if (!a || !a.href) return;
    const p = getPostId(a.href);
    if (!p) return;
    const c = a.closest ? a.closest(postContainerSelector) : null;
    if (!c) return;
    if (read(p)) c.classList.add("readpost");
    else c.classList.remove("readpost");
  }

  function processAnchorsIn(root) {
    if (!root || root.nodeType !== 1) return;

    if (root.matches && root.matches(videoAnchorSelector)) markVideoAnchor(root);
    if (root.querySelectorAll) {
      const vids = root.querySelectorAll(videoAnchorSelector);
      for (let i = 0; i < vids.length; i++) markVideoAnchor(vids[i]);
    }

    if (root.matches && root.matches(postAnchorSelector)) markPostAnchor(root);
    if (root.querySelectorAll) {
      const posts = root.querySelectorAll(postAnchorSelector);
      for (let i = 0; i < posts.length; i++) markPostAnchor(posts[i]);
    }
  }

  function flushMarkQueue() {
    moTimer = 0;
    if (!moQueue.size) return;

    if (!watchedVideos || !watchedVideos.entries) watchedVideos = getHistory(KEY_WATCHED);
    if (!readPosts || !readPosts.entries) readPosts = getHistory(KEY_READPOSTS);

    moQueue.forEach((n) => processAnchorsIn(n));
    moQueue.clear();
  }

  function scheduleMarkFlush(delay) {
    clearTimeout(moTimer);
    moTimer = setTimeout(flushMarkQueue, delay == null ? partialMarkDelay : delay);
  }

  function purgeOld(store, key, maxAgeDays) {
    if (!maxAgeDays || maxAgeDays <= 0) return;
    const now = Date.now();
    let changed = false;
    while (store.index.length) {
      const id = store.index[0];
      if ((now - store.entries[id]) / ageMultiplier > maxAgeDays) {
        delEntry(store, key, 0, true);
        changed = true;
      } else {
        break;
      }
    }
    if (changed) saveHistory(key, store);
  }

  function doProcessPage() {
    watchedVideos = getHistory(KEY_WATCHED);
    readPosts = getHistory(KEY_READPOSTS);

    purgeOld(watchedVideos, KEY_WATCHED, maxWatchedVideoAge);
    purgeOld(readPosts, KEY_READPOSTS, maxReadPostAge);

    const now = Date.now();

    // mark current video as watched (original behaviour)
    const vid = getVideoId(location.href);
    if (vid && !watched(vid)) addEntry(watchedVideos, KEY_WATCHED, vid, now);

    // mark current post as read (new)
    const pid = getPostId(location.href);
    if (pid && !read(pid)) addEntry(readPosts, KEY_READPOSTS, pid, now);

    processAllVideoItems();
    processAllPostItems();

    lastFullProcessAt = Date.now();
  }

  function processPage() {
    scheduleFullProcess(Math.floor(contentLoadMarkDelay / 2));
  }

  function delayedProcessPage() {
    scheduleFullProcess(contentLoadMarkDelay);
  }

  // --- manual toggle: prefer READ if click is on a post, else WATCHED ---
  function togglePostMarkerFromElement(ele) {
    if (!ele) return false;
    const c = ele.closest ? ele.closest(postContainerSelector) : null;
    let pid = c ? getPostIdFromContainer(c) : null;
    if (!pid && ele.closest) {
      const a = ele.closest(postAnchorSelector);
      if (a && a.href) pid = getPostId(a.href);
    }
    if (!pid) return false;

    const idx = readPosts.index.indexOf(pid);
    if (idx >= 0) delEntry(readPosts, KEY_READPOSTS, idx);
    else addEntry(readPosts, KEY_READPOSTS, pid, Date.now());
    processAllPostItems();
    return true;
  }

  function toggleVideoMarkerFromElement(ele) {
    let i;
    if (!ele) return false;

    if (!ele.href && ele.closest) {
      const a = ele.closest(videoAnchorSelector);
      if (a && a.href) ele = a;
    }

    if (ele && ele.href) {
      i = getVideoId(ele.href);
    } else {
      while (ele) {
        while (ele && (!ele.__data || !ele.__data.data || !ele.__data.data.videoId)) ele = ele.__dataHost || ele.parentNode;
        if (ele) { i = ele.__data.data.videoId; break; }
      }
    }

    if (!i) return false;

    const idx = watchedVideos.index.indexOf(i);
    if (idx >= 0) delEntry(watchedVideos, KEY_WATCHED, idx);
    else addEntry(watchedVideos, KEY_WATCHED, i, Date.now());
    processAllVideoItems();
    return true;
  }

  function toggleMarker(ele) {
    if (!watchedVideos || !watchedVideos.entries) watchedVideos = getHistory(KEY_WATCHED);
    if (!readPosts || !readPosts.entries) readPosts = getHistory(KEY_READPOSTS);

    if (togglePostMarkerFromElement(ele)) return;
    toggleVideoMarkerFromElement(ele);
  }

  // --- observe YouTube SPA loads (XHR/fetch) and incrementally mark new nodes ---
  const rxListUrl = /\/\w+_ajax\?|\/results\?search_query|\/v1\/(browse|next|search)\?/;

  // XHR hook (guarded). If it fails, the script still works via MutationObserver + navigation events.
  try {
    const xhropen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      try {
        if (rxListUrl.test(url) && !this.__mwyvHooked) {
          this.__mwyvHooked = 1;
          // Reduce delay: incremental marking should happen quickly after list loads.
          this.addEventListener("load", () => scheduleMarkFlush(partialMarkDelay));
        }
      } catch (_) {}
      return xhropen.apply(this, arguments);
    };
  } catch (_) {}

  // fetch hook (guarded). If it fails, the script still works via MutationObserver + navigation events.
  try {
    const fetch_ = unsafeWindow.fetch;
    if (typeof fetch_ === "function") {
      unsafeWindow.fetch = function(opt) {
        let url;
        try { url = (opt && opt.url) || opt; } catch (_) { url = opt; }
        const p = fetch_.apply(unsafeWindow, arguments);
        try {
          if (rxListUrl.test(url)) return p.finally(() => scheduleMarkFlush(partialMarkDelay));
        } catch (_) {}
        return p;
      };
    }
  } catch (_) {}

  // --- style + events ---
  const to = { createHTML: (s) => s };

  // Trusted Types hardening (no behavioural change): try to create a policy, but never fail if CSP/sandbox blocks it.
  let tp = to;
  try {
    const tt = (unsafeWindow && unsafeWindow.trustedTypes) || window.trustedTypes;
    if (tt && typeof tt.createPolicy === "function") {
      // Creation may throw under YouTube CSP allowlists or if a policy with the same name already exists.
      tp = tt.createPolicy("mwyv", to);
    }
  } catch (_) {
    tp = to;
  }

  const html = (s) => tp.createHTML(s);

  addEventListener("DOMContentLoaded", () => {
    const sty = document.createElement("STYLE");
    sty.innerHTML = html(`
:root{
  --mwyv-ring:#34c759;--mwyv-overlay:rgba(52,199,89,.10);--mwyv-badge-bg:rgba(52,199,89,.95);--mwyv-badge-fg:#08110a;--mwyv-radius:12px;
  --mwyv-read-ring:#0a84ff;--mwyv-read-overlay:rgba(10,132,255,.10);--mwyv-read-badge-bg:rgba(10,132,255,.92);--mwyv-read-badge-fg:#06101a;
}
html[dark]{
  --mwyv-ring:#2ecc71;--mwyv-overlay:rgba(46,204,113,.14);--mwyv-badge-bg:rgba(46,204,113,.92);--mwyv-badge-fg:#091410;
  --mwyv-read-ring:#5aa8ff;--mwyv-read-overlay:rgba(90,168,255,.14);--mwyv-read-badge-bg:rgba(90,168,255,.92);--mwyv-read-badge-fg:#07111c;
}

/* WATCHED (videos) */
.watched{position:relative !important;border-radius:var(--mwyv-radius)}
.watched::before{content:"";position:absolute;inset:0;border-radius:inherit;background:var(--mwyv-overlay);box-shadow:0 0 0 2px var(--mwyv-ring) inset,0 2px 12px rgba(0,0,0,.18);pointer-events:none}
.watched::after{content:"WATCHED";position:absolute;top:6px;left:6px;padding:2px 8px;border-radius:999px;background:var(--mwyv-badge-bg);color:var(--mwyv-badge-fg);font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;line-height:1;z-index:5;pointer-events:none}
.watched ytd-thumbnail img,
.watched #thumbnail img,
.watched .yt-core-image,
.watched img.yt-core-image--loaded,
.watched .ytCoreImageHost,
.watched .yt-core-image{filter:grayscale(.25) saturate(.9) brightness(.9)}
.watched #video-title,
.watched a#video-title,
.watched .yt-ui-ellipsis,
.watched .title{opacity:.75}

/* READ (posts) */
.readpost{position:relative !important;border-radius:var(--mwyv-radius)}
.readpost::before{content:"";position:absolute;inset:0;border-radius:inherit;background:var(--mwyv-read-overlay);box-shadow:0 0 0 2px var(--mwyv-read-ring) inset,0 2px 12px rgba(0,0,0,.14);pointer-events:none}
.readpost::after{content:"READ";position:absolute;top:6px;left:6px;padding:2px 8px;border-radius:999px;background:var(--mwyv-read-badge-bg);color:var(--mwyv-read-badge-fg);font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;line-height:1;z-index:5;pointer-events:none}
`);
    document.head.appendChild(sty);

    // SPA signals: incremental flush frequently; full process on navigation.
    document.addEventListener("yt-service-request-completed", () => scheduleMarkFlush(partialMarkDelay), true);
    document.addEventListener("yt-navigate-finish", () => scheduleFullProcess(Math.floor(contentLoadMarkDelay / 2)), true);
    document.addEventListener("yt-page-data-updated", () => scheduleFullProcess(Math.floor(contentLoadMarkDelay / 2)), true);

    // Incremental marking: touch newly inserted tiles/posts.
    (function initObserver() {
      const target = document.querySelector("ytd-app") || document.body;
      if (!target) { setTimeout(initObserver, 250); return; }

      const mo = new MutationObserver((muts) => {
        for (let i = 0; i < muts.length; i++) {
          const added = muts[i].addedNodes;
          for (let j = 0; j < added.length; j++) queueNodeForMark(added[j]);
        }
        if (moQueue.size) scheduleMarkFlush(partialMarkDelay);
      });
      mo.observe(target, { childList: true, subtree: true });

      // Fast re-mark when YouTube reuses existing tiles and only changes <a href>.
      // (childList won't fire in that case; href attribute changes will.)
      const moAttr = new MutationObserver((muts) => {
        for (let i = 0; i < muts.length; i++) {
          const a = muts[i].target;
          if (!a || a.nodeType !== 1 || a.tagName !== "A") continue;
          if (a.closest && (a.closest("#mwyvrh_ujs") || a.closest("#mwyprh_ujs"))) continue;
          if (a.matches && (a.matches(videoAnchorSelector) || a.matches(postAnchorSelector))) {
            moQueue.add(a);
          }
        }
        if (moQueue.size) scheduleMarkFlush(0);
      });
      moAttr.observe(target, { attributes: true, attributeFilter: ["href"], subtree: true });

      // First pass ASAP after initial render.
      scheduleFullProcess(0);
    })();
  });

  // focus/blur refresh
  let lastFocusState = document.hasFocus();
  addEventListener("blur", () => { lastFocusState = false; });
  addEventListener("focus", () => { if (!lastFocusState) processPage(); lastFocusState = true; });

  function handleToggleClick(ev) {
    if (!ev || !ev.altKey) return;
    if (ev.type === "auxclick" && ev.button === 2) return; // avoid right-click double toggles
    if (markerMouseButtons.indexOf(ev.button) < 0) return;
    ev.stopImmediatePropagation(); ev.stopPropagation(); ev.preventDefault();
    toggleMarker(ev.target);
  }

  addEventListener("click", handleToggleClick, true);
  addEventListener("auxclick", handleToggleClick, true);

  if (markerMouseButtons.indexOf(2) >= 0) {
    addEventListener("contextmenu", (ev) => {
      if (!ev.altKey) return;
      ev.stopImmediatePropagation(); ev.stopPropagation(); ev.preventDefault();
      toggleMarker(ev.target);
    }, true);
  }

  // Legacy hooks
  if (window["body-container"]) {
    addEventListener("spfdone", processPage);
    processPage();
  } else {
    let t = 0;
    function pl() { clearTimeout(t); t = setTimeout(processPage, 300); }
    (function init(vm) {
      if ((vm = document.getElementById("visibility-monitor"))) vm.addEventListener("viewport-load", pl);
      else setTimeout(init, 100);
    })();
    (function init2(mh) {
      if ((mh = document.getElementById("masthead"))) mh.addEventListener("yt-rendererstamper-finished", pl);
      else setTimeout(init2, 100);
    })();
    addEventListener("load", delayedProcessPage);
    addEventListener("spfprocess", delayedProcessPage);
  }

  // --- menus (VIDEOS) ---
  GM_registerMenuCommand("Display History Statistics", () => {
    function sum(r, v) { return r + v; }
    function avg(arr, cnt) {
      arr = Object.values(arr);
      cnt = cnt || arr?.length;
      return arr?.length ? Math.round(arr.reduce(sum, 0) / cnt) : "(n/a)";
    }
    let t0 = Infinity, t1 = -Infinity, d0 = Infinity, d1 = -Infinity, ld = {};
    let e0, e1, o0, o1, sp, ad, am, ay;

    watchedVideos = getHistory(KEY_WATCHED);
    Object.keys(watchedVideos.entries).forEach((k) => {
      const dt = new Date(watchedVideos.entries[k]);
      let a = dt.getTime();
      if (a < t0) t0 = a;
      if (a > t1) t1 = a;
      a = Math.floor(a / 86400000);
      if (a < d0) d0 = a;
      if (a > d1) d1 = a;
      ld[a] = (ld[a] || 0) + 1;
    });

    d1 -= d0 - 1;
    if (watchedVideos.index.length) {
      e0 = (o0 = new Date(t0)).toLocaleString();
      e1 = (o1 = new Date(t1)).toLocaleString();
      let y = o1.getFullYear() - o0.getFullYear();
      let m = o1.getMonth() - o0.getMonth();
      if (m < 0) { m += 12; y--; }
      let d = o1.getDate() - o0.getDate();
      if (d < 0) { d += 30; if (--m < 0) { m += 12; y--; } }
      sp = `${y} years ${m} months ${d} days (${d1} days total)`;
      ad = avg(ld, d1);
      am = avg(ld, d1 / 30);
      ay = avg(ld, d1 / 365);
    } else {
      e0 = e1 = sp = ad = am = ay = "(n/a)";
    }

    alert(`Number of entries: ${watchedVideos.index.length}\nOldest entry: ${e0}\nNewest entry: ${e1}\nTime span: ${sp}\n\nAverage viewed videos per day: ${ad}\nAverage viewed videos per month: ${am}\nAverage viewed videos per year: ${ay}\n\nHistory data size: ${JSON.stringify(watchedVideos).length} bytes`);
  });

  GM_registerMenuCommand("Backup History Data", () => {
    watchedVideos = getHistory(KEY_WATCHED);
    const a = document.createElement("A");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(watchedVideos)], { type: "application/json" }));
    a.download = `MarkWatchedYouTubeVideos_${new Date().toISOString()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  });

  GM_registerMenuCommand("Restore History Data", () => {
    watchedVideos = getHistory(KEY_WATCHED);

    function askRestore(o) {
      const mergeEl = document.getElementById("mwyvrhm_ujs");
      if (confirm(`Selected history data file contains ${o.index.length} entries.\n\nRestore from this data?`)) {
        if (mergeEl && mergeEl.checked) mergeDataInto(watchedVideos, o);
        else watchedVideos = o;
        saveHistory(KEY_WATCHED, watchedVideos);
        overlay.remove();
        doProcessPage();
      }
    }

    if (document.getElementById("mwyvrh_ujs")) return;

    const overlay = document.createElement("DIV");
    overlay.id = "mwyvrh_ujs";
    overlay.innerHTML = html(`<style>
#mwyvrh_ujs{display:flex;position:fixed;z-index:99999;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,.5);font-family:sans-serif;cursor:pointer}
#mwyvrhb_ujs{margin:auto;border:.3rem solid #007;border-radius:.3rem;padding:.7rem 1em;background:#fff;cursor:auto}
#mwyvrht_ujs{margin-bottom:1rem;font-size:14pt;font-weight:700}
#mwyvrhmc_ujs{margin:.5em 0 1em 0;text-align:center}
#mwyvrhi_ujs{display:block;margin:1rem auto .5rem auto}
</style>
<div id="mwyvrhb_ujs">
  <div id="mwyvrht_ujs">Mark Watched YouTube Videos</div>
  Please select a file to restore history data from.
  <div id="mwyvrhmc_ujs"><label><input id="mwyvrhm_ujs" type="checkbox" checked /> Merge history data instead of replace.</label></div>
  <input id="mwyvrhi_ujs" type="file" multiple />
</div>`);

    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const input = querySelector.call(overlay, "#mwyvrhi_ujs");
    input.onchange = () => {
      const r = new FileReader();
      r.onload = () => {
        const raw = String(r.result || "");
        let o = parseData(raw);
        if (o) {
          if (o.index.length) askRestore(o);
          else alert("File doesn't contain any history entry.");
          return;
        }
        o = parseYouTubeData(raw);
        if (o) {
          if (o.index.length) askRestore(o);
          else alert("File doesn't contain any history entry.");
          return;
        }
        // Plain list of video URLs
        const lines = raw.replace(/\r/g, "").split("\n").map(s => s.trim()).filter(Boolean);
        if (!lines.length || !xu.test(lines[0])) {
          alert("Invalid history data file.");
          return;
        }
        const t = Date.now();
        o = { entries: {}, index: [] };
        lines.forEach((s) => {
          const id = getVideoId(s);
          if (id) { o.entries[id] = t; o.index.push(id); }
        });
        if (o.index.length) askRestore(o);
        else alert("File doesn't contain any history entry.");
      };
      r.readAsText(input.files[0]);
    };

    document.documentElement.appendChild(overlay);
    input.click();
  });

  // --- menus (POSTS) ---
  GM_registerMenuCommand("Display Read Post Statistics", () => {
    function sum(r, v) { return r + v; }
    function avg(arr, cnt) {
      arr = Object.values(arr);
      cnt = cnt || arr?.length;
      return arr?.length ? Math.round(arr.reduce(sum, 0) / cnt) : "(n/a)";
    }
    let t0 = Infinity, t1 = -Infinity, d0 = Infinity, d1 = -Infinity, ld = {};
    let e0, e1, o0, o1, sp, ad, am, ay;

    readPosts = getHistory(KEY_READPOSTS);
    Object.keys(readPosts.entries).forEach((k) => {
      const dt = new Date(readPosts.entries[k]);
      let a = dt.getTime();
      if (a < t0) t0 = a;
      if (a > t1) t1 = a;
      a = Math.floor(a / 86400000);
      if (a < d0) d0 = a;
      if (a > d1) d1 = a;
      ld[a] = (ld[a] || 0) + 1;
    });

    d1 -= d0 - 1;
    if (readPosts.index.length) {
      e0 = (o0 = new Date(t0)).toLocaleString();
      e1 = (o1 = new Date(t1)).toLocaleString();
      let y = o1.getFullYear() - o0.getFullYear();
      let m = o1.getMonth() - o0.getMonth();
      if (m < 0) { m += 12; y--; }
      let d = o1.getDate() - o0.getDate();
      if (d < 0) { d += 30; if (--m < 0) { m += 12; y--; } }
      sp = `${y} years ${m} months ${d} days (${d1} days total)`;
      ad = avg(ld, d1);
      am = avg(ld, d1 / 30);
      ay = avg(ld, d1 / 365);
    } else {
      e0 = e1 = sp = ad = am = ay = "(n/a)";
    }

    alert(`Number of read posts: ${readPosts.index.length}\nOldest entry: ${e0}\nNewest entry: ${e1}\nTime span: ${sp}\n\nAverage read posts per day: ${ad}\nAverage read posts per month: ${am}\nAverage read posts per year: ${ay}\n\nData size: ${JSON.stringify(readPosts).length} bytes`);
  });

  GM_registerMenuCommand("Backup Read Post Data", () => {
    readPosts = getHistory(KEY_READPOSTS);
    const a = document.createElement("A");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(readPosts)], { type: "application/json" }));
    a.download = `MarkReadYouTubePosts_${new Date().toISOString()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  });

  GM_registerMenuCommand("Restore Read Post Data", () => {
    readPosts = getHistory(KEY_READPOSTS);

    function askRestore(o) {
      const mergeEl = document.getElementById("mwyprhm_ujs");
      if (confirm(`Selected post data file contains ${o.index.length} entries.\n\nRestore from this data?`)) {
        if (mergeEl && mergeEl.checked) mergeDataInto(readPosts, o);
        else readPosts = o;
        saveHistory(KEY_READPOSTS, readPosts);
        overlay.remove();
        doProcessPage();
      }
    }

    if (document.getElementById("mwyprh_ujs")) return;

    const overlay = document.createElement("DIV");
    overlay.id = "mwyprh_ujs";
    overlay.innerHTML = html(`<style>
#mwyprh_ujs{display:flex;position:fixed;z-index:99999;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,.5);font-family:sans-serif;cursor:pointer}
#mwyprhb_ujs{margin:auto;border:.3rem solid #07a;border-radius:.3rem;padding:.7rem 1em;background:#fff;cursor:auto}
#mwyprht_ujs{margin-bottom:1rem;font-size:14pt;font-weight:700}
#mwyprhmc_ujs{margin:.5em 0 1em 0;text-align:center}
#mwyprhi_ujs{display:block;margin:1rem auto .5rem auto}
</style>
<div id="mwyprhb_ujs">
  <div id="mwyprht_ujs">Mark Read YouTube Posts</div>
  Please select a file to restore post read data from.
  <div id="mwyprhmc_ujs"><label><input id="mwyprhm_ujs" type="checkbox" checked /> Merge data instead of replace.</label></div>
  <input id="mwyprhi_ujs" type="file" multiple />
</div>`);

    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const input = querySelector.call(overlay, "#mwyprhi_ujs");
    input.onchange = () => {
      const r = new FileReader();
      r.onload = () => {
        const raw = String(r.result || "");
        let o = parseData(raw);
        if (o) {
          if (o.index.length) askRestore(o);
          else alert("File doesn't contain any entry.");
          return;
        }
        // Plain list of post URLs
        const lines = raw.replace(/\r/g, "").split("\n").map(s => s.trim()).filter(Boolean);
        if (!lines.length) {
          alert("Invalid post data file.");
          return;
        }
        const t = Date.now();
        o = { entries: {}, index: [] };
        lines.forEach((s) => {
          const id = getPostId(s);
          if (id) { o.entries[id] = t; o.index.push(id); }
        });
        if (o.index.length) askRestore(o);
        else alert("File doesn't contain any entry.");
      };
      r.readAsText(input.files[0]);
    };

    document.documentElement.appendChild(overlay);
    input.click();
  });
})();
