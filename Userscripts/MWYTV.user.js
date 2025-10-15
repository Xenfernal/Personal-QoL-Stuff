// ==UserScript==
// @name        Mark Watched YouTube Videos
// @namespace   https://github.com/Xenfernal
// @version     1.0.3
// @icon        https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @license     AGPL v3
// @author      Xen
// @description Add an indicator for watched videos on YouTube. Use GM menus to display history statistics, backup history, and restore/merge history. Based on the userscript by jcunews.
// @match       *://www.youtube.com/*
// @grant       GM_getValue
// @grant       GM_registerMenuCommand
// @grant       GM_setValue
// @grant       unsafeWindow
// @homepageURL https://github.com/Xenfernal/Personal-QoL-Stuff/tree/main/Userscripts
// @downloadURL https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/MWYTV.user.js
// @updateURL   https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/MWYTV.user.js
// @run-at      document-start
// ==/UserScript==

/*
- Use ALT+LeftClick or ALT+RightClick on a video list item to manually toggle the watched marker. The mouse button is defined in the script and can be changed.
- For restoring/merging history, source file can also be a YouTube's history data JSON (downloadable from https://support.google.com/accounts/answer/3024190?hl=en). Or a list of YouTube video URLs (using current time as timestamps).
*/

(() => {
  //=== config start ===
  var maxWatchedVideoAge = 10 * 365; // number of days. set to zero to disable (not recommended)
  var contentLoadMarkDelay = 600; // number of milliseconds to wait before marking video items on content load phase (increase if slow network/browser)
  var markerMouseButtons = [0, 1]; // one or more mouse buttons to use for manual marker toggle. 0=left, 1=right, 2=middle.
  // if `[0]`, only left button is used, which is ALT+LeftClick.
  // if `[1]`, only right button is used, which is ALT+RightClick.
  // if `[0,1]`, any left or right button can be used, which is: ALT+LeftClick or ALT+RightClick.
  //=== config end ===

  var watchedVideos,
    ageMultiplier = 24 * 60 * 60 * 1000,
    // also capture /live/<id>
    xu = /(?:\/watch(?:\?|.*?&)v=|\/embed\/)([^\/\?&]+)|\/shorts\/([^\/\?]+)|\/live\/([^\/\?]+)/,
    querySelector = Element.prototype.querySelector,
    querySelectorAll = Element.prototype.querySelectorAll,
    // tightened anchor selector for better hit-rates
    anchorSelector = 'a#thumbnail[href], a#video-title[href], a[href*="/watch?v="], a[href^="/shorts/"], a[href*="/embed/"], a[href^="/live/"]';

  function getVideoId(url) {
    var vid = url.match(xu);
    if (vid) vid = vid[1] || vid[2] || vid[3];
    return vid;
  }

  function watched(vid) {
    return !!watchedVideos.entries[vid];
  }

  function processVideoItems(selector) {
    var items = document.querySelectorAll(selector), i, link;
    for (i = items.length - 1; i >= 0; i--) {
      if ((link = querySelector.call(items[i], anchorSelector)) && link.href) {
        var v = getVideoId(link.href);
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
    processVideoItems('yt-lockup-view-model');
    processVideoItems('.yt-lockup-view-model');
    // channel/user home page
    processVideoItems(`
#contents>.ytd-item-section-renderer>.ytd-newspaper-renderer,
#items>.yt-horizontal-list-renderer`); // old
    processVideoItems(`
#contents>.ytd-channel-featured-content-renderer,
#contents>.ytd-shelf-renderer>#grid-container>.ytd-expanded-shelf-contents-renderer`); // new
    // channel/user video page
    processVideoItems(`
.yt-uix-slider-list>.featured-content-item,
.channels-browse-content-grid>.channels-content-item,
#items>.ytd-grid-renderer,
#contents>.ytd-rich-grid-renderer`);
    // channel/user shorts page
    processVideoItems(`
ytd-rich-item-renderer ytd-rich-grid-slim-media`);
    // playlist pages (channel/user & system playlists like Liked videos)
    processVideoItems(`
/* old layout */
.expanded-shelf>.expanded-shelf-content-list>.expanded-shelf-content-item-wrapper,
/* modern playlist list */
ytd-playlist-video-list-renderer ytd-playlist-video-renderer,
/* fallback: tag-only */
ytd-playlist-video-renderer,
/* newest lockup-based playlist tiles */
ytd-playlist-video-list-renderer .yt-lockup-view-model
`);
    // channel/user playlist item page
    processVideoItems(`
.pl-video-list .pl-video-table .pl-video,
ytd-playlist-panel-video-renderer`);
    // channel/user search page (fixed regex)
    if (/^\/(?:(?:c|channel|user)\/)?[^/]+\/search/.test(location.pathname)) {
      processVideoItems(`.ytd-browse #contents>.ytd-item-section-renderer`); // new
    }
    // search page
    processVideoItems(`
#results>.section-list .item-section>li,
#browse-items-primary>.browse-list-item-container`); // old
    processVideoItems(`
.ytd-search #contents>ytd-video-renderer,
.ytd-search #contents>ytd-playlist-renderer,
.ytd-search #items>ytd-video-renderer`); // new
    // video page
    processVideoItems(`
.watch-sidebar-body>.video-list>.video-list-item,
.playlist-videos-container>.playlist-videos-list>li`); // old
    processVideoItems(`
.ytd-compact-video-renderer,
.ytd-compact-radio-renderer,
ytd-watch-next-secondary-results-renderer .yt-lockup-view-model-wiz`); // new
  }

  function addHistory(vid, time, noSave, i) {
    if (!watchedVideos.entries[vid]) {
      watchedVideos.index.push(vid);
    } else {
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

  var dc, ut;
  function parseData(s, a, i, j, z) {
    try {
      dc = false;
      s = JSON.parse(s);
      // convert to new format if old format.
      // old: [{id:<strVID>, timestamp:<numDate>}, ...]
      // new: {entries:{<stdVID>:<numDate>, ...}, index:[<strVID>, ...]}
      if (Array.isArray(s) && (!s.length || ((typeof s[0] === 'object') && s[0].id && s[0].timestamp))) {
        a = s;
        s = { entries: {}, index: [] };
        a.forEach((o) => {
          s.entries[o.id] = o.timestamp;
          s.index.push(o.id);
        });
      } else if ((typeof s !== 'object') || (typeof s.entries !== 'object') || !Array.isArray(s.index)) return null;
      // reconstruct index if broken
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
      // convert to native format if YouTube format.
      // old: [{titleUrl:<strUrl>, time:<strIsoDate>}, ...]
      // new: {entries:{<stdVID>:<numDate>, ...}, index:[<strVID>, ...]}
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

  function mergeData(o, a) {
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
    if (a === undefined) {
      a = '{"entries": {}, "index": []}';
    } else if (typeof a === 'object') a = JSON.stringify(a);
    if ((b = parseData(a))) {
      watchedVideos = b;
      if (dc) b = JSON.stringify(b);
    } else b = JSON.stringify((watchedVideos = { entries: {}, index: [] }));
    GM_setValue("watchedVideos", b);
  }

  function doProcessPage() {
    // get list of watched videos
    getHistory();

    // remove old watched video history
    var now = Date.now(), changed, vid;
    if (maxWatchedVideoAge > 0) {
      while (watchedVideos.index.length) {
        if ((now - watchedVideos.entries[watchedVideos.index[0]]) / ageMultiplier > maxWatchedVideoAge) {
          delHistory(0, false);
          changed = true;
        } else break;
      }
      if (changed) GM_setValue("watchedVideos", JSON.stringify(watchedVideos));
    }

    // check and remember current video
    if ((vid = getVideoId(location.href)) && !watched(vid)) addHistory(vid, now);

    // mark watched videos
    processAllVideoItems();
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
      if (ele && ele.href) {
        i = getVideoId(ele.href);
      } else {
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

  // observe YouTube SPA data loads without using XHR.send
  var rxListUrl = /\/\w+_ajax\?|\/results\?search_query|\/v1\/(browse|next|search)\?/;
  var xhropen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
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
:root{--mwyv-ring:#34c759;--mwyv-overlay:rgba(52,199,89,.10);--mwyv-badge-bg:rgba(52,199,89,.95);--mwyv-badge-fg:#08110a;--mwyv-radius:12px}
html[dark]{--mwyv-ring:#2ecc71;--mwyv-overlay:rgba(46,204,113,.14);--mwyv-badge-bg:rgba(46,204,113,.92);--mwyv-badge-fg:#091410}
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
  });

  var lastFocusState = document.hasFocus();
  addEventListener("blur", () => { lastFocusState = false; });
  addEventListener("focus", () => { if (!lastFocusState) processPage(); lastFocusState = true; });
  addEventListener("click", (ev) => {
    if (markerMouseButtons.indexOf(ev.button) >= 0 && ev.altKey) {
      ev.stopImmediatePropagation(); ev.stopPropagation(); ev.preventDefault();
      toggleMarker(ev.target);
    }
  }, true);

  if (markerMouseButtons.indexOf(1) >= 0) {
    addEventListener("contextmenu", (ev) => { if (ev.altKey) toggleMarker(ev.target); });
  }
  if (window["body-container"]) {
    addEventListener("spfdone", processPage); // old
    processPage();
  } else {
    var t = 0; // new
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

  GM_registerMenuCommand("Display History Statistics", () => {
    function sum(r, v) { return r + v; }
    function avg(arr, cnt) { arr = Object.values(arr); cnt = cnt || arr?.length; return arr?.length ? Math.round(arr.reduce(sum, 0) / cnt) : "(n/a)"; }
    var t0 = Infinity, t1 = -Infinity, d0 = Infinity, d1 = -Infinity, ld = {}, e0, e1, o0, o1, sp, ad, am, ay;
    getHistory();
    Object.keys(watchedVideos.entries).forEach((k, t, a) => {
      t = new Date(watchedVideos.entries[k]); a = t.getTime();
      if (a < t0) t0 = a; if (a > t1) t1 = a;
      a = Math.floor(a / 86400000); if (a < d0) d0 = a; if (a > d1) d1 = a; ld[a] = (ld[a] || 0) + 1;
    });
    d1 -= d0 - 1;
    if (watchedVideos.index.length) {
      e0 = (o0 = new Date(t0)).toLocaleString(); e1 = (o1 = new Date(t1)).toLocaleString();
      t1 = o1.getFullYear() - o0.getFullYear(); if ((t0 = o1.getMonth() - o0.getMonth()) < 0) { t0 += 12; t1--; }
      if ((d0 = o1.getDate() - o0.getDate()) < 0) { d0 += 30; if (--t0 < 0) { t0 += 12; t1--; } }
      sp = `${t1} years ${t0} months ${d0} days (${d1} days total)`; ad = avg(ld, d1); am = avg(ld, d1 / 30); ay = avg(ld, d1 / 365);
    } else e0 = e1 = sp = ad = am = ay = "(n/a)";
    alert(`\
Number of entries: ${watchedVideos.index.length}
Oldest entry: ${e0}
Newest entry: ${e1}
Time span: ${sp}

Average viewed videos per day: ${ad}
Average viewed videos per month: ${am}
Average viewed videos per year: ${ay}

History data size: ${JSON.stringify(watchedVideos).length} bytes\
`);
  });

  GM_registerMenuCommand("Backup History Data", (a, b) => {
    document.body.appendChild((a = document.createElement("A"))).href = URL.createObjectURL(new Blob([JSON.stringify(watchedVideos)], { type: "application/json" }));
    a.download = `MarkWatchedYouTubeVideos_${new Date().toISOString()}.json`;
    a.click(); a.remove(); URL.revokeObjectURL(a.href);
  });

  GM_registerMenuCommand("Restore History Data", (a, b) => {
    function askRestore(o) {
      const mergeEl = document.getElementById("mwyvrhm_ujs");
      if (confirm(`Selected history data file contains ${o.index.length} entries.\n\nRestore from this data?`)) {
        if (mergeEl && mergeEl.checked) { mergeData(o); } else watchedVideos = o;
        GM_setValue("watchedVideos", JSON.stringify(watchedVideos)); a.remove(); doProcessPage();
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
    (b = querySelector.call(a, "#mwyvrhi_ujs")).onchange = (r) => {
      r = new FileReader();
      r.onload = (o, t) => {
        if ((o = parseData((r = r.result)))) {
          if (o.index.length) askRestore(o); else alert("File doesn't contain any history entry.");
        } else if ((o = parseYouTubeData(r))) {
          if (o.index.length) askRestore(o); else alert("File doesn't contain any history entry.");
        } else {
          o = { entries: {}, index: [] }; t = Date.now(); r = r.replace(/\r/g, "").split("\n");
          while (r.length && !r[0].trim()) r.shift();
          if (r.length && xu.test(r[0])) {
            r.forEach((s) => { if ((s = s.match(xu))) { o.entries[s[1] || s[2] || s[3]] = t; o.index.push(s[1] || s[2] || s[3]); } });
            if (o.index.length) askRestore(o); else alert("File doesn't contain any history entry.");
          } else alert("Invalid history data file.");
        }
      };
      r.readAsText(b.files[0]);
    };
    document.documentElement.appendChild(a); b.click();
  });
})();
