// ==UserScript==
// @name         Auto-translate Japanese Tweets to English
// @namespace    https://github.com/Xenfernal
// @version      1.0
// @description  Simple but Robust JP->EN tweet translation with broad JP detection.
// @author       Xen
// @match        https://x.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=x.com
// @grant        GM.xmlHttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      translate.googleapis.com
// @run-at       document-idle
// @homepageURL  https://github.com/Xenfernal/Personal-QoL-Stuff/tree/main/Userscripts
// @downloadURL  https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/ATJTE.user.js
// @updateURL    https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/ATJTE.user.js
// @license      MIT
// ==/UserScript==

(() => {
  "use strict";

  /********************************************************************
   * Configuration
   ********************************************************************/
  const CFG = {
    targetLang: "en",

    // Coverage vs speed:
    // - "visible": force-process visible/near-visible tweetText nodes each scan (recommended)
    // - "all": force-process all tweetText nodes each scan (heavier)
    periodicScanMode: "visible",
    scanIntervalMs: 12000,
    scanViewportMarginPx: 1400,

    // Optional override: treat lang="ja" as eligibility hint (guarded)
    langJaOverride: true,

    // Efficiency controls
    useIntersectionObserver: true, // observe-once; unobserved after handled

    // Queue / retries / backoff
    minRequestDelayMs: 350,
    maxBackoffMs: 60000,
    maxAttemptsPerItem: 6,
    maxQueueLength: 800,
    maxTextLength: 4500,

    // After a "give up", don't immediately hammer the same node again.
    failureRetryCooldownMs: 60000,

    // Translate endpoint safety
    maxGetUrlLength: 1900,
    chunkGetUrlBuffer: 120,
    minChunkChars: 40,
    chunkBoundaryLookback: 220,
    chunkRequestDelayMs: 200,

    // Japanese detection (broad coverage)
    hanCountTranslateThreshold: 8,
    hanCountWithJpPunctThreshold: 4,
    shortHanMin: 2,
    shortTextMaxLen: 24,

    // Caching
    memCacheMaxEntries: 900,
    persistentCacheMaxEntries: 2200,      // flush-on-limit
    persistentCacheMaxChars: 2_700_000,   // rough JSON size proxy; flush-on-limit
    persistentSaveDebounceMs: 2500,

    // Styling
    boxBorderColour: "#7a2cff",
    boxBackground: "rgba(122,44,255,0.07)",

    // Debug
    logToConsole: true,
  };

  /********************************************************************
   * Persistent toggle
   ********************************************************************/
  const STORE_KEY_ENABLED = "jp_translate_enabled_v1";
  function getEnabled() {
    return (typeof GM_getValue === "function") ? (GM_getValue(STORE_KEY_ENABLED, true) !== false) : true;
  }
  function setEnabled(v) {
    if (typeof GM_setValue === "function") GM_setValue(STORE_KEY_ENABLED, !!v);
  }
  let ENABLED = getEnabled();

  /********************************************************************
   * Logging / stats
   ********************************************************************/
  const LOG_PREFIX = "[JP-TL]";
  const stats = {
    seen: 0,
    eligible: 0,
    enqueued: 0,
    translated: 0,
    cacheHitsMem: 0,
    cacheHitsPersistent: 0,
    errors: 0,
    rateLimited: 0,
    droppedQueue: 0,
    queuePruned: 0,
    usedPost: 0,
    postRejectedFallbackChunked: 0,
    chunkedRequests: 0,
    persistentFlushes: 0,
    persistentSaves: 0,
    scansSkippedOverlap: 0,
  };
  function log(...args) {
    if (!CFG.logToConsole) return;
    // eslint-disable-next-line no-console
    console.log(LOG_PREFIX, ...args);
  }

  /********************************************************************
   * GM xhr compatibility
   ********************************************************************/
  const gmXhr = (typeof GM !== "undefined" && GM && typeof GM.xmlHttpRequest === "function")
    ? GM.xmlHttpRequest.bind(GM)
    : (typeof GM_xmlhttpRequest === "function" ? GM_xmlhttpRequest : null);

  if (!gmXhr) {
    // eslint-disable-next-line no-console
    console.error(LOG_PREFIX, "No GM.xmlHttpRequest/GM_xmlhttpRequest available. Check Tampermonkey @grant.");
    return;
  }

  /********************************************************************
   * Robust Japanese detection (feature-detected to avoid parse-time hard failure)
   ********************************************************************/
  function buildJapaneseRegexes() {
    let supportsUnicodeProps = false;
    let supportsCodePointEscapes = false;

    try { new RegExp("\\p{Script=Han}", "u"); supportsUnicodeProps = true; } catch (_) {}
    try { new RegExp("[\\u{20000}-\\u{20001}]", "u"); supportsCodePointEscapes = true; } catch (_) {}

    let reKana;
    let reHanGlobal;

    if (supportsUnicodeProps) {
      reKana = new RegExp("[\\p{Script=Hiragana}\\p{Script=Katakana}]", "u");
      reHanGlobal = new RegExp("\\p{Script=Han}", "gu");
    } else {
      const kanaRanges = "[\\u3040-\\u309F\\u30A0-\\u30FF\\u31F0-\\u31FF\\uFF65-\\uFF9F]";
      reKana = new RegExp(kanaRanges, "u");

      let hanRanges = "[\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF";
      if (supportsCodePointEscapes) {
        hanRanges += "\\u{20000}-\\u{2A6DF}";
        hanRanges += "\\u{2A700}-\\u{2B73F}";
        hanRanges += "\\u{2B740}-\\u{2B81F}";
        hanRanges += "\\u{2B820}-\\u{2CEAF}";
        hanRanges += "\\u{2CEB0}-\\u{2EBEF}";
        hanRanges += "\\u{30000}-\\u{3134F}";
      }
      hanRanges += "]";
      reHanGlobal = new RegExp(hanRanges, "gu");
    }

    return { reKana, reHanGlobal, supportsUnicodeProps, supportsCodePointEscapes };
  }

  const JP_RX = buildJapaneseRegexes();
  const RE_KANA = JP_RX.reKana;
  const RE_HAN_G = JP_RX.reHanGlobal;

  const RE_JP_MARKS = /[々〆ヶヵーゝゞヽヾ]/u;
  const RE_JP_PUNCT = /[。、「」『』（）【】［］｛｝〈〉《》・]/u;
  const RE_LATIN = /[A-Za-z]/;
  const RE_NON_ASCII = /[^\x00-\x7F]/;
  const RE_FULLWIDTH_FORMS = /[\uFF01-\uFF60\uFFE0-\uFFEE]/u;

  function countHan(text) {
    const m = text.match(RE_HAN_G);
    return m ? m.length : 0;
  }

  function shouldTranslate(text) {
    if (!text) return false;
    const t = text.trim();
    if (t.length < 2) return false;

    if (RE_KANA.test(t)) return true;
    if (RE_JP_MARKS.test(t)) return true;

    const han = countHan(t);
    if (han >= CFG.hanCountTranslateThreshold) return true;
    if (han >= CFG.hanCountWithJpPunctThreshold && RE_JP_PUNCT.test(t)) return true;

    if (han >= CFG.shortHanMin && t.length <= CFG.shortTextMaxLen && !RE_LATIN.test(t)) return true;

    return false;
  }

  function hasLangJaHint(el) {
    if (!CFG.langJaOverride) return false;
    if (!el || !(el instanceof HTMLElement)) return false;

    const langEl = el.closest("[lang]") || el;
    const lang = (langEl && langEl.getAttribute) ? (langEl.getAttribute("lang") || "") : "";
    if (!lang) return false;
    return /^ja(\b|-)/i.test(lang) || /^ja$/i.test(lang);
  }

  function langJaOverrideEligible(text) {
    if (!text) return false;
    const t = text.trim();
    if (t.length < 2) return false;
    return RE_NON_ASCII.test(t) || RE_FULLWIDTH_FORMS.test(t) || RE_JP_PUNCT.test(t) || RE_JP_MARKS.test(t);
  }

  /********************************************************************
   * Text extraction (TreeWalker)
   ********************************************************************/
  const RE_WORD_CHAR = /[0-9A-Za-z]/;
  function extractTweetText(rootEl) {
    const parts = [];
    let lastChar = "";

    const walker = document.createTreeWalker(
      rootEl,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = /** @type {HTMLElement} */ (node);

            if (el.getAttribute && el.getAttribute("aria-hidden") === "true") {
              return NodeFilter.FILTER_REJECT;
            }

            const tag = el.tagName;
            if (tag === "SCRIPT" || tag === "STYLE") return NodeFilter.FILTER_REJECT;

            if (tag === "IMG" || tag === "BR") return NodeFilter.FILTER_ACCEPT;
            return NodeFilter.FILTER_SKIP;
          }

          if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
          return NodeFilter.FILTER_SKIP;
        }
      },
      false
    );

    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === Node.TEXT_NODE) {
        const v = n.nodeValue || "";
        if (!v) continue;

        const first = v[0] || "";
        if (lastChar && first && RE_WORD_CHAR.test(lastChar) && RE_WORD_CHAR.test(first)) {
          parts.push(" ");
          lastChar = " ";
        }

        parts.push(v);
        lastChar = v[v.length - 1] || lastChar;
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        const el = /** @type {HTMLElement} */ (n);
        if (el.tagName === "IMG") {
          const alt = el.getAttribute("alt");
          if (alt) {
            const first = alt[0] || "";
            if (lastChar && first && RE_WORD_CHAR.test(lastChar) && RE_WORD_CHAR.test(first)) {
              parts.push(" ");
              lastChar = " ";
            }
            parts.push(alt);
            lastChar = alt[alt.length - 1] || lastChar;
          }
        } else if (el.tagName === "BR") {
          parts.push("\n");
          lastChar = "\n";
        }
      }
    }

    let text = parts.join("");
    text = text.replace(/\r\n/g, "\n");
    text = text.replace(/[ \t]+/g, " ");
    text = text.replace(/ *\n */g, "\n");
    text = text.replace(/\n{3,}/g, "\n\n");
    text = text.trim();

    if (text.length > CFG.maxTextLength) text = text.slice(0, CFG.maxTextLength);
    return text;
  }

  /********************************************************************
   * Hashing (collision-hardened cache key)
   ********************************************************************/
  function fnv1a32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return ("00000000" + h.toString(16)).slice(-8);
  }
  function djb2_32(str) {
    let h = 5381 >>> 0;
    for (let i = 0; i < str.length; i++) h = (((h << 5) + h) + str.charCodeAt(i)) >>> 0;
    return ("00000000" + h.toString(16)).slice(-8);
  }
  function makeCacheKey(text) {
    const h1 = fnv1a32(text);
    const h2 = djb2_32(text);
    return `${h1}:${h2}:${text.length}`;
  }

  /********************************************************************
   * Cache: in-memory LRU + persistent GM storage with flush-on-limit
   ********************************************************************/
  const MEM_CACHE = new Map();

  const PERSIST_KEY = "jp_translate_persistent_cache_v1";
  let PERSIST = new Map();
  let persistApproxChars = 0;
  let persistDirty = false;
  let persistSaveTimer = null;

  function approxEntryChars(k, v) {
    return (k ? k.length : 0) + (v ? v.length : 0) + 16;
  }

  function memGet(key) {
    if (!MEM_CACHE.has(key)) return null;
    const val = MEM_CACHE.get(key);
    MEM_CACHE.delete(key);
    MEM_CACHE.set(key, val);
    return val;
  }
  function memSet(key, val) {
    if (MEM_CACHE.has(key)) MEM_CACHE.delete(key);
    MEM_CACHE.set(key, val);
    while (MEM_CACHE.size > CFG.memCacheMaxEntries) {
      const oldest = MEM_CACHE.keys().next().value;
      MEM_CACHE.delete(oldest);
    }
  }

  function persistLoad() {
    if (typeof GM_getValue !== "function") return;
    try {
      const raw = GM_getValue(PERSIST_KEY, null);
      if (!raw || typeof raw !== "string") return;

      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.entries)) return;

      const m = new Map();
      let chars = 0;

      for (const pair of parsed.entries) {
        if (!pair || pair.length !== 2) continue;
        const k = String(pair[0]);
        const v = String(pair[1]);
        m.set(k, v);
        chars += approxEntryChars(k, v);
      }

      while (m.size > CFG.persistentCacheMaxEntries) {
        const oldest = m.keys().next().value;
        const ov = m.get(oldest);
        chars -= approxEntryChars(oldest, ov);
        m.delete(oldest);
      }

      PERSIST = m;
      persistApproxChars = chars;
    } catch (_) {
      PERSIST = new Map();
      persistApproxChars = 0;
    }
  }

  function persistScheduleSave() {
    if (typeof GM_setValue !== "function") return;
    if (!persistDirty) return;
    if (persistSaveTimer) return;

    persistSaveTimer = setTimeout(() => {
      persistSaveTimer = null;
      if (!persistDirty) return;
      persistDirty = false;

      try {
        const entries = Array.from(PERSIST.entries());
        const payload = JSON.stringify({ v: 1, t: Date.now(), entries });
        GM_setValue(PERSIST_KEY, payload);
        stats.persistentSaves++;
      } catch (_) {
        persistFlush();
      }
    }, CFG.persistentSaveDebounceMs);
  }

  function persistFlush() {
    PERSIST.clear();
    persistApproxChars = 0;
    persistDirty = true;
    stats.persistentFlushes++;
    persistScheduleSave();
  }

  function persistGet(key) {
    return PERSIST.has(key) ? PERSIST.get(key) : null;
  }

  function persistSet(key, val) {
    if (!key || typeof val !== "string") return;

    const addChars = approxEntryChars(key, val);
    if (addChars > CFG.persistentCacheMaxChars) return;

    if (PERSIST.has(key)) {
      const old = PERSIST.get(key);
      persistApproxChars -= approxEntryChars(key, old);
      PERSIST.delete(key);
    }

    const wouldChars = persistApproxChars + addChars;
    const wouldEntries = PERSIST.size + 1;

    if (wouldEntries > CFG.persistentCacheMaxEntries || wouldChars > CFG.persistentCacheMaxChars) {
      persistFlush();
    }

    PERSIST.set(key, val);
    persistApproxChars += addChars;
    persistDirty = true;
    persistScheduleSave();
  }

  function cacheClearAll() {
    MEM_CACHE.clear();
    persistFlush();
  }

  window.addEventListener("beforeunload", () => {
    try {
      if (!persistDirty || typeof GM_setValue !== "function") return;
      const entries = Array.from(PERSIST.entries());
      const payload = JSON.stringify({ v: 1, t: Date.now(), entries });
      GM_setValue(PERSIST_KEY, payload);
      stats.persistentSaves++;
      persistDirty = false;
    } catch (_) {}
  });

  /********************************************************************
   * Safe UI injection + per-element state
   ********************************************************************/
  const elementLastKey = new WeakMap();          // tweetText -> cacheKey
  const elementEligibleDecision = new WeakMap(); // tweetText -> boolean eligibility for elementLastKey
  const elementFailedUntil = new WeakMap();      // tweetText -> epoch ms (cooldown until retry)

  const elementBox = new WeakMap();              // tweetText -> translation box element
  const elementBoxState = new WeakMap();         // tweetText -> "ok" | "status"
  const elementPendingKey = new WeakMap();       // tweetText -> cacheKey queued/in-flight
  const elementObserver = new WeakMap();         // tweetText -> MutationObserver

  const ioObserved = new WeakMap();              // tweetText -> boolean
  let intersectionObserver = null;

  function removeBox(tweetTextEl) {
    const box = elementBox.get(tweetTextEl);
    if (box && box.isConnected) {
      try { box.remove(); } catch (_) {}
    }
    elementBox.delete(tweetTextEl);
    elementBoxState.delete(tweetTextEl);
  }

  function disconnectElementObserver(tweetTextEl) {
    const mo = elementObserver.get(tweetTextEl);
    if (mo) {
      try { mo.disconnect(); } catch (_) {}
      elementObserver.delete(tweetTextEl);
    }
  }

  function unobserveIfObserved(tweetTextEl) {
    if (!intersectionObserver) return;
    if (!ioObserved.get(tweetTextEl)) return;
    try { intersectionObserver.unobserve(tweetTextEl); } catch (_) {}
    ioObserved.set(tweetTextEl, false);
  }

  function cleanupElement(tweetTextEl) {
    disconnectElementObserver(tweetTextEl);
    removeBox(tweetTextEl);
    elementPendingKey.delete(tweetTextEl);

    elementLastKey.delete(tweetTextEl);
    elementEligibleDecision.delete(tweetTextEl);
    elementFailedUntil.delete(tweetTextEl);

    unobserveIfObserved(tweetTextEl);
  }

  function getOrCreateBox(tweetTextEl) {
    let box = elementBox.get(tweetTextEl);
    if (box && box.isConnected) return box;

    box = document.createElement("div");
    box.setAttribute("data-jp-translation", "1");
    box.style.display = "block";
    box.style.marginTop = "0.45rem";
    box.style.padding = "0.55rem 0.6rem";
    box.style.borderLeft = `5px solid ${CFG.boxBorderColour}`;
    box.style.background = CFG.boxBackground;
    box.style.borderRadius = "8px";
    box.style.fontSize = "0.92em";
    box.style.lineHeight = "1.35";
    box.style.wordBreak = "break-word";

    const header = document.createElement("div");
    header.setAttribute("data-jp-translation-header", "1");
    header.style.fontWeight = "600";
    header.style.marginBottom = "0.35rem";
    header.textContent = "Translation (EN)";

    const body = document.createElement("div");
    body.setAttribute("data-jp-translation-body", "1");

    box.appendChild(header);
    box.appendChild(body);

    tweetTextEl.insertAdjacentElement("afterend", box);
    elementBox.set(tweetTextEl, box);
    return box;
  }

  function setBoxStatus(tweetTextEl, statusText) {
    const box = getOrCreateBox(tweetTextEl);
    const body = box.querySelector("[data-jp-translation-body='1']");
    if (body) body.textContent = statusText;
    elementBoxState.set(tweetTextEl, "status");
  }

  function setBoxTranslation(tweetTextEl, translationText) {
    const box = getOrCreateBox(tweetTextEl);
    const body = box.querySelector("[data-jp-translation-body='1']");
    if (!body) return;

    body.textContent = "";
    const lines = (translationText || "").split(/\n+/).map(s => s.trim()).filter(Boolean);
    if (!lines.length) {
      body.textContent = (translationText || "").trim() || "(empty translation)";
      elementBoxState.set(tweetTextEl, "ok");
      return;
    }

    for (const line of lines) {
      const row = document.createElement("div");
      row.style.fontWeight = "600";
      row.textContent = line;
      body.appendChild(row);
    }
    elementBoxState.set(tweetTextEl, "ok");
  }

  /********************************************************************
   * Queue (FIFO with cap) + pruning
   ********************************************************************/
  const queue = [];
  let qHead = 0;

  function queueSize() {
    return queue.length - qHead;
  }

  function clearPendingIfMatches(el, key) {
    if (!el || (typeof el !== "object" && typeof el !== "function")) return;
    const pending = elementPendingKey.get(el);
    if (pending === key) elementPendingKey.delete(el);
  }

  // Conservative pending clear helpers
  function hasQueuedItem(el, key) {
    for (let i = qHead; i < queue.length; i++) {
      const it = queue[i];
      if (it && it.el === el && it.key === key) return true;
    }
    return false;
  }
  function clearPendingIfMatchesIfNoQueued(el, key) {
    if (!el || (typeof el !== "object" && typeof el !== "function")) return;
    const pending = elementPendingKey.get(el);
    if (pending !== key) return;
    if (hasQueuedItem(el, key)) return;
    elementPendingKey.delete(el);
  }

  function dropOldestTasks(n) {
    for (let i = 0; i < n; i++) {
      if (qHead >= queue.length) break;
      const item = queue[qHead++];
      if (item && item.el) clearPendingIfMatchesIfNoQueued(item.el, item.key);
      stats.droppedQueue++;
    }
    if (qHead > 200 && qHead > queue.length / 2) {
      queue.splice(0, qHead);
      qHead = 0;
    }
  }

  function pruneQueueInvalid() {
    const size = queueSize();
    if (size <= 0) return;

    const kept = [];
    const removedForPendingCheck = [];

    for (let i = qHead; i < queue.length; i++) {
      const it = queue[i];
      if (!it || !it.el || !it.el.isConnected) {
        if (it && it.el) removedForPendingCheck.push({ el: it.el, key: it.key });
        stats.queuePruned++;
        continue;
      }
      if (elementLastKey.get(it.el) !== it.key) {
        removedForPendingCheck.push({ el: it.el, key: it.key });
        stats.queuePruned++;
        continue;
      }
      kept.push(it);
    }

    queue.length = 0;
    qHead = 0;
    if (kept.length) queue.push(...kept);

    for (const r of removedForPendingCheck) {
      clearPendingIfMatchesIfNoQueued(r.el, r.key);
    }
  }

  function enqueue(tweetTextEl, text, key) {
    const pending = elementPendingKey.get(tweetTextEl);
    if (pending === key) return;

    const size = queueSize();
    if (size >= CFG.maxQueueLength) {
      dropOldestTasks((size - CFG.maxQueueLength) + 1);
    }

    elementPendingKey.set(tweetTextEl, key);
    queue.push({ el: tweetTextEl, text, key, attempts: 0 });
    stats.enqueued++;
    pump();
  }

  // Capped retry requeue (preserves attempts)
  function requeueWithCap(item) {
    if (!item || !item.el) return;

    if (!item.el.isConnected) {
      // v-6 PATCH: conservative clear (duplicates may still exist)
      clearPendingIfMatchesIfNoQueued(item.el, item.key);
      return;
    }
    if (elementLastKey.get(item.el) !== item.key) {
      // v-6 PATCH: conservative clear (duplicates may still exist)
      clearPendingIfMatchesIfNoQueued(item.el, item.key);
      return;
    }

    const size = queueSize();
    if (size >= CFG.maxQueueLength) {
      dropOldestTasks((size - CFG.maxQueueLength) + 1);
    }

    // Re-assert pending key defensively (idempotent)
    elementPendingKey.set(item.el, item.key);

    queue.push(item);
  }

  function dequeue() {
    if (qHead >= queue.length) {
      queue.length = 0;
      qHead = 0;
      return null;
    }
    const item = queue[qHead++];
    if (qHead > 200 && qHead > queue.length / 2) {
      queue.splice(0, qHead);
      qHead = 0;
    }
    return item;
  }

  /********************************************************************
   * Rate-limit aware sender (single-flight) with exponential backoff
   ********************************************************************/
  let inFlight = false;
  let backoffMs = 0;
  let nextAllowedAt = 0;
  let pumpScheduled = false;

  function schedulePump(delayMs) {
    if (pumpScheduled) return;
    pumpScheduled = true;
    setTimeout(() => {
      pumpScheduled = false;
      pump();
    }, Math.max(0, delayMs));
  }

  function pump() {
    if (!ENABLED) return;
    if (inFlight) return;

    const now = Date.now();
    if (now < nextAllowedAt) {
      schedulePump(nextAllowedAt - now);
      return;
    }

    const item = dequeue();
    if (!item) return;

    const { el, text, key } = item;

    if (!el || !el.isConnected) {
      // v-6 PATCH: conservative clear (duplicates may still exist)
      clearPendingIfMatchesIfNoQueued(el, key);
      return;
    }

    if (elementLastKey.get(el) !== key) {
      // v-6 PATCH: conservative clear (duplicates may still exist)
      clearPendingIfMatchesIfNoQueued(el, key);
      return;
    }

    const mem = memGet(key);
    if (mem) {
      stats.cacheHitsMem++;
      // v-6 PATCH: conservative clear (duplicates may still exist)
      clearPendingIfMatchesIfNoQueued(el, key);
      setBoxTranslation(el, mem);
      stats.translated++;
      nextAllowedAt = Date.now() + 50;
      schedulePump(10);
      return;
    }

    const persisted = persistGet(key);
    if (persisted) {
      stats.cacheHitsPersistent++;
      memSet(key, persisted);
      // v-6 PATCH: conservative clear (duplicates may still exist)
      clearPendingIfMatchesIfNoQueued(el, key);
      setBoxTranslation(el, persisted);
      stats.translated++;
      nextAllowedAt = Date.now() + 50;
      schedulePump(10);
      return;
    }

    setBoxStatus(el, "Translating…");

    inFlight = true;
    translateViaGoogle(text, CFG.targetLang)
      .then((translatedText) => {
        inFlight = false;
        // v-6 PATCH: conservative clear (duplicates may still exist)
        clearPendingIfMatchesIfNoQueued(el, key);

        if (!el.isConnected) return;
        if (elementLastKey.get(el) !== key) return;

        memSet(key, translatedText);
        persistSet(key, translatedText);

        setBoxTranslation(el, translatedText);
        stats.translated++;

        elementFailedUntil.delete(el);

        backoffMs = 0;
        nextAllowedAt = Date.now() + CFG.minRequestDelayMs;
        schedulePump(CFG.minRequestDelayMs);
      })
      .catch((err) => {
        inFlight = false;

        const msg = (err && err.message) ? err.message : String(err || "unknown error");
        stats.errors++;

        if (!el.isConnected || elementLastKey.get(el) !== key) {
          // v-6 PATCH: conservative clear (duplicates may still exist)
          clearPendingIfMatchesIfNoQueued(el, key);
          return;
        }

        item.attempts = (item.attempts || 0) + 1;
        if (item.attempts > CFG.maxAttemptsPerItem) {
          // v-6 PATCH: conservative clear (duplicates may still exist)
          clearPendingIfMatchesIfNoQueued(el, key);

          elementFailedUntil.set(el, Date.now() + CFG.failureRetryCooldownMs);
          setBoxStatus(el, "Translation failed (gave up for now; will retry later).");
          return;
        }

        if (msg.includes("RATELIMIT")) {
          stats.rateLimited++;
          setBoxStatus(el, "Rate limited by Google. Will retry automatically.");
        } else {
          setBoxStatus(el, "Translation failed. Will retry automatically.");
        }

        backoffMs = backoffMs ? Math.min(CFG.maxBackoffMs, backoffMs * 2) : 1200;
        const jitter = Math.floor(Math.random() * 400);
        nextAllowedAt = Date.now() + backoffMs + jitter;

        requeueWithCap(item);
        schedulePump(backoffMs + jitter);
      });
  }

  /********************************************************************
   * Translate: GET with POST fallback; chunked GET fallback if POST rejected
   ********************************************************************/
  function isPostRejectionCode(code) {
    return code === 400 || code === 405 || code === 411 || code === 413 || code === 414 || code === 415;
  }

  function xhrTranslateOnce({ method, url, headers, data }) {
    return new Promise((resolve, reject) => {
      const opts = {
        method,
        url,
        headers: headers || { "Accept": "application/json,text/plain,*/*" },
        timeout: 30000,
        onload: (res) => {
          try {
            const status = res.status || 0;
            const body = res.responseText || "";

            if (status === 429) {
              reject(new Error("RATELIMIT: HTTP 429"));
              return;
            }
            if (status < 200 || status >= 300) {
              const e = new Error(`HTTP_${status || "ERR"}`);
              e.code = status;
              e.body = body;
              reject(e);
              return;
            }

            let parsed;
            try {
              parsed = JSON.parse(body);
            } catch (_) {
              const e = new Error("PARSE_ERROR");
              e.code = "PARSE_ERROR";
              reject(e);
              return;
            }

            if (parsed && Array.isArray(parsed.sentences)) {
              const translated = parsed.sentences.map(s => (s && s.trans) ? s.trans : "").join("");
              resolve(normaliseTranslatedText(translated));
              return;
            }

            if (Array.isArray(parsed) && Array.isArray(parsed[0])) {
              const translated = parsed[0].map(x => (x && x[0]) ? x[0] : "").join("");
              resolve(normaliseTranslatedText(translated));
              return;
            }

            const e = new Error("UNEXPECTED_RESPONSE");
            e.code = "UNEXPECTED_RESPONSE";
            reject(e);
          } catch (e) {
            reject(e);
          }
        },
        onerror: () => reject(new Error("NETWORK_ERROR")),
        ontimeout: () => reject(new Error("TIMEOUT")),
      };

      if (typeof data === "string") opts.data = data;
      gmXhr(opts);
    });
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function waitForGlobalPacing() {
    const now = Date.now();
    if (now < nextAllowedAt) await sleep(nextAllowedAt - now);
  }

  async function chunkTranslateViaGet(text, baseParams) {
    const chunks = splitTextForGet(text, baseParams, CFG.maxGetUrlLength - CFG.chunkGetUrlBuffer);

    let acc = "";
    for (let idx = 0; idx < chunks.length; idx++) {
      const part = chunks[idx];

      if (idx > 0) await sleep(CFG.chunkRequestDelayMs);
      await waitForGlobalPacing();

      stats.chunkedRequests++;

      const qParam = `q=${encodeURIComponent(part.chunk)}`;
      const url = `https://translate.googleapis.com/translate_a/single?${baseParams}&${qParam}`;

      const translated = await xhrTranslateOnce({
        method: "GET",
        url,
        headers: { "Accept": "application/json,text/plain,*/*" }
      });

      nextAllowedAt = Date.now() + CFG.minRequestDelayMs;

      acc += translated;

      if (part.joiner) {
        const joiner = part.joiner;
        if (!((joiner === " " && acc.endsWith(" ")) || (joiner === "\n" && acc.endsWith("\n")))) {
          acc += joiner;
        }
      }
    }

    return normaliseTranslatedText(acc);
  }

  function splitTextForGet(text, baseParams, maxUrlLen) {
    const baseUrlPrefix = `https://translate.googleapis.com/translate_a/single?${baseParams}&q=`;
    const out = [];
    let i = 0;

    while (i < text.length) {
      let lo = i + 1;
      let hi = text.length;

      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const candidate = text.slice(i, mid);
        const urlLen = baseUrlPrefix.length + encodeURIComponent(candidate).length;
        if (urlLen <= maxUrlLen) lo = mid;
        else hi = mid - 1;
      }

      let end = lo;
      if (end <= i) end = Math.min(text.length, i + 1);

      const delimiters = [
        ["\n\n", "\n"],
        ["\n", "\n"],
        ["。", " "],
        ["！", " "],
        ["？", " "],
        [". ", " "],
        ["! ", " "],
        ["? ", " "],
        [", ", " "],
        ["、", " "],
        [" ", " "],
      ];

      const windowStart = Math.max(i, end - CFG.chunkBoundaryLookback);
      const windowText = text.slice(windowStart, end);

      let bestCut = null;
      for (const [delim, joiner] of delimiters) {
        const idx = windowText.lastIndexOf(delim);
        if (idx < 0) continue;

        const cutEnd = windowStart + idx + delim.length;
        if ((cutEnd - i) < CFG.minChunkChars) continue;

        if (!bestCut || cutEnd > bestCut.cutEnd) bestCut = { cutEnd, joiner };
      }

      let joiner = " ";
      if (bestCut) {
        end = bestCut.cutEnd;
        joiner = bestCut.joiner;
      } else {
        const probe = text.slice(i, end);
        joiner = probe.endsWith("\n") ? "\n" : " ";
      }

      let chunk = text.slice(i, end);
      chunk = chunk.replace(/[ \t]+$/g, "");

      i = end;

      if (chunk.trim().length) out.push({ chunk, joiner });
    }

    if (out.length) out[out.length - 1].joiner = "";
    return out;
  }

  function normaliseTranslatedText(t) {
    let s = (t || "").replace(/\r\n/g, "\n");
    s = s.replace(/\n{3,}/g, "\n\n");
    return s.trim();
  }

  function translateViaGoogle(text, tl) {
    return new Promise((resolve, reject) => {
      const baseParams = `client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&dj=1`;
      const qParam = `q=${encodeURIComponent(text)}`;

      const getUrl = `https://translate.googleapis.com/translate_a/single?${baseParams}&${qParam}`;
      const usePost = (getUrl.length > CFG.maxGetUrlLength);

      if (!usePost) {
        xhrTranslateOnce({
          method: "GET",
          url: getUrl,
          headers: { "Accept": "application/json,text/plain,*/*" }
        }).then(resolve).catch(reject);
        return;
      }

      stats.usedPost++;

      xhrTranslateOnce({
        method: "POST",
        url: `https://translate.googleapis.com/translate_a/single?${baseParams}`,
        headers: {
          "Accept": "application/json,text/plain,*/*",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
        },
        data: qParam
      }).then(resolve).catch((err) => {
        const postRejected = (err && err.code && isPostRejectionCode(err.code));
        const unexpected = (err && err.code === "UNEXPECTED_RESPONSE");

        if (postRejected || unexpected) {
          stats.postRejectedFallbackChunked++;
          chunkTranslateViaGet(text, baseParams).then(resolve).catch(reject);
          return;
        }
        reject(err);
      });
    });
  }

  /********************************************************************
   * Observing tweet nodes efficiently
   ********************************************************************/
  const TWEET_TEXT_SELECTOR = "[data-testid='tweetText']";
  const elementDebounceAt = new WeakMap();

  function ensureElementObserver(tweetTextEl) {
    if (elementObserver.has(tweetTextEl)) return;

    const mo = new MutationObserver(() => {
      const now = Date.now();
      const prev = elementDebounceAt.get(tweetTextEl) || 0;
      if (now - prev < 250) return;
      elementDebounceAt.set(tweetTextEl, now);

      if (!tweetTextEl.isConnected) return;
      processTweetTextEl(tweetTextEl);
    });

    mo.observe(tweetTextEl, { childList: true, subtree: true, characterData: true });
    elementObserver.set(tweetTextEl, mo);
  }

  function isHandledEl(el) {
    const box = elementBox.get(el);
    return elementObserver.has(el) || elementPendingKey.has(el) || (box && box.isConnected);
  }

  function maybeUnobserveAfterHandled(el) {
    if (!intersectionObserver) return;
    if (!ioObserved.get(el)) return;
    if (!isHandledEl(el)) return;
    unobserveIfObserved(el);
  }

  function processTweetTextEl(tweetTextEl) {
    if (!tweetTextEl || !(tweetTextEl instanceof HTMLElement)) return;
    if (!tweetTextEl.isConnected) return;

    stats.seen++;

    const text = extractTweetText(tweetTextEl);
    const key = makeCacheKey(text);

    const lastKey = elementLastKey.get(tweetTextEl);
    const pendingKey = elementPendingKey.get(tweetTextEl);
    const box = elementBox.get(tweetTextEl);
    const boxState = elementBoxState.get(tweetTextEl) || null;
    const decision = elementEligibleDecision.get(tweetTextEl);
    const failedUntil = elementFailedUntil.get(tweetTextEl) || 0;
    const now = Date.now();

    if (lastKey === key) {
      if (pendingKey === key) return;
      if (box && box.isConnected && boxState === "ok") return;
      if (failedUntil && now < failedUntil) return;
      if (decision === false) return;
    } else {
      if (lastKey) {
        clearPendingIfMatches(tweetTextEl, lastKey);
        elementFailedUntil.delete(tweetTextEl);
      }
    }

    elementLastKey.set(tweetTextEl, key);

    let eligible = false;
    if (lastKey === key && decision === true) {
      eligible = true;
    } else {
      const langHint = hasLangJaHint(tweetTextEl);
      eligible = shouldTranslate(text) || (langHint && langJaOverrideEligible(text));
      elementEligibleDecision.set(tweetTextEl, eligible);
    }

    if (!eligible) {
      removeBox(tweetTextEl);
      disconnectElementObserver(tweetTextEl);
      clearPendingIfMatches(tweetTextEl, key);
      unobserveIfObserved(tweetTextEl);
      return;
    }

    stats.eligible++;

    const mem = memGet(key);
    if (mem) {
      stats.cacheHitsMem++;
      setBoxTranslation(tweetTextEl, mem);
      stats.translated++;
      ensureElementObserver(tweetTextEl);
      maybeUnobserveAfterHandled(tweetTextEl);
      return;
    }

    const persisted = persistGet(key);
    if (persisted) {
      stats.cacheHitsPersistent++;
      memSet(key, persisted);
      setBoxTranslation(tweetTextEl, persisted);
      stats.translated++;
      ensureElementObserver(tweetTextEl);
      maybeUnobserveAfterHandled(tweetTextEl);
      return;
    }

    ensureElementObserver(tweetTextEl);

    if (failedUntil && now >= failedUntil) {
      elementFailedUntil.delete(tweetTextEl);
    }

    enqueue(tweetTextEl, text, key);
    maybeUnobserveAfterHandled(tweetTextEl);
  }

  function initIntersectionObserver() {
    if (!CFG.useIntersectionObserver || typeof IntersectionObserver === "undefined") return null;

    return new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = /** @type {HTMLElement} */ (e.target);
        processTweetTextEl(el);
      }
    }, { root: null, threshold: 0.12 });
  }

  function scanNodeForTweetText(node, handler) {
    if (!node) return;
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = /** @type {HTMLElement} */ (node);
    if (el.matches && el.matches(TWEET_TEXT_SELECTOR)) {
      handler(el);
    } else if (el.querySelectorAll) {
      const found = el.querySelectorAll(TWEET_TEXT_SELECTOR);
      for (const f of found) handler(f);
    }
  }

  function registerTweetText(tweetTextEl) {
    if (!tweetTextEl || !(tweetTextEl instanceof HTMLElement)) return;

    if (isHandledEl(tweetTextEl)) {
      processTweetTextEl(tweetTextEl);
      return;
    }

    if (CFG.useIntersectionObserver && intersectionObserver) {
      if (!ioObserved.get(tweetTextEl)) {
        intersectionObserver.observe(tweetTextEl);
        ioObserved.set(tweetTextEl, true);
      }
    } else {
      processTweetTextEl(tweetTextEl);
    }
  }

  /********************************************************************
   * Periodic scan: force-call processTweetTextEl (visible or all)
   ********************************************************************/
  function isElNearViewport(el) {
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const margin = CFG.scanViewportMarginPx;
    return rect.bottom >= -margin && rect.top <= (vh + margin);
  }

  let scanInProgress = false;
  let scanToken = 0;

  function periodicScan() {
    if (!ENABLED) return;

    if (scanInProgress) {
      stats.scansSkippedOverlap++;
      return;
    }

    scanInProgress = true;
    const token = ++scanToken;

    pruneQueueInvalid();

    const nodes = document.querySelectorAll(TWEET_TEXT_SELECTOR);
    if (!nodes || !nodes.length) {
      scanInProgress = false;
      return;
    }

    const list = Array.from(nodes);
    let idx = 0;

    const step = (deadline) => {
      if (token !== scanToken) {
        scanInProgress = false;
        return;
      }

      const start = performance.now();
      while (idx < list.length) {
        if (deadline && deadline.timeRemaining && deadline.timeRemaining() < 3) break;
        if (!deadline && (performance.now() - start) > 12) break;

        const el = list[idx++];
        if (!(el instanceof HTMLElement)) continue;

        if (CFG.periodicScanMode === "visible") {
          if (!isElNearViewport(el)) continue;
        }

        processTweetTextEl(el);
      }

      if (idx < list.length) {
        scheduleNext(step);
      } else {
        scanInProgress = false;
      }
    };

    const scheduleNext = (fn) => {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(fn, { timeout: 2000 });
      } else {
        setTimeout(() => fn(null), 0);
      }
    };

    scheduleNext(step);
  }

  /********************************************************************
   * DOM observer + boot
   ********************************************************************/
  function startDomObserver() {
    intersectionObserver = initIntersectionObserver();

    document.querySelectorAll(TWEET_TEXT_SELECTOR).forEach(registerTweetText);

    const mo = new MutationObserver((mutations) => {
      if (!ENABLED) return;

      for (const m of mutations) {
        for (const n of m.addedNodes) {
          scanNodeForTweetText(n, registerTweetText);
        }
        for (const n of m.removedNodes) {
          scanNodeForTweetText(n, cleanupElement);
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    setInterval(periodicScan, CFG.scanIntervalMs);
  }

  /********************************************************************
   * Menu commands
   ********************************************************************/
  let menuIds = { toggle: null, clear: null, stats: null, flush: null };

  function registerMenu() {
    if (typeof GM_registerMenuCommand !== "function") return;

    if (typeof GM_unregisterMenuCommand === "function") {
      if (menuIds.toggle != null) GM_unregisterMenuCommand(menuIds.toggle);
      if (menuIds.clear != null) GM_unregisterMenuCommand(menuIds.clear);
      if (menuIds.stats != null) GM_unregisterMenuCommand(menuIds.stats);
      if (menuIds.flush != null) GM_unregisterMenuCommand(menuIds.flush);
    }

    menuIds.toggle = GM_registerMenuCommand(`${ENABLED ? "Disable" : "Enable"} auto-translation`, () => {
      ENABLED = !ENABLED;
      setEnabled(ENABLED);
      log("Enabled:", ENABLED);
      registerMenu();
      if (ENABLED) pump();
    });

    menuIds.clear = GM_registerMenuCommand("Clear ALL caches (memory + persistent)", () => {
      cacheClearAll();
      log("Caches cleared (memory + persistent).");
    });

    menuIds.flush = GM_registerMenuCommand("Flush persistent cache now", () => {
      persistFlush();
      log("Persistent cache flushed.");
    });

    menuIds.stats = GM_registerMenuCommand("Show stats (console)", () => {
      // eslint-disable-next-line no-console
      console.log(LOG_PREFIX, "Stats:", JSON.parse(JSON.stringify(stats)));
      // eslint-disable-next-line no-console
      console.log(LOG_PREFIX, "Regex support:", {
        unicodePropertyEscapes: JP_RX.supportsUnicodeProps,
        codePointEscapes: JP_RX.supportsCodePointEscapes
      });
      // eslint-disable-next-line no-console
      console.log(LOG_PREFIX, "Persistent cache:", { entries: PERSIST.size, approxChars: persistApproxChars });
      // eslint-disable-next-line no-console
      console.log(LOG_PREFIX, "Memory cache:", { entries: MEM_CACHE.size });
      // eslint-disable-next-line no-console
      console.log(LOG_PREFIX, "Queue:", { size: queueSize() });
    });
  }

  /********************************************************************
   * Boot
   ********************************************************************/
  function boot() {
    persistLoad();
    registerMenu();
    startDomObserver();
    log("Loaded. Enabled:", ENABLED);
    log("Regex support:", {
      unicodePropertyEscapes: JP_RX.supportsUnicodeProps,
      codePointEscapes: JP_RX.supportsCodePointEscapes
    });
    log("Periodic scan mode:", CFG.periodicScanMode, "interval:", CFG.scanIntervalMs, "ms");
  }

  setTimeout(boot, 800);
})();
