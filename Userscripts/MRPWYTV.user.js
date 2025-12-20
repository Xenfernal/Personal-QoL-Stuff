// ==UserScript==
// @name        Mark Read Posts & Watched YouTube Videos
// @namespace   https://github.com/Xenfernal
// @version     1.1
// @icon        https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @license     AGPL v3
// @author      Xen
// @description Add an indicator for Read Posts and Watched Videos on YouTube. Use GM menus to display history statistics, backup history, and restore/merge history. Based on the userscript by jcunews.
// @match       https://www.youtube.com/*
// @exclude     https://www.youtube.com/ad_frame*
// @exclude     https://www.youtube.com/ad_companion*
// @exclude     https://www.youtube.com/video_masthead*
// @exclude     https://www.youtube.com/ytscframe*
// @exclude     https://www.youtube.com/embed/*
// @exclude     https://www.youtube.com/live_chat*
// @exclude     https://www.youtube.com/live_chat_replay*
// @exclude     https://www.youtube.com/persist_identity*
// @exclude     https://www.youtube.com/redirect*
// @exclude     https://www.youtube.com/signin*
// @exclude     https://www.youtube.com/logout*
// @exclude     https://www.youtube.com/oops*
// @exclude     https://www.youtube.com/error*
// @exclude     https://www.youtube.com/account*
// @exclude     https://www.youtube.com/paid_memberships*
// @exclude     https://www.youtube.com/reporthistory*
// @exclude     https://www.youtube.com/t/terms*
// @exclude     https://www.youtube.com/t/privacy*
// @exclude     https://www.youtube.com/static*template=terms*
// @noframes
// @grant       GM_getValue
// @grant       GM_registerMenuCommand
// @grant       GM_setValue
// @grant       unsafeWindow
// @homepageURL https://github.com/Xenfernal/Personal-QoL-Stuff/tree/main/Userscripts
// @downloadURL https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/MRPWYTV.user.js
// @updateURL   https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/MRPWYTV.user.js
// @run-at      document-start
// ==/UserScript==

/*
- Use ALT+LeftClick or ALT+RightClick on a video list item to manually toggle the watched or read marker. The mouse button is defined in the script and can be changed.
- For restoring/merging history, source file can also be a YouTube's history data JSON (downloadable from https://support.google.com/accounts/answer/3024190?hl=en). Or a list of YouTube video URLs (using current time as timestamps).
*/

/* global trustedTypes */

(() => {
    // === config === //
    var maxWatchedVideoAge = 10 * 365; // number of days. set to zero to disable (not recommended)
    var maxReadPostAge = 10 * 365; // number of days for READ posts history. set to zero to disable pruning
    var contentLoadMarkDelay = 600; // number of milliseconds to wait before marking items on content load phase (increase if slow network/browser)
    var markerMouseButtons = [0, 1]; // one or more mouse buttons to use for manual marker toggle. 0=left, 1=right, 2=middle.

    var watchedVideos,
        readPosts,
        ageMultiplier = 24 * 60 * 60 * 1000,
        // also capture /live/<id>
        xu = /(?:\/watch(?:\?|.*?&)v=|\/embed\/)([^\/\?&]+)|\/shorts\/([^\/\?]+)|\/live\/([^\/\?]+)/,
        pu = /\/post\/([^\/\?&]+)/,
        querySelector = Element.prototype.querySelector,
        // tightened anchor selector for better hit-rates
        anchorSelector = 'a#thumbnail[href], a#video-title[href], a[href*="/watch?v="], a[href^="/shorts/"], a[href*="/embed/"], a[href^="/live/"]',
        // Community + Members posts renderers (LOCKED VIEW MODEL REMOVED)
        postRendererSelector = [
            'ytd-backstage-post-thread-renderer',
            'ytd-backstage-post-renderer',
            'ytd-post-renderer',
            'ytd-community-post-renderer',
            'ytd-sponsorships-post-renderer',
            'ytd-sponsorships-posts-renderer',
            'ytd-membership-post-renderer'
        ].join(', '),
        postLinkSelector = 'a[href^="/post/"], a[href*="/post/"]';

    // ===== SPA hardening (redundant triggers only; coalesced; does not replace existing triggers) ===== //
    var extraProcTimer = 0, extraProcDue = 0;
    function scheduleExtraProcess(delayMs) {
        var now = Date.now();
        var due = now + (delayMs || 0);
        if (!extraProcTimer) {
            extraProcDue = due;
            extraProcTimer = setTimeout(() => {
                extraProcTimer = 0; extraProcDue = 0;
                doProcessPage();
            }, delayMs || 0);
        } else if (due < extraProcDue) {
            clearTimeout(extraProcTimer);
            extraProcDue = due;
            extraProcTimer = setTimeout(() => {
                extraProcTimer = 0; extraProcDue = 0;
                doProcessPage();
            }, delayMs || 0);
        }
    }

    addEventListener("yt-navigate-start", () => scheduleExtraProcess(contentLoadMarkDelay), true);
    addEventListener("yt-navigate-finish", () => scheduleExtraProcess(Math.floor(contentLoadMarkDelay / 2)), true);
    addEventListener("yt-page-data-updated", () => scheduleExtraProcess(Math.floor(contentLoadMarkDelay / 2)), true);
    addEventListener("yt-page-data-fetched", () => scheduleExtraProcess(Math.floor(contentLoadMarkDelay / 2)), true);

    (function initHistoryFallback() {
        try {
            var ps = history.pushState, rs = history.replaceState;
            if (typeof ps === "function") {
                history.pushState = function () {
                    var r = ps.apply(this, arguments);
                    scheduleExtraProcess(contentLoadMarkDelay);
                    return r;
                };
            }
            if (typeof rs === "function") {
                history.replaceState = function () {
                    var r = rs.apply(this, arguments);
                    scheduleExtraProcess(contentLoadMarkDelay);
                    return r;
                };
            }
            addEventListener("popstate", () => scheduleExtraProcess(contentLoadMarkDelay), true);
        } catch (e) { /* ignore */ }
    })();

    var _mwyvMO = null, _mwyvMOInitT = 0;

    var _mwyvRelevantTags = {
        "YTD-RICH-ITEM-RENDERER": 1,
        "YTD-RICH-GRID-RENDERER": 1,
        "YTD-RICH-GRID-ROW": 1,
        "YTD-RICH-GRID-MEDIA": 1,
        "YTD-RICH-SHELF-RENDERER": 1,
        "YTD-GRID-RENDERER": 1,
        "YTD-VIDEO-RENDERER": 1,
        "YTD-COMPACT-VIDEO-RENDERER": 1,
        "YTD-COMPACT-RADIO-RENDERER": 1,
        "YT-LOCKUP-VIEW-MODEL": 1,
        "YT-LOCKUP-VIEW-MODEL-WIZ": 1,
        "YTD-PLAYLIST-VIDEO-RENDERER": 1,
        "YTD-PLAYLIST-PANEL-VIDEO-RENDERER": 1,
        "YTD-PLAYLIST-VIDEO-LIST-RENDERER": 1,
        "YTD-WATCH-NEXT-SECONDARY-RESULTS-RENDERER": 1,
        "YTD-ITEM-SECTION-RENDERER": 1,
        "YTD-SECTION-LIST-RENDERER": 1,
        "YTD-BROWSE": 1,
        "YTD-BACKSTAGE-POST-THREAD-RENDERER": 1,
        "YTD-BACKSTAGE-POST-RENDERER": 1,
        "YTD-POST-RENDERER": 1,
        "YTD-COMMUNITY-POST-RENDERER": 1,
        "YTD-SPONSORSHIPS-POST-RENDERER": 1,
        "YTD-SPONSORSHIPS-POSTS-RENDERER": 1,
        "YTD-MEMBERSHIP-POST-RENDERER": 1
    };

    function _mwyvNodeSeemsRelevant(n) {
        if (!n || n.nodeType !== 1) return false;
        var t = n.tagName;
        if (t && _mwyvRelevantTags[t]) return true;
        if (n.id === "contents" || n.id === "content" || n.id === "items") return true;
        return false;
    }

    function initSPAObserver() {
        if (_mwyvMO) return;

        var target =
            document.querySelector("ytd-page-manager") ||
            document.getElementById("page-manager") ||
            document.querySelector("ytd-app");

        if (!target) {
            clearTimeout(_mwyvMOInitT);
            _mwyvMOInitT = setTimeout(initSPAObserver, 250);
            return;
        }

        _mwyvMO = new MutationObserver((muts) => {
            for (var i = 0; i < muts.length; i++) {
                var m = muts[i];
                if (!m || !m.addedNodes || !m.addedNodes.length) continue;
                for (var j = 0; j < m.addedNodes.length; j++) {
                    if (_mwyvNodeSeemsRelevant(m.addedNodes[j])) {
                        scheduleExtraProcess(contentLoadMarkDelay);
                        return;
                    }
                }
            }
        });

        _mwyvMO.observe(target, { childList: true, subtree: true });
    }

    function getVideoId(url) {
        var vid = url.match(xu);
        if (vid) vid = vid[1] || vid[2] || vid[3];
        return vid;
    }

    function getPostId(url) {
        var m = url && url.match(pu);
        return m ? m[1] : null;
    }

    function watched(vid) {
        return !!watchedVideos.entries[vid];
    }

    function readPost(pid) {
        return !!readPosts.entries[pid];
    }

    function processVideoItems(selector) {
        var items, i, link;
        try { items = document.querySelectorAll(selector); } catch (e) { return; }
        for (i = items.length - 1; i >= 0; i--) {
            if ((link = items[i].querySelector(anchorSelector)) && link.href) {
                var v = getVideoId(link.href);
                if (v && watched(v)) items[i].classList.add("watched");
                else items[i].classList.remove("watched");
            }
        }
    }

    function getPostMarkElement(postRenderer) {
        return (postRenderer && postRenderer.closest && postRenderer.closest("ytd-rich-item-renderer")) || postRenderer;
    }

    function looksLikePostId(s) {
        return typeof s === "string" && s.length > 12 && s.startsWith("Ug");
    }

    function deepFindPostId(root, maxDepth, maxNodes) {
        try {
            if (!root || typeof root !== "object") return null;
            maxDepth = (maxDepth == null ? 4 : maxDepth);
            maxNodes = (maxNodes == null ? 250 : maxNodes);

            var stack = [{ v: root, d: 0 }];
            var seen = new Set();
            var nodes = 0;

            while (stack.length) {
                var cur = stack.pop();
                var v = cur.v;
                var d = cur.d;

                if (!v || typeof v !== "object") continue;
                if (seen.has(v)) continue;
                seen.add(v);

                if (++nodes > maxNodes) break;

                if (Array.isArray(v)) {
                    for (var i = v.length - 1; i >= 0; i--) {
                        var x = v[i];
                        if (looksLikePostId(x)) return x;
                        if (d < maxDepth && x && typeof x === "object") stack.push({ v: x, d: d + 1 });
                    }
                } else {
                    for (var k in v) {
                        var y = v[k];
                        if (looksLikePostId(y)) return y;
                        if (d < maxDepth && y && typeof y === "object") stack.push({ v: y, d: d + 1 });
                    }
                }
            }
        } catch (e) { }
        return null;
    }

    function extractPostIdFromData(d, i) {
        if (!d || typeof d !== "object") return null;

        i = d.postId || d.backstagePostId || d.communityPostId ||
            d.postEntityId || d.backstagePostEntityId || d.communityPostEntityId ||
            d.backstagePostEntityKey || d.postEntityKey;
        if (looksLikePostId(i)) return i;

        var a = d.post || d.backstagePost || d.communityPost || d.postData || d.backstagePostData;
        if (a && typeof a === "object") {
            i = a.postId || a.backstagePostId || a.communityPostId ||
                a.postEntityId || a.backstagePostEntityId || a.communityPostEntityId ||
                a.backstagePostEntityKey || a.postEntityKey;
            if (looksLikePostId(i)) return i;
        }

        i = deepFindPostId(d, 4, 250);
        if (looksLikePostId(i)) return i;

        return null;
    }

    function getPostIdFromDataHost(ele, i) {
        while (ele) {
            var data = ele.__data && ele.__data.data;
            if (data) {
                i = extractPostIdFromData(data);
                if (i) return i;
            }
            ele = ele.__dataHost || ele.parentNode;
        }
        return null;
    }

    function processPostItems(selector) {
        var posts, i, pr, markEl, link, pid;
        try { posts = document.querySelectorAll(selector); } catch (e) { return; }

        for (i = posts.length - 1; i >= 0; i--) {
            pr = posts[i];
            markEl = getPostMarkElement(pr);
            pid = null;

            // Always prefer /post/<id> when present (membership/community examples)
            if ((link = pr.querySelector(postLinkSelector)) && link.href) pid = getPostId(link.href);

            // If no anchor, try renderer data (still a canonical postId)
            if (!pid) pid = getPostIdFromDataHost(pr);

            if (pid && readPost(pid)) markEl.classList.add("read-post");
            else markEl.classList.remove("read-post");
        }
    }

    function processAllPostItems() {
        processPostItems(postRendererSelector);
    }

    function processAllVideoItems() {
        processVideoItems(`.yt-uix-shelfslider-list>.yt-shelf-grid-item`);
        processVideoItems(`
#contents.ytd-rich-grid-renderer>ytd-rich-item-renderer,
#contents.ytd-rich-shelf-renderer ytd-rich-item-renderer.ytd-rich-shelf-renderer,
#contents.ytd-rich-grid-renderer>ytd-rich-grid-row ytd-rich-grid-media`);
      processVideoItems(`.multirow-shelf>.shelf-content>.yt-shelf-grid-item`);
      processVideoItems(`ytd-section-list-renderer[page-subtype="history"] .ytd-item-section-renderer>ytd-video-renderer`);
      processVideoItems('yt-lockup-view-model');
      processVideoItems('.yt-lockup-view-model');
      processVideoItems(`
#contents>.ytd-item-section-renderer>.ytd-newspaper-renderer,
#items>.yt-horizontal-list-renderer`);
      processVideoItems(`
#contents>.ytd-channel-featured-content-renderer,
#contents>.ytd-shelf-renderer>#grid-container>.ytd-expanded-shelf-contents-renderer`);
      processVideoItems(`
.yt-uix-slider-list>.featured-content-item,
.channels-browse-content-grid>.channels-content-item,
#items>.ytd-grid-renderer,
#contents>.ytd-rich-grid-renderer`);
      processVideoItems(`ytd-rich-item-renderer ytd-rich-grid-slim-media`);

      processVideoItems(`.expanded-shelf>.expanded-shelf-content-list>.expanded-shelf-content-item-wrapper`);
      processVideoItems(`ytd-playlist-video-list-renderer ytd-playlist-video-renderer`);
      processVideoItems(`ytd-playlist-video-renderer`);
      processVideoItems(`ytd-playlist-video-list-renderer .yt-lockup-view-model`);

      processVideoItems(`
.pl-video-list .pl-video-table .pl-video,
ytd-playlist-panel-video-renderer`);
      if (/^\/(?:(?:c|channel|user)\/)?[^/]+\/search/.test(location.pathname)) {
          processVideoItems(`.ytd-browse #contents>.ytd-item-section-renderer`);
      }
      processVideoItems(`
#results>.section-list .item-section>li,
#browse-items-primary>.browse-list-item-container`);
      processVideoItems(`
.ytd-search #contents>ytd-video-renderer,
.ytd-search #contents>ytd-playlist-renderer,
.ytd-search #items>ytd-video-renderer`);
      processVideoItems(`
.watch-sidebar-body>.video-list>.video-list-item,
.playlist-videos-container>.playlist-videos-list>li`);
      processVideoItems(`
.ytd-compact-video-renderer,
.ytd-compact-radio-renderer,
ytd-watch-next-secondary-results-renderer .yt-lockup-view-model-wiz`);
  }

    function addHistory(vid, time, noSave, i) {
        if (!watchedVideos.entries[vid]) watchedVideos.index.push(vid);
        else {
            i = watchedVideos.index.indexOf(vid);
            if (i >= 0) watchedVideos.index.push(watchedVideos.index.splice(i, 1)[0]);
        }
        watchedVideos.entries[vid] = time;
        if (!noSave) GM_setValue("watchedVideos", JSON.stringify(watchedVideos));
    }

    function delHistory(index, noSave) {
        delete watchedVideos.entries[watchedVideos.index[index]];
        watchedVideos.index.splice(index, 1);
        if (!noSave) GM_setValue("watchedVideos", JSON.stringify(watchedVideos));
    }

    function addReadHistory(pid, time, noSave, i) {
        if (!readPosts.entries[pid]) readPosts.index.push(pid);
        else {
            i = readPosts.index.indexOf(pid);
            if (i >= 0) readPosts.index.push(readPosts.index.splice(i, 1)[0]);
        }
        readPosts.entries[pid] = time;
        if (!noSave) GM_setValue("readPosts", JSON.stringify(readPosts));
    }

    function delReadHistory(index, noSave) {
        delete readPosts.entries[readPosts.index[index]];
        readPosts.index.splice(index, 1);
        if (!noSave) GM_setValue("readPosts", JSON.stringify(readPosts));
    }

    var dc, ut;
    function parseData(s, a, z) {
        try {
            dc = false;
            s = JSON.parse(s);
            // old: [{id:<str>, timestamp:<num>}, ...]
            // new: {entries:{<id>:<num>, ...}, index:[<id>, ...]}
            if (Array.isArray(s) && (!s.length || ((typeof s[0] === 'object') && s[0].id && s[0].timestamp))) {
                a = s;
                s = { entries: {}, index: [] };
                a.forEach((o) => { s.entries[o.id] = o.timestamp; s.index.push(o.id); });
            } else if ((typeof s !== 'object') || (typeof s.entries !== 'object') || !Array.isArray(s.index)) return null;

            if (s.index.length !== (a = Object.keys(s.entries)).length) {
                s.index = a.map((k) => [k, s.entries[k]]).sort((x, y) => x[1] - y[1]).map((v) => v[0]);
                dc = true;
            }
            return s;
        } catch (z) { return null; }
    }

    function parseYouTubeData(s, a) {
        try {
            s = JSON.parse(s);
            // old: [{titleUrl:<url>, time:<iso>}, ...]
            // new: {entries:{<id>:<num>, ...}, index:[<id>, ...]}
            if (Array.isArray(s) && (!s.length || ((typeof s[0] === 'object') && s[0].titleUrl && s[0].time))) {
                a = s;
                s = { entries: {}, index: [] };
                a.forEach((o, m, t) => {
                    if (o.titleUrl && (m = o.titleUrl.match(xu))) {
                        if (isNaN((t = new Date(o.time).getTime()))) t = Date.now();
                        s.entries[m[1] || m[2] || m[3]] = t;
                        s.index.push(m[1] || m[2] || m[3]);
                    }
                });
                s.index.reverse();
                return s;
            } else return null;
        } catch (a) { return null; }
    }

    function mergeDataGeneric(target, source, a) {
        if (!target || !target.entries || !Array.isArray(target.index)) return;
        if (!source || !source.entries || !Array.isArray(source.index)) return;

        source.index.forEach((id) => {
            if (target.entries[id]) {
                if (target.entries[id] < source.entries[id]) target.entries[id] = source.entries[id];
            } else {
                target.entries[id] = source.entries[id];
            }
        });

        a = Object.keys(target.entries);
        target.index = a.map((k) => [k, target.entries[k]]).sort((x, y) => x[1] - y[1]).map((v) => v[0]);
    }

    function mergeData(o, a) { // legacy (videos)
        o.index.forEach((i) => {
            if (watchedVideos.entries[i]) {
                if (watchedVideos.entries[i] < o.entries[i]) watchedVideos.entries[i] = o.entries[i];
            } else watchedVideos.entries[i] = o.entries[i];
        });
        a = Object.keys(watchedVideos.entries);
        watchedVideos.index = a.map((k) => [k, watchedVideos.entries[k]]).sort((x, y) => x[1] - y[1]).map((v) => v[0]);
    }

    function getHistory(a, b) {
        a = GM_getValue("watchedVideos");
        if (a === undefined) a = '{"entries": {}, "index": []}';
        else if (typeof a === 'object') a = JSON.stringify(a);

        if ((b = parseData(a))) {
            watchedVideos = b;
            if (dc) b = JSON.stringify(b);
        } else b = JSON.stringify((watchedVideos = { entries: {}, index: [] }));

        GM_setValue("watchedVideos", b);
    }

    function getReadHistory(a, b) {
        a = GM_getValue("readPosts");
        if (a === undefined) a = '{"entries": {}, "index": []}';
        else if (typeof a === 'object') a = JSON.stringify(a);

        if ((b = parseData(a))) {
            readPosts = b;
            if (dc) b = JSON.stringify(b);
        } else b = JSON.stringify((readPosts = { entries: {}, index: [] }));

        GM_setValue("readPosts", b);
    }

    function doProcessPage() {
        getHistory();
        getReadHistory();

        var now = Date.now(), changed, vid;

        if (maxWatchedVideoAge > 0) {
            changed = false;
            while (watchedVideos.index.length) {
                if ((now - watchedVideos.entries[watchedVideos.index[0]]) / ageMultiplier > maxWatchedVideoAge) {
                    delHistory(0, false);
                    changed = true;
                } else break;
            }
            if (changed) GM_setValue("watchedVideos", JSON.stringify(watchedVideos));
        }

        if (maxReadPostAge > 0) {
            changed = false;
            while (readPosts.index.length) {
                if ((now - readPosts.entries[readPosts.index[0]]) / ageMultiplier > maxReadPostAge) {
                    delReadHistory(0, false);
                    changed = true;
                } else break;
            }
            if (changed) GM_setValue("readPosts", JSON.stringify(readPosts));
        }

        if ((vid = getVideoId(location.href)) && !watched(vid)) addHistory(vid, now);

        processAllVideoItems();
        processAllPostItems();
    }

    function processPage() {
        setTimeout(doProcessPage, Math.floor(contentLoadMarkDelay / 2));
    }

    function delayedProcessPage() {
        setTimeout(doProcessPage, contentLoadMarkDelay);
    }

    function toggleMarker(ele, i) {
        if (ele) {
            if (!ele.href && ele.closest) {
                var a = ele.closest(anchorSelector);
                if (a && a.href) ele = a;
            }
            if (ele && ele.href) i = getVideoId(ele.href);
            else {
                while (ele) {
                    while (ele && (!ele.__data || !ele.__data.data || !ele.__data.data.videoId)) ele = ele.__dataHost || ele.parentNode;
                    if (ele) { i = ele.__data.data.videoId; break; }
                }
            }
            if (i) {
                var idx = watchedVideos.index.indexOf(i);
                if (idx >= 0) delHistory(idx); else addHistory(i, Date.now());
                processAllVideoItems();
            }
        }
    }

    function findPostRendererFromTarget(ele) {
        return ele && ele.closest && ele.closest(postRendererSelector);
    }

    function toggleReadMarkerFromTarget(ele, pid, pr, link) {
        pr = findPostRendererFromTarget(ele);
        if (!pr) return false;

        if (!readPosts) getReadHistory();

        pid = null;

        // Prefer canonical /post/<id>
        if ((link = pr.querySelector(postLinkSelector)) && link.href) pid = getPostId(link.href);

        // Or canonical postId from renderer data
        if (!pid) pid = getPostIdFromDataHost(pr);

        // If we can’t derive a canonical ID, we intentionally do nothing (and do not attempt locked fallbacks).
        if (!pid) return true;

        var idx = readPosts.index.indexOf(pid);
        if (idx >= 0) delReadHistory(idx); else addReadHistory(pid, Date.now());
        processAllPostItems();
        return true;
    }

    // observe YouTube SPA data loads without using XHR.send
    var rxListUrl = /\/\w+_ajax\?|\/results\?search_query|\/v1\/(browse|next|search)\?/;
    var xhropen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        this.url_mwyv = url;
        if (rxListUrl.test(url) && !this.__mwyvHooked) {
            this.__mwyvHooked = 1;
            this.addEventListener('load', delayedProcessPage);
        }
        return xhropen.apply(this, arguments);
    };

    // realm-safe fetch wrapper
    var fetch_ = unsafeWindow.fetch;
    unsafeWindow.fetch = function (opt) {
        var url = (opt && opt.url) || opt;
        var p = fetch_.apply(unsafeWindow, arguments);
        if (rxListUrl.test(url)) return p.finally(delayedProcessPage);
        return p;
    };

    // style & event glue
    var to = { createHTML: (s) => s }, tp = window.trustedTypes?.createPolicy ? trustedTypes.createPolicy("", to) : to, html = (s) => tp.createHTML(s);

    addEventListener("DOMContentLoaded", (sty) => {
        sty = document.createElement("STYLE");
        sty.innerHTML = html(`
:root{
  --mwyv-ring:#34c759;--mwyv-overlay:rgba(52,199,89,.10);--mwyv-badge-bg:rgba(52,199,89,.95);--mwyv-badge-fg:#08110a;--mwyv-radius:12px;
  --mwyr-ring:#0a84ff;--mwyr-overlay:rgba(10,132,255,.10);--mwyr-badge-bg:rgba(10,132,255,.92);--mwyr-badge-fg:#06101a;--mwyr-radius:12px
}
html[dark]{
  --mwyv-ring:#2ecc71;--mwyv-overlay:rgba(46,204,113,.14);--mwyv-badge-bg:rgba(46,204,113,.92);--mwyv-badge-fg:#091410;
  --mwyr-ring:#3aa0ff;--mwyr-overlay:rgba(58,160,255,.14);--mwyr-badge-bg:rgba(58,160,255,.90);--mwyr-badge-fg:#06101a
}
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
.playlist-videos-container>.playlist-videos-list>li.watched,
.playlist-videos-container>.playlist-videos-list>li.watched>a{position:relative !important;background:transparent !important}
.playlist-videos-container>.playlist-videos-list>li.watched::before{content:"";position:absolute;inset:0;border-radius:10px;background:var(--mwyv-overlay);box-shadow:0 0 0 2px var(--mwyv-ring) inset}

.read-post{position:relative !important;border-radius:var(--mwyr-radius)}
.read-post::before{content:"";position:absolute;inset:0;border-radius:inherit;background:var(--mwyr-overlay);box-shadow:0 0 0 2px var(--mwyr-ring) inset,0 2px 12px rgba(0,0,0,.14);pointer-events:none}
.read-post::after{content:"READ";position:absolute;top:6px;left:6px;padding:2px 8px;border-radius:999px;background:var(--mwyr-badge-bg);color:var(--mwyr-badge-fg);font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;line-height:1;z-index:5;pointer-events:none}
`);
      document.head.appendChild(sty);

      var nde = Node.prototype.dispatchEvent;
      Node.prototype.dispatchEvent = function (ev) {
          if (ev.type === "yt-service-request-completed") {
              clearTimeout(ut);
              ut = setTimeout(doProcessPage, contentLoadMarkDelay / 2);
          }
          return nde.apply(this, arguments);
      };

      initSPAObserver();
  });

    var lastFocusState = document.hasFocus();
    addEventListener("blur", () => { lastFocusState = false; });
    addEventListener("focus", () => { if (!lastFocusState) processPage(); lastFocusState = true; });

    addEventListener("click", (ev) => {
        if (markerMouseButtons.indexOf(ev.button) >= 0 && ev.altKey) {
            if (toggleReadMarkerFromTarget(ev.target)) {
                ev.stopImmediatePropagation(); ev.stopPropagation(); ev.preventDefault();
                return;
            }
            ev.stopImmediatePropagation(); ev.stopPropagation(); ev.preventDefault();
            toggleMarker(ev.target);
        }
    }, true);

    if (markerMouseButtons.indexOf(1) >= 0) {
        addEventListener("contextmenu", (ev) => {
            if (ev.altKey) {
                if (!toggleReadMarkerFromTarget(ev.target)) toggleMarker(ev.target);
            }
        });
    }

    if (window["body-container"]) {
        addEventListener("spfdone", processPage);
        processPage();
    } else {
        var t = 0;
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

    // ===== Unified statistics ===== //
    function calcHistoryStats(dataObj) {
        function sum(r, v) { return r + v; }
        function avg(mapObj, cnt) {
            var vals = Object.values(mapObj || {});
            cnt = cnt || vals.length;
            return vals.length ? Math.round(vals.reduce(sum, 0) / cnt) : "(n/a)";
        }

        var out = {
            count: (dataObj && dataObj.index && dataObj.index.length) || 0,
            oldest: "(n/a)",
            newest: "(n/a)",
            span: "(n/a)",
            avgDay: "(n/a)",
            avgMonth: "(n/a)",
            avgYear: "(n/a)",
            bytes: dataObj ? JSON.stringify(dataObj).length : 0
        };

        if (!dataObj || !dataObj.entries || !out.count) return out;

        var t0 = Infinity, t1 = -Infinity, d0 = Infinity, d1 = -Infinity, ld = {};
        Object.keys(dataObj.entries).forEach((k, t, a) => {
            t = new Date(dataObj.entries[k]); a = t.getTime();
            if (a < t0) t0 = a; if (a > t1) t1 = a;
            a = Math.floor(a / 86400000);
            if (a < d0) d0 = a; if (a > d1) d1 = a;
            ld[a] = (ld[a] || 0) + 1;
        });

        var totalDays = (d1 - d0 + 1);
        var o0 = new Date(t0), o1 = new Date(t1);
        out.oldest = o0.toLocaleString();
        out.newest = o1.toLocaleString();

        var yy = o1.getFullYear() - o0.getFullYear();
        var mm = o1.getMonth() - o0.getMonth();
        if (mm < 0) { mm += 12; yy--; }
        var dd = o1.getDate() - o0.getDate();
        if (dd < 0) { dd += 30; if (--mm < 0) { mm += 12; yy--; } }

        out.span = `${yy} years ${mm} months ${dd} days (${totalDays} days total)`;
        out.avgDay = avg(ld, totalDays);
        out.avgMonth = avg(ld, totalDays / 30);
        out.avgYear = avg(ld, totalDays / 365);

        return out;
    }

    function formatStatsBlock(title, s) {
        return `\
${title}
Number of entries: ${s.count}
Oldest entry: ${s.oldest}
Newest entry: ${s.newest}
Time span: ${s.span}

Average per day: ${s.avgDay}
Average per month: ${s.avgMonth}
Average per year: ${s.avgYear}

History data size: ${s.bytes} bytes`;
  }

    GM_registerMenuCommand("Display Video History Statistics", () => {
        getHistory();
        var s = calcHistoryStats(watchedVideos);
        alert(formatStatsBlock("Watched Videos", s));
    });

    GM_registerMenuCommand("Display Post History Statistics", () => {
        getReadHistory();
        var s = calcHistoryStats(readPosts);
        alert(formatStatsBlock("Read Posts (Community + Members)", s));
    });

    // ===== Backup/Restore ===== //
    GM_registerMenuCommand("Backup History Data", (a) => {
        getHistory();
        getReadHistory();
        var bundle = { watchedVideos: watchedVideos, readPosts: readPosts };
        document.body.appendChild((a = document.createElement("A"))).href =
            URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: "application/json" }));
        a.download = `MarkWatchedYouTubeVideos_${new Date().toISOString()}.json`;
        a.click(); a.remove(); URL.revokeObjectURL(a.href);
    });

    GM_registerMenuCommand("Restore History Data", (a, b) => {
        function parseAnyData(x) {
            if (x == null) return null;
            if (typeof x === "string") return parseData(x);
            if (typeof x === "object") return parseData(JSON.stringify(x));
            return null;
        }

        function parseCombinedBundle(s) {
            try {
                var o = JSON.parse(s);
                if (!o || typeof o !== "object" || Array.isArray(o)) return null;
                var vw = parseAnyData(o.watchedVideos);
                var rp = parseAnyData(o.readPosts);
                if (!vw && !rp) return null;
                return { watchedVideos: vw, readPosts: rp };
            } catch (e) { return null; }
        }

        function askRestoreVideo(o) {
            const mergeEl = document.getElementById("mwyvrhm_ujs");
            if (confirm(`Selected history data file contains ${o.index.length} video entries.\n\nRestore from this data?`)) {
                if (mergeEl && mergeEl.checked) { mergeData(o); } else watchedVideos = o;
                GM_setValue("watchedVideos", JSON.stringify(watchedVideos));
                a.remove(); doProcessPage();
            }
        }

        function askRestoreBundle(bundle) {
            const mergeEl = document.getElementById("mwyvrhm_ujs");
            var vc = (bundle.watchedVideos && bundle.watchedVideos.index && bundle.watchedVideos.index.length) || 0;
            var pc = (bundle.readPosts && bundle.readPosts.index && bundle.readPosts.index.length) || 0;

            if (confirm(`Selected history data file contains ${vc} video entries and ${pc} post entries.\n\nRestore from this data?`)) {
                var doMerge = !!(mergeEl && mergeEl.checked);

                getHistory();
                getReadHistory();

                if (bundle.watchedVideos) {
                    if (doMerge) mergeDataGeneric(watchedVideos, bundle.watchedVideos);
                    else watchedVideos = bundle.watchedVideos;
                    GM_setValue("watchedVideos", JSON.stringify(watchedVideos));
                }

                if (bundle.readPosts) {
                    if (doMerge) mergeDataGeneric(readPosts, bundle.readPosts);
                    else readPosts = bundle.readPosts;
                    GM_setValue("readPosts", JSON.stringify(readPosts));
                }

                a.remove(); doProcessPage();
            }
        }

        if (document.getElementById("mwyvrh_ujs")) return;
        (a = document.createElement("DIV")).id = "mwyvrh_ujs";
        a.innerHTML = html(`<style>
#mwyvrh_ujs{display:flex;position:fixed;z-index:99999;left:0;top:0;right:0;bottom:0;margin:0;border:none;padding:0;background:rgb(0,0,0,0.5);color:#000;font-family:sans-serif;font-size:12pt;line-height:12pt;font-weight:normal;cursor:pointer}
#mwyvrhb_ujs{margin:auto;border:.3rem solid #007;border-radius:.3rem;padding:.5rem .5em;background-color:#fff;cursor:auto}
#mwyvrht_ujs{margin-bottom:1rem;font-size:14pt;line-height:14pt;font-weight:bold}
#mwyvrhmc_ujs{margin:.5em 0 1em 0;text-align:center}
#mwyvrhi_ujs{display:block;margin:1rem auto .5rem auto;overflow:hidden}
</style>
<div id="mwyvrhb_ujs">
  <div id="mwyvrht_ujs">Mark Watched YouTube Videos</div>
  Please select a file to restore history data from.
  <div id="mwyvrhmc_ujs"><label><input id="mwyvrhm_ujs" type="checkbox" checked /> Merge history data instead of replace.</label></div>
  <input id="mwyvrhi_ujs" type="file" multiple />
</div>`);
      a.onclick = (e) => { if (e.target === a) a.remove(); };
      (b = a.querySelector("#mwyvrhi_ujs")).onchange = (r) => {
          r = new FileReader();
          r.onload = (o, t) => {
              var txt = (r = r.result);

              getHistory();
              getReadHistory();

              if ((o = parseCombinedBundle(txt))) {
                  var vc = (o.watchedVideos && o.watchedVideos.index && o.watchedVideos.index.length) || 0;
                  var pc = (o.readPosts && o.readPosts.index && o.readPosts.index.length) || 0;
                  if (vc || pc) askRestoreBundle(o);
                  else alert("File doesn't contain any history entry.");
                  return;
              }

              if ((o = parseData(txt))) {
                  if (o.index.length) askRestoreVideo(o); else alert("File doesn't contain any history entry.");
                  return;
              }

              if ((o = parseYouTubeData(txt))) {
                  if (o.index.length) askRestoreVideo(o); else alert("File doesn't contain any history entry.");
                  return;
              }

              o = { entries: {}, index: [] }; t = Date.now(); txt = txt.replace(/\r/g, "").split("\n");
              while (txt.length && !txt[0].trim()) txt.shift();
              if (txt.length && xu.test(txt[0])) {
                  txt.forEach((s) => { if ((s = s.match(xu))) { o.entries[s[1] || s[2] || s[3]] = t; o.index.push(s[1] || s[2] || s[3]); } });
                  if (o.index.length) askRestoreVideo(o); else alert("File doesn't contain any history entry.");
              } else {
                  alert("Invalid history data file.");
              }
          };
          r.readAsText(b.files[0]);
      };
      document.documentElement.appendChild(a); b.click();
  });
})();
