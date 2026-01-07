// ==UserScript==
// @name         Auto-translate Japanese Tweets to English
// @namespace    https://github.com/Xenfernal
// @version      1.1
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

    // After a "weak/partial" translation (quality gate fail), retry later (avoid thrash)
    weakResultCooldownMs: 30000,
    negativeCacheMaxEntries: 500,

    // Settling window (avoid transient DOM states / hydration)
    settleDelayMs: 380,
    settleMaxWaitMs: 2200,

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

    // Quality gate (prevent caching partial/non-translations)
    qualityMaxJpRatio: 0.45,               // outJP / inJP must usually be <= this
    qualityMinInJpToApplyRatio: 6,         // don't overreact on tiny inputs
    qualityUnchangedLineJpMin: 4,          // JP evidence needed for "unchanged JP line" detection
    qualityRequireEnglishForPartial: 3,    // if output has >= this many Latin letters and unchanged JP lines -> partial

    // Extraction fallback safety (reduce innerText duplication risk)
    innerTextMaxLengthRatio: 1.45,         // if innerText is much longer than TreeWalker, treat as suspect unless big JP delta
    innerTextAcceptHugeDeltaJp: 8,          // accept longer innerText only if JP evidence delta is big

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
    cachePurgedWeakMem: 0,
    cachePurgedWeakPersistent: 0,
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

    settleDeferrals: 0,
    extractionUsedInnerText: 0,
    negativeCacheHits: 0,
    qualityRejected: 0,
    qualityRetries: 0,
    qualityAdaptiveChunkUsed: 0,
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
    let reKanaG;
    let reHanGlobal;

    if (supportsUnicodeProps) {
      reKana = new RegExp("[\\p{Script=Hiragana}\\p{Script=Katakana}]", "u");
      reKanaG = new RegExp("[\\p{Script=Hiragana}\\p{Script=Katakana}]", "gu");
      reHanGlobal = new RegExp("\\p{Script=Han}", "gu");
    } else {
      const kanaRanges = "[\\u3040-\\u309F\\u30A0-\\u30FF\\u31F0-\\u31FF\\uFF65-\\uFF9F]";
      reKana = new RegExp(kanaRanges, "u");
      reKanaG = new RegExp(kanaRanges, "gu");

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

    return { reKana, reKanaG, reHanGlobal, supportsUnicodeProps, supportsCodePointEscapes };
  }

  const JP_RX = buildJapaneseRegexes();
  const RE_KANA = JP_RX.reKana;
  const RE_KANA_G = JP_RX.reKanaG;
  const RE_HAN_G = JP_RX.reHanGlobal;

  const RE_JP_MARKS_G = /[々〆ヶヵーゝゞヽヾ]/gu;
  const RE_JP_PUNCT_G = /[。、「」『』（）【】［］｛｝〈〉《》・]/gu;
  const RE_LATIN_G = /[A-Za-z]/g;
  const RE_LATIN = /[A-Za-z]/;
  const RE_NON_ASCII = /[^\x00-\x7F]/;
  const RE_FULLWIDTH_FORMS = /[\uFF01-\uFF60\uFFE0-\uFFEE]/u;

  function countHan(text) {
    const m = text.match(RE_HAN_G);
    return m ? m.length : 0;
  }

  function countMatchesGlobal(re, s) {
    if (!s) return 0;
    const m = s.match(re);
    return m ? m.length : 0;
  }

  function jpEvidence(text) {
    const t = (text || "").trim();
    if (!t) return { total: 0, han: 0, kana: 0, punct: 0, marks: 0 };
    const han = countHan(t);
    const kana = countMatchesGlobal(RE_KANA_G, t);
    const punct = countMatchesGlobal(RE_JP_PUNCT_G, t);
    const marks = countMatchesGlobal(RE_JP_MARKS_G, t);
    return { total: han + kana + punct + marks, han, kana, punct, marks };
  }

  function shouldTranslate(text) {
    if (!text) return false;
    const t = text.trim();
    if (t.length < 2) return false;

    if (RE_KANA.test(t)) return true;
    if (/[々〆ヶヵーゝゞヽヾ]/u.test(t)) return true;

    const han = countHan(t);
    if (han >= CFG.hanCountTranslateThreshold) return true;
    if (han >= CFG.hanCountWithJpPunctThreshold && /[。、「」『』（）【】［］｛｝〈〉《》・]/u.test(t)) return true;

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
    return RE_NON_ASCII.test(t) || RE_FULLWIDTH_FORMS.test(t) || /[。、「」『』（）【】［］｛｝〈〉《》・]/u.test(t) || /[々〆ヶヵーゝゞヽヾ]/u.test(t);
  }

  function classifyForTranslation(text, tweetTextEl) {
    const t = (text || "").trim();
    if (t.length < 2) return { eligible: false, slPref: "auto", strongJp: false, han: 0, hasKana: false, langHint: false };

    const hasKana = RE_KANA.test(t);
    const hasMarks = /[々〆ヶヵーゝゞヽヾ]/u.test(t);
    const hasPunct = /[。、「」『』（）【】［］｛｝〈〉《》・]/u.test(t);
    const han = countHan(t);
    const langHint = hasLangJaHint(tweetTextEl);

    let eligible = false;
    if (hasKana || hasMarks) eligible = true;
    else if (han >= CFG.hanCountTranslateThreshold) eligible = true;
    else if (han >= CFG.hanCountWithJpPunctThreshold && hasPunct) eligible = true;
    else if (han >= CFG.shortHanMin && t.length <= CFG.shortTextMaxLen && !RE_LATIN.test(t)) eligible = true;

    if (!eligible && langHint && langJaOverrideEligible(t)) eligible = true;

    const strongJp = !!(hasKana || hasMarks || langHint);
    const slPref = strongJp ? "ja" : "auto";

    return { eligible, slPref, strongJp, han, hasKana, langHint };
  }

  /********************************************************************
   * Text extraction (TreeWalker) + safer innerText fallback
   ********************************************************************/
  const RE_WORD_CHAR = /[0-9A-Za-z]/;

  function normaliseExtractedText(s) {
    let text = (s || "");
    text = text.replace(/\r\n/g, "\n");
    text = text.replace(/[ \t]+/g, " ");
    text = text.replace(/ *\n */g, "\n");
    text = text.replace(/\n{3,}/g, "\n\n");
    text = text.trim();
    if (text.length > CFG.maxTextLength) text = text.slice(0, CFG.maxTextLength);
    return text;
  }

  function normaliseForCompare(s) {
    let t = (s || "").trim();
    t = t.replace(/[ \t]+/g, " ");
    t = t.replace(/\n{3,}/g, "\n\n");
    return t;
  }

  function countOccurrences(haystack, needle, max = 3) {
    if (!haystack || !needle) return 0;
    if (needle.length < 20) return 0; // ignore tiny needles (too noisy)
    let count = 0;
    let idx = 0;
    while (true) {
      const pos = haystack.indexOf(needle, idx);
      if (pos < 0) break;
      count++;
      if (count >= max) break;
      idx = pos + needle.length;
    }
    return count;
  }

  function hasSignificantLineDuplication(text) {
    const lines = (text || "")
      .split(/\n+/)
      .map(s => s.trim().replace(/[ \t]+/g, " "))
      .filter(Boolean);

    if (lines.length < 4) return false;

    const counts = new Map();
    let dupLines = 0;

    for (const l of lines) {
      const c = (counts.get(l) || 0) + 1;
      counts.set(l, c);
      if (c === 2) dupLines++;
    }

    // A couple of duplicated lines in a short tweet is a strong signal of duplication/artefacts.
    const dupRatio = dupLines / lines.length;
    return dupLines >= 2 || dupRatio > 0.35;
  }

  function extractTweetTextTreeWalker(rootEl) {
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

    return normaliseExtractedText(parts.join(""));
  }

  function extractTweetTextRobust(rootEl) {
    const treeText = extractTweetTextTreeWalker(rootEl);
    const innerText = normaliseExtractedText((rootEl && typeof rootEl.innerText === "string") ? rootEl.innerText : "");

    if (!innerText) return treeText;
    if (!treeText) return innerText;

    const a = jpEvidence(treeText);
    const b = jpEvidence(innerText);

    const treeCmp = normaliseForCompare(treeText);
    const innerCmp = normaliseForCompare(innerText);

    // Duplication/artefact guards: if innerText contains the TreeWalker text multiple times or has repeated lines,
    // prefer TreeWalker to avoid doubled translations.
    const occ = countOccurrences(innerCmp, treeCmp, 2);
    const dupLines = hasSignificantLineDuplication(innerText);
    const innerSuspectDup = (occ >= 2) || dupLines;

    if (innerSuspectDup) return treeText;

    const deltaJP = b.total - a.total;
    const innerMuchLonger = innerText.length > (treeText.length * CFG.innerTextMaxLengthRatio);

    // Prefer innerText only when it seems materially better (missing JP or content),
    // and avoid selecting very long innerText unless JP delta is large.
    const innerClearlyBetter =
      (deltaJP >= 3) ||
      (treeText.length < innerText.length * 0.78 && b.total >= a.total);

    const acceptHugeInner = (!innerMuchLonger) || (deltaJP >= CFG.innerTextAcceptHugeDeltaJp);

    if (innerClearlyBetter && acceptHugeInner) {
      stats.extractionUsedInnerText++;
      return innerText;
    }

    return treeText;
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
  function memDelete(key) {
    if (MEM_CACHE.has(key)) MEM_CACHE.delete(key);
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

  function persistDelete(key) {
    if (!PERSIST.has(key)) return;
    const old = PERSIST.get(key);
    PERSIST.delete(key);
    persistApproxChars -= approxEntryChars(key, old);
    if (persistApproxChars < 0) persistApproxChars = 0;
    persistDirty = true;
    persistScheduleSave();
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

  /********************************************************************
   * Negative cache (short-lived) to avoid repeated weak/partial results
   ********************************************************************/
  const NEG_CACHE = new Map(); // key -> untilEpochMs
  function negGet(key) {
    const until = NEG_CACHE.get(key) || 0;
    if (!until) return 0;
    if (Date.now() >= until) {
      NEG_CACHE.delete(key);
      return 0;
    }
    return until;
  }
  function negSet(key, until) {
    if (!key || !until) return;
    if (NEG_CACHE.has(key)) NEG_CACHE.delete(key);
    NEG_CACHE.set(key, until);
    while (NEG_CACHE.size > CFG.negativeCacheMaxEntries) {
      const oldest = NEG_CACHE.keys().next().value;
      NEG_CACHE.delete(oldest);
    }
  }

  function cacheClearAll() {
    MEM_CACHE.clear();
    persistFlush();
    NEG_CACHE.clear();
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
   * UI injection + per-element state
   ********************************************************************/
  const elementLastKey = new WeakMap();          // tweetText -> cacheKey
  const elementEligibleDecision = new WeakMap(); // tweetText -> boolean eligibility for elementLastKey
  const elementFailedUntil = new WeakMap();      // tweetText -> epoch ms (cooldown until retry)

  const elementBox = new WeakMap();              // tweetText -> translation box element
  const elementBoxState = new WeakMap();         // tweetText -> "ok" | "status"
  const elementPendingKey = new WeakMap();       // tweetText -> cacheKey queued/in-flight
  const elementObserver = new WeakMap();         // tweetText -> MutationObserver

  const elementLangPref = new WeakMap();         // tweetText -> { key, slPref, strongJp, langHint }
  const elementSettleState = new WeakMap();      // tweetText -> { key, lastText, firstAt, timerId }

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

  function clearSettleState(tweetTextEl) {
    const st = elementSettleState.get(tweetTextEl);
    if (st && st.timerId) {
      try { clearTimeout(st.timerId); } catch (_) {}
    }
    elementSettleState.delete(tweetTextEl);
  }

  function cleanupElement(tweetTextEl) {
    disconnectElementObserver(tweetTextEl);
    removeBox(tweetTextEl);
    elementPendingKey.delete(tweetTextEl);

    elementLastKey.delete(tweetTextEl);
    elementEligibleDecision.delete(tweetTextEl);
    elementFailedUntil.delete(tweetTextEl);
    elementLangPref.delete(tweetTextEl);

    clearSettleState(tweetTextEl);
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

  function enqueue(tweetTextEl, text, key, langMeta) {
    const pending = elementPendingKey.get(tweetTextEl);
    if (pending === key) return;

    const size = queueSize();
    if (size >= CFG.maxQueueLength) {
      dropOldestTasks((size - CFG.maxQueueLength) + 1);
    }

    elementPendingKey.set(tweetTextEl, key);
    queue.push({
      el: tweetTextEl,
      text,
      key,
      attempts: 0,
      slPref: (langMeta && langMeta.slPref) ? langMeta.slPref : "auto",
      strongJp: !!(langMeta && langMeta.strongJp),
      langHint: !!(langMeta && langMeta.langHint),
    });
    stats.enqueued++;
    pump();
  }

  function requeueWithCap(item) {
    if (!item || !item.el) return;

    if (!item.el.isConnected) {
      clearPendingIfMatchesIfNoQueued(item.el, item.key);
      return;
    }
    if (elementLastKey.get(item.el) !== item.key) {
      clearPendingIfMatchesIfNoQueued(item.el, item.key);
      return;
    }

    const size = queueSize();
    if (size >= CFG.maxQueueLength) {
      dropOldestTasks((size - CFG.maxQueueLength) + 1);
    }

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

  // NEW: ensure the queue keeps draining even after early returns (fixes stall).
  function continuePumpSoon() {
    if (!ENABLED) return;
    if (inFlight) return;
    if (queueSize() > 0) schedulePump(0);
  }

  /********************************************************************
   * Quality gate (prevents caching partial/non-translations)
   ********************************************************************/
  function normaliseLineForMatch(s) {
    return (s || "").trim().replace(/[ \t]+/g, " ");
  }

  function countUnchangedJpLines(input, output) {
    const inLines = (input || "").split(/\n+/).map(normaliseLineForMatch).filter(Boolean);
    const outTextNorm = normaliseLineForMatch(output || "");
    const outLines = (output || "").split(/\n+/).map(normaliseLineForMatch).filter(Boolean);
    const outSet = new Set(outLines);

    let hits = 0;
    for (const line of inLines) {
      const e = jpEvidence(line);
      if (e.total < CFG.qualityUnchangedLineJpMin) continue;
      if (outSet.has(line)) { hits++; continue; }
      if (outTextNorm.includes(line)) { hits++; continue; }
    }
    return hits;
  }

  function assessTranslationQuality(input, output) {
    const inText = (input || "").trim();
    const outText = (output || "").trim();

    if (!outText) return { ok: false, reason: "EMPTY" };
    if (!inText) return { ok: true, reason: "NO_INPUT" };

    if (outText === inText) return { ok: false, reason: "UNCHANGED" };

    const inE = jpEvidence(inText);
    const outE = jpEvidence(outText);

    const outLatin = countMatchesGlobal(RE_LATIN_G, outText);
    const unchangedJpLines = countUnchangedJpLines(inText, outText);

    if (unchangedJpLines >= 1 && outLatin >= CFG.qualityRequireEnglishForPartial) {
      return { ok: false, reason: "PARTIAL_UNCHANGED_JP_LINES", inJP: inE.total, outJP: outE.total, outLatin, unchangedJpLines };
    }

    if (inE.total >= CFG.qualityMinInJpToApplyRatio) {
      const ratio = outE.total / Math.max(1, inE.total);
      const outStillLooksJp = shouldTranslate(outText);

      if (outStillLooksJp && ratio > CFG.qualityMaxJpRatio) {
        return { ok: false, reason: "JP_EVIDENCE_TOO_HIGH", ratio, inJP: inE.total, outJP: outE.total, outLatin, unchangedJpLines };
      }
    }

    if (outE.total >= 8 && outLatin < 2) {
      return { ok: false, reason: "LIKELY_NOT_TRANSLATED", inJP: inE.total, outJP: outE.total, outLatin, unchangedJpLines };
    }

    return { ok: true, reason: "OK" };
  }

  // NEW: quality-validated cache reads (purges weak entries instead of trusting them forever).
  function cacheGetValidated(inputText, key) {
    const mem = memGet(key);
    if (mem) {
      const q = assessTranslationQuality(inputText, mem);
      if (q.ok) return { val: mem, source: "mem" };
      memDelete(key);
      stats.cachePurgedWeakMem++;
    }

    const persisted = persistGet(key);
    if (persisted) {
      const q = assessTranslationQuality(inputText, persisted);
      if (q.ok) {
        memSet(key, persisted);
        return { val: persisted, source: "persist" };
      }
      persistDelete(key);
      stats.cachePurgedWeakPersistent++;
    }

    return null;
  }

  /********************************************************************
   * Translate: GET with POST fallback; chunked GET fallback if POST rejected
   * + JP-first sl when confident; adaptive retries on quality gate failure
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

  async function translateViaGoogleOnce(text, tl, sl) {
    const baseParams = `client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&dj=1`;
    const qParam = `q=${encodeURIComponent(text)}`;

    const getUrl = `https://translate.googleapis.com/translate_a/single?${baseParams}&${qParam}`;
    const usePost = (getUrl.length > CFG.maxGetUrlLength);

    if (!usePost) {
      await waitForGlobalPacing();
      const out = await xhrTranslateOnce({
        method: "GET",
        url: getUrl,
        headers: { "Accept": "application/json,text/plain,*/*" }
      });
      nextAllowedAt = Date.now() + CFG.minRequestDelayMs;
      return out;
    }

    stats.usedPost++;

    await waitForGlobalPacing();
    try {
      const out = await xhrTranslateOnce({
        method: "POST",
        url: `https://translate.googleapis.com/translate_a/single?${baseParams}`,
        headers: {
          "Accept": "application/json,text/plain,*/*",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
        },
        data: qParam
      });
      nextAllowedAt = Date.now() + CFG.minRequestDelayMs;
      return out;
    } catch (err) {
      const postRejected = (err && err.code && isPostRejectionCode(err.code));
      const unexpected = (err && err.code === "UNEXPECTED_RESPONSE");

      if (postRejected || unexpected) {
        stats.postRejectedFallbackChunked++;
        return await chunkTranslateViaGet(text, baseParams);
      }
      throw err;
    }
  }

  async function translateAdaptiveChunked(text, tl, sl) {
    stats.qualityAdaptiveChunkUsed++;

    const rawLines = (text || "").split("\n");

    if (rawLines.length > 10) {
      const baseParams = `client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&dj=1`;
      return await chunkTranslateViaGet(text, baseParams);
    }

    let acc = "";
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];

      if (!line.trim()) {
        acc += (i < rawLines.length - 1) ? "\n" : "";
        continue;
      }

      // Prefer actual JP evidence (avoid translating emoji-only lines in fallback mode).
      const e = jpEvidence(line);
      const eligibleLine = (e.total > 0) || shouldTranslate(line) || (sl === "ja" && langJaOverrideEligible(line));

      if (!eligibleLine) {
        acc += line;
        if (i < rawLines.length - 1) acc += "\n";
        continue;
      }

      const translated = await translateViaGoogleOnce(line, tl, sl);
      acc += translated;
      if (i < rawLines.length - 1) acc += "\n";
    }

    return normaliseTranslatedText(acc);
  }

  async function translateRobust(text, tl, langMeta) {
    const slPref = (langMeta && langMeta.slPref) ? langMeta.slPref : "auto";
    const strongJp = !!(langMeta && langMeta.strongJp);
    const langHint = !!(langMeta && langMeta.langHint);

    let out1 = await translateViaGoogleOnce(text, tl, slPref);
    let q1 = assessTranslationQuality(text, out1);
    if (q1.ok) return out1;

    stats.qualityRejected++;

    const inE = jpEvidence(text);
    const canTryJa = (slPref !== "ja") && (strongJp || langHint || inE.han >= CFG.hanCountTranslateThreshold);

    if (canTryJa) {
      stats.qualityRetries++;
      let out2 = await translateViaGoogleOnce(text, tl, "ja");
      let q2 = assessTranslationQuality(text, out2);
      if (q2.ok) return out2;

      stats.qualityRejected++;

      stats.qualityRetries++;
      let out3 = await translateAdaptiveChunked(text, tl, "ja");
      let q3 = assessTranslationQuality(text, out3);
      if (q3.ok) return out3;

      stats.qualityRejected++;
      const e = new Error(`QUALITY_FAIL: ${q3.reason || "UNKNOWN"}`);
      e.code = "QUALITY_FAIL";
      throw e;
    }

    stats.qualityRetries++;
    let out3 = await translateAdaptiveChunked(text, tl, slPref);
    let q3 = assessTranslationQuality(text, out3);
    if (q3.ok) return out3;

    stats.qualityRejected++;
    const e = new Error(`QUALITY_FAIL: ${q3.reason || "UNKNOWN"}`);
    e.code = "QUALITY_FAIL";
    throw e;
  }

  /********************************************************************
   * Settling window: avoid translating transient DOM states
   ********************************************************************/
  function scheduleSettleCheck(tweetTextEl) {
    const st = elementSettleState.get(tweetTextEl);
    if (!st) return;
    if (st.timerId) return;

    st.timerId = setTimeout(() => {
      st.timerId = null;

      if (!tweetTextEl.isConnected) {
        elementSettleState.delete(tweetTextEl);
        return;
      }

      const now = Date.now();
      const curText = extractTweetTextRobust(tweetTextEl);
      const curKey = makeCacheKey(curText);

      if ((curKey !== st.key || curText !== st.lastText) && (now - st.firstAt) < CFG.settleMaxWaitMs) {
        st.key = curKey;
        st.lastText = curText;
        scheduleSettleCheck(tweetTextEl);
        return;
      }

      elementSettleState.delete(tweetTextEl);
      processTweetTextEl(tweetTextEl, { skipSettle: true, settledText: curText });
    }, CFG.settleDelayMs);
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

  function processTweetTextEl(tweetTextEl, opts = null) {
    if (!tweetTextEl || !(tweetTextEl instanceof HTMLElement)) return;
    if (!tweetTextEl.isConnected) return;

    stats.seen++;

    const text = (opts && typeof opts.settledText === "string")
      ? normaliseExtractedText(opts.settledText)
      : extractTweetTextRobust(tweetTextEl);

    const key = makeCacheKey(text);

    if (!opts || !opts.skipSettle) {
      const lastKey = elementLastKey.get(tweetTextEl);
      if (lastKey !== key) {
        const existing = elementSettleState.get(tweetTextEl);
        if (!existing || existing.key !== key) {
          clearSettleState(tweetTextEl);
          elementSettleState.set(tweetTextEl, { key, lastText: text, firstAt: Date.now(), timerId: null });
          stats.settleDeferrals++;
          scheduleSettleCheck(tweetTextEl);
        } else {
          existing.lastText = text;
          scheduleSettleCheck(tweetTextEl);
        }
        return;
      }
    }

    const lastKey = elementLastKey.get(tweetTextEl);
    const pendingKey = elementPendingKey.get(tweetTextEl);
    const box = elementBox.get(tweetTextEl);
    const boxState = elementBoxState.get(tweetTextEl) || null;
    const decision = elementEligibleDecision.get(tweetTextEl);
    const failedUntil = elementFailedUntil.get(tweetTextEl) || 0;
    const now = Date.now();

    const negUntil = negGet(key);
    if (negUntil && !(box && box.isConnected && boxState === "ok")) {
      stats.negativeCacheHits++;
      setBoxStatus(tweetTextEl, "Translation incomplete earlier; will retry automatically soon.");
      ensureElementObserver(tweetTextEl);
      maybeUnobserveAfterHandled(tweetTextEl);
      return;
    }

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
    let langMeta = null;

    if (lastKey === key && decision === true) {
      eligible = true;
      const pref = elementLangPref.get(tweetTextEl) || null;
      langMeta = pref ? { slPref: pref.slPref, strongJp: pref.strongJp, langHint: pref.langHint } : null;
    } else {
      const meta = classifyForTranslation(text, tweetTextEl);
      eligible = meta.eligible;
      elementEligibleDecision.set(tweetTextEl, eligible);
      langMeta = meta;
      elementLangPref.set(tweetTextEl, { key, slPref: meta.slPref, strongJp: meta.strongJp, langHint: meta.langHint });
    }

    if (!eligible) {
      removeBox(tweetTextEl);
      disconnectElementObserver(tweetTextEl);
      clearPendingIfMatches(tweetTextEl, key);
      unobserveIfObserved(tweetTextEl);
      return;
    }

    stats.eligible++;

    // NEW: validate cache before display; purge weak cached entries.
    const cached = cacheGetValidated(text, key);
    if (cached) {
      if (cached.source === "mem") stats.cacheHitsMem++;
      else stats.cacheHitsPersistent++;
      setBoxTranslation(tweetTextEl, cached.val);
      stats.translated++;
      ensureElementObserver(tweetTextEl);
      maybeUnobserveAfterHandled(tweetTextEl);
      return;
    }

    ensureElementObserver(tweetTextEl);

    if (failedUntil && now >= failedUntil) {
      elementFailedUntil.delete(tweetTextEl);
    }

    enqueue(tweetTextEl, text, key, langMeta);
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
   * Pump: translateRobust + quality-gated caching + stall fix
   ********************************************************************/
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
      clearPendingIfMatchesIfNoQueued(el, key);
      continuePumpSoon(); // FIX (1)
      return;
    }

    if (elementLastKey.get(el) !== key) {
      clearPendingIfMatchesIfNoQueued(el, key);
      continuePumpSoon(); // FIX (1)
      return;
    }

    // NEW: validate cache before using it (purge weak cached entries).
    const cached = cacheGetValidated(text, key);
    if (cached) {
      if (cached.source === "mem") stats.cacheHitsMem++;
      else stats.cacheHitsPersistent++;

      clearPendingIfMatchesIfNoQueued(el, key);
      setBoxTranslation(el, cached.val);
      stats.translated++;
      nextAllowedAt = Date.now() + 50;
      schedulePump(10);
      return;
    }

    setBoxStatus(el, "Translating…");

    inFlight = true;

    const langMeta = item && typeof item === "object"
      ? { slPref: item.slPref || "auto", strongJp: !!item.strongJp, langHint: !!item.langHint }
      : { slPref: "auto", strongJp: false, langHint: false };

    translateRobust(text, CFG.targetLang, langMeta)
      .then((translatedText) => {
        inFlight = false;
        clearPendingIfMatchesIfNoQueued(el, key);

        if (!el.isConnected) { continuePumpSoon(); return; }
        if (elementLastKey.get(el) !== key) { continuePumpSoon(); return; }

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
          clearPendingIfMatchesIfNoQueued(el, key);
          continuePumpSoon(); // FIX (1)
          return;
        }

        // Quality fail: do NOT cache; set short cooldown and keep draining queue.
        if ((err && err.code === "QUALITY_FAIL") || msg.includes("QUALITY_FAIL")) {
          clearPendingIfMatchesIfNoQueued(el, key);

          const until = Date.now() + CFG.weakResultCooldownMs;
          elementFailedUntil.set(el, until);
          negSet(key, until);

          setBoxStatus(el, "Translation incomplete (quality check). Will retry automatically shortly.");
          continuePumpSoon(); // FIX (1)
          return;
        }

        item.attempts = (item.attempts || 0) + 1;
        if (item.attempts > CFG.maxAttemptsPerItem) {
          clearPendingIfMatchesIfNoQueued(el, key);

          elementFailedUntil.set(el, Date.now() + CFG.failureRetryCooldownMs);
          setBoxStatus(el, "Translation failed (gave up for now; will retry later).");
          continuePumpSoon(); // FIX (1)
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

    menuIds.clear = GM_registerMenuCommand("Clear ALL caches (memory + persistent + negative)", () => {
      cacheClearAll();
      log("Caches cleared (memory + persistent + negative).");
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
      console.log(LOG_PREFIX, "Negative cache:", { entries: NEG_CACHE.size });
      // eslint-disable-next-line no-console
      console.log(LOG_PREFIX, "Queue:", { size: queueSize() });
    });
  }

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
    log("Quality gate:", {
      maxJpRatio: CFG.qualityMaxJpRatio,
      minInJpToApplyRatio: CFG.qualityMinInJpToApplyRatio,
      weakCooldownMs: CFG.weakResultCooldownMs
    });
    log("Settling:", { delayMs: CFG.settleDelayMs, maxWaitMs: CFG.settleMaxWaitMs });
    log("Extraction fallback:", {
      innerTextMaxLengthRatio: CFG.innerTextMaxLengthRatio,
      innerTextAcceptHugeDeltaJp: CFG.innerTextAcceptHugeDeltaJp
    });
  }

  setTimeout(boot, 800);
})();
