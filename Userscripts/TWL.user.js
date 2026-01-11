// ==UserScript==
// @name        Twitch Lurker
// @description Automatically lurk on Twitch channels you prefer to follow. Based on Twitching Lurkist userscript by Xspeed.
// @author      Xen
// @namespace   https://github.com/Xenfernal
// @version     2.0
// @icon        https://static.twitchcdn.net/assets/favicon-32-e29e246c157142c94346.png
// @match       *://www.twitch.tv/*
// @grant       GM.getValue
// @grant       GM.setValue
// @grant       GM.xmlHttpRequest
// @grant       unsafeWindow
// @connect     gql.twitch.tv
// @license     MIT
// @homepageURL https://github.com/Xenfernal/Personal-QoL-Stuff/tree/main/Userscripts
// @downloadURL https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/TWL.user.js
// @updateURL   https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/TWL.user.js
// @run-at      document-start
// @noframes
// ==/UserScript==

'use strict';

const activationPath = '/directory/following/autolurk';
const MAX_FRAMES = 5; // hard cap on simultaneously open iframes
const THEATRE_BTN_SEL = [
  'button[data-a-target="player-theatre-mode-button"]',
  'button[aria-label*="Theatre Mode"]',
  'button[aria-label*="Theater Mode"]',
  'button[aria-label*="Exit Theatre Mode"]',
  'button[aria-label*="Exit Theater Mode"]'
].join(',');

const SCRIPT_NAME = (GM && GM.info && GM.info.script && GM.info.script.name) || 'Twitch Lurker';

const FORBIDDEN_HEADERS = new Set([
  'accept-encoding', 'accept-charset', 'access-control-request-headers', 'access-control-request-method',
  'connection', 'content-length', 'cookie', 'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive',
  'origin', 'referer', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'via',
  'user-agent', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'
]);

// Data-marker to make tab detection absolute and duplicate-proof
const TAB_MARK_ATTR = 'data-tl-autolurk';
const TAB_MARK_VAL = '1';

// Overlay ids/styles (avoid destructive DOM wipe; keep Twitch recoverable)
const OVERLAY_ID = 'tl-overlay';
const STREAMS_ID = 'tl-streams';
const STYLE_ID = 'tl-style';
const HIDE_STYLE_ID = 'tl-hide-twitch';

let refreshJob = -1;
let detectJob = -1;

let fetchOpts = {}; // { url, opts:{ method, headers, body }, anonymous:boolean, _anonLastFlip:number }
let streamFrames = [];
let detectBusy = false;

// Tab injection: efficient + robust route
let tabInjectTimer = 0;
let tabsObserver = null;
let tabsObservedRoot = null;
let tabsWatchdogJob = -1;

// SPA route hook guard
let navHooksInstalled = false;
let popHookInstalled = false;
let routeWatchdogJob = -1;
let lastPathname = location.pathname;

// Overlay handles
let overlayRoot = null;
let streamsHostEl = null;

// ---- Preferences (single source of truth) ----
const DEFAULTS = {
  autoCinema: true,
  autoClose: true,
  autoRefresh: false,
  detectPause: false,
  frameScale: 1,
  lowLatDisable: true,
  whitelist: [],
  panelAutoOpen: false
};

let prefs = { ...DEFAULTS };

async function loadPrefs() {
  const results = await Promise.all([
    GM.getValue('autoCinema', DEFAULTS.autoCinema),
    GM.getValue('autoClose', DEFAULTS.autoClose),
    GM.getValue('autoRefresh', DEFAULTS.autoRefresh),
    GM.getValue('detectPause', DEFAULTS.detectPause),
    GM.getValue('frameScale', DEFAULTS.frameScale),
    GM.getValue('lowLatDisable', DEFAULTS.lowLatDisable),
    GM.getValue('whitelist', DEFAULTS.whitelist.join(',')),
    GM.getValue('panelAutoOpen', DEFAULTS.panelAutoOpen)
  ]);

  const [
    autoCinema,
    autoClose,
    autoRefresh,
    detectPause,
    frameScale,
    lowLatDisable,
    whitelistCsv,
    panelAutoOpen
  ] = results;

  prefs = {
    autoCinema,
    autoClose,
    autoRefresh,
    detectPause,
    frameScale,
    lowLatDisable,
    whitelist: String(whitelistCsv).split(',').map(s => s.trim()).filter(Boolean),
    panelAutoOpen
  };
}

// ---- Utilities ----
function log(txt) {
  console.log(`[${SCRIPT_NAME}] ${txt}`);
}

function safeRemoveNode(node) {
  try {
    if (!node) return;
    if (typeof node.remove === 'function') {
      if (node.isConnected) node.remove();
      return;
    }
    if (node.parentElement) node.parentElement.removeChild(node);
  } catch {
    /* noop */
  }
}

function safeFrameDoc(sf) {
  try {
    return sf?.frame?.contentDocument || null;
  } catch {
    return null;
  }
}

function tryGetPathLower(doc) {
  try {
    const p = doc?.location?.pathname;
    return (typeof p === 'string') ? p.toLowerCase() : '';
  } catch {
    return '';
  }
}

function getFramePathLower(sf) {
  return tryGetPathLower(safeFrameDoc(sf));
}

function isActivationPath() {
  return location.pathname.startsWith(activationPath);
}

function isFollowingArea() {
  return location.pathname.startsWith('/directory/following');
}

function isUiPresent() {
  return !!(document.getElementById('tl-panel') && document.getElementById('tl-toggle'));
}

// ---- Refresh timer (Risk B elimination) ----
function armRefreshTimer() {
  if (!prefs.autoRefresh) return;
  if (refreshJob !== -1) return;
  refreshJob = setTimeout(() => location.reload(), (4 * 3600000) + Math.floor(Math.random() * 10000));
}

function disarmRefreshTimer() {
  if (refreshJob === -1) return;
  clearTimeout(refreshJob);
  refreshJob = -1;
}

// ---- Player preference enforcement (optimised, behaviour-preserving) ----
function applyPlayerPrefs() {
  try {
    const wantMuted = '{"default":false,"carousel":false}';
    const wantQuality = '{"default":"160p30"}';
    if (localStorage.getItem('video-muted') !== wantMuted) localStorage.setItem('video-muted', wantMuted);
    if (localStorage.getItem('video-quality') !== wantQuality) localStorage.setItem('video-quality', wantQuality);
    if (localStorage.getItem('mature') !== 'true') localStorage.setItem('mature', 'true');
    if (prefs.lowLatDisable) {
      if (localStorage.getItem('lowLatencyModeEnabled') !== 'false') localStorage.setItem('lowLatencyModeEnabled', 'false');
    }
  } catch {
    /* noop */
  }
}

// ---- Overlay mount/unmount (fixes destructive DOM wipe) ----
function ensureStylesInstalled() {
  if (!document.head) return false;

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    // Scope everything under #tl-overlay to avoid impacting Twitch when leaving activation.
    style.textContent = `
#${OVERLAY_ID}{
  position:fixed; inset:0; z-index:2147483647;
  background:#0e0e10; color:#e5e7eb;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, "Noto Sans", "Helvetica Neue", "Segoe UI Emoji";
}
#${OVERLAY_ID} *{ box-sizing:border-box; }
#${STREAMS_ID}{
  position:absolute; inset:12px 392px 12px 12px;
  overflow:auto; display:flex; flex-wrap:wrap; gap:12px; align-content:flex-start;
  padding:0;
}
#${STREAMS_ID} > div{
  display:grid; place-items:start;
}

#${OVERLAY_ID} .tl-panel{
  position:fixed; right:12px; bottom:12px; width:360px; max-height:80vh; overflow:auto;
  background:#18181b; border:1px solid #2a2a2e; border-radius:14px;
  box-shadow:0 10px 25px rgba(0,0,0,.45);
  transform:translateX(0); transition:transform .18s ease-in-out;
}
#${OVERLAY_ID} .tl-panel.is-closed{ transform:translateX(calc(100% + 12px)); }

#${OVERLAY_ID} .tl-header{
  display:flex; align-items:center; gap:8px; padding:12px 14px;
  border-bottom:1px solid #2a2a2e; position:sticky; top:0; background:#18181b; z-index:2;
}
#${OVERLAY_ID} .tl-title{ font-weight:700; letter-spacing:.2px; }
#${OVERLAY_ID} .tl-badge{
  margin-left:auto; font-size:12px; padding:2px 8px; border-radius:999px;
  background:rgba(145,70,255,.12); color:#c9b6ff; border:1px solid rgba(145,70,255,.35);
}

#${OVERLAY_ID} .tl-section{ padding:12px 14px; border-bottom:1px solid #2a2a2e; }
#${OVERLAY_ID} .tl-section-title{
  font-size:12px; text-transform:uppercase; letter-spacing:.14em; color:#a1a1aa; margin-bottom:8px;
}
#${OVERLAY_ID} .tl-row{ display:flex; gap:8px; align-items:center; }
#${OVERLAY_ID} .tl-input{
  flex:1; background:#0f0f12; color:#e5e7eb; border:1px solid #2a2a2e; border-radius:10px;
  padding:8px 10px; outline:none;
}
#${OVERLAY_ID} .tl-input::placeholder{ color:#8b8b92; }
#${OVERLAY_ID} .tl-btn{
  border:1px solid #2a2a2e; background:#121216; color:#e5e7eb;
  padding:8px 10px; border-radius:10px; cursor:pointer;
}
#${OVERLAY_ID} .tl-btn:hover{ border-color:#37373d; }
#${OVERLAY_ID} .tl-btn-primary{
  background:linear-gradient(180deg, #9146ff, #772ce8); border-color:transparent; color:white;
}
#${OVERLAY_ID} .tl-btn-danger{
  background:linear-gradient(180deg, #f43f5e, #be123c); border-color:transparent; color:white;
}

#${OVERLAY_ID} .tl-chiplist{ display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
#${OVERLAY_ID} .tl-chip{
  display:inline-flex; align-items:center; gap:8px;
  background:#101014; border:1px solid #2a2a2e; padding:6px 9px; border-radius:999px; font-size:12px;
}
#${OVERLAY_ID} .tl-chip button{ all:unset; cursor:pointer; font-weight:700; color:#bbb; }
#${OVERLAY_ID} .tl-chip button:hover{ color:#fff; }

#${OVERLAY_ID} .tl-grid{ display:grid; grid-template-columns: 1fr; gap:10px; }
#${OVERLAY_ID} .tl-switch{
  display:flex; align-items:center; justify-content:space-between;
  background:#101014; border:1px solid #2a2a2e; border-radius:10px; padding:10px 12px;
}
#${OVERLAY_ID} .tl-switch input[type="checkbox"]{
  width:38px; height:22px; appearance:none; background:#2b2b31; border-radius:999px;
  position:relative; outline:none; border:1px solid #3a3a41; cursor:pointer;
}
#${OVERLAY_ID} .tl-switch input[type="checkbox"]::after{
  content:''; width:18px; height:18px; border-radius:50%; background:#c9cad2;
  position:absolute; top:1px; left:1px; transition:left .15s ease;
}
#${OVERLAY_ID} .tl-switch input[type="checkbox"]:checked{ background:#9146ff; border-color:transparent; }
#${OVERLAY_ID} .tl-switch input[type="checkbox"]:checked::after{ left:calc(100% - 19px); background:white; }
#${OVERLAY_ID} .tl-switch small{ color:#a1a1aa; display:block; margin-top:2px; }

#${OVERLAY_ID} .tl-slider{ display:flex; align-items:center; gap:10px; }
#${OVERLAY_ID} .tl-slider input[type="range"]{ width:100%; accent-color:#9146ff; }

#${OVERLAY_ID} .tl-footer{
  position:sticky; bottom:0; padding:12px 14px; display:flex; justify-content:flex-start; gap:8px;
  background:#18181b; border-top:1px solid #2a2a2e;
}

#${OVERLAY_ID} .tl-fab{
  position:fixed; right:12px; bottom:12px; z-index:2147483647;
  width:44px; height:44px; border-radius:50%;
  border:none; background:linear-gradient(180deg, #9146ff, #772ce8);
  color:#fff; cursor:pointer; box-shadow:0 10px 25px rgba(0,0,0,.45);
  display:flex; align-items:center; justify-content:center; padding:0;
}
#${OVERLAY_ID} .tl-fab-icon{
  width:18px; height:12px; display:block;
  background:
    linear-gradient(currentColor 0 0) 0 0 / 100% 2px no-repeat,
    linear-gradient(currentColor 0 0) 0 50% / 100% 2px no-repeat,
    linear-gradient(currentColor 0 0) 0 100% / 100% 2px no-repeat;
}
    `;
    document.head.appendChild(style);
  }

  if (!document.getElementById(HIDE_STYLE_ID)) {
    const hide = document.createElement('style');
    hide.id = HIDE_STYLE_ID;
    // Hide Twitch app without destroying it. Reversible on exit.
    hide.textContent = `
html.tl-autolurk, body.tl-autolurk { overflow:hidden !important; }
body.tl-autolurk > :not(#${OVERLAY_ID}) { display:none !important; }
    `;
    document.head.appendChild(hide);
  }

  return true;
}

function mountOverlay() {
  if (!document.body || !document.head) return false;
  ensureStylesInstalled();

  if (!overlayRoot || !overlayRoot.isConnected) {
    overlayRoot = document.getElementById(OVERLAY_ID);
    if (!overlayRoot) {
      overlayRoot = document.createElement('div');
      overlayRoot.id = OVERLAY_ID;
      document.body.appendChild(overlayRoot);
    }
  }

  // Ensure streams host exists
  streamsHostEl = overlayRoot.querySelector(`#${STREAMS_ID}`);
  if (!streamsHostEl) {
    streamsHostEl = document.createElement('div');
    streamsHostEl.id = STREAMS_ID;
    overlayRoot.appendChild(streamsHostEl);
  }

  // Hide Twitch without clearing DOM
  try {
    document.documentElement.classList.add('tl-autolurk');
    document.body.classList.add('tl-autolurk');
  } catch {
    /* noop */
  }

  return true;
}

function unmountOverlay() {
  // Restore Twitch visibility
  try {
    document.documentElement.classList.remove('tl-autolurk');
    document.body.classList.remove('tl-autolurk');
  } catch {
    /* noop */
  }

  // Remove our overlay root
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) safeRemoveNode(existing);

  overlayRoot = null;
  streamsHostEl = null;

  // Remove UI-specific nodes; safe even if already gone
  safeRemoveNode(document.getElementById(STYLE_ID));
  safeRemoveNode(document.getElementById(HIDE_STYLE_ID));
}

function getStreamsHost() {
  const el = streamsHostEl || document.getElementById(STREAMS_ID);
  return el || document.body;
}

// ---- Theatre Mode helpers ----
function getTheatreButton(doc) {
  try {
    return doc.querySelector(THEATRE_BTN_SEL);
  } catch {
    return null;
  }
}

function isTheatreOn(btn) {
  if (!btn) return false;
  const pressed = btn.getAttribute('aria-pressed');
  if (pressed !== null) return pressed === 'true';
  const label = (btn.getAttribute('aria-label') || '').toLowerCase();
  return label.includes('exit theatre') || label.includes('exit theater');
}

function stopTheatreSync(sf) {
  if (!sf) return;

  if (sf.theatreObserver) {
    try { sf.theatreObserver.disconnect(); } catch { /* noop */ }
  }
  if (sf.theatreInterval) {
    clearInterval(sf.theatreInterval);
  }

  sf.theatreObserver = null;
  sf.theatreInterval = 0;
  sf.theatreDoc = null;
}

function ensureTheatreMode(sf) {
  if (!sf) return;

  if (!prefs.autoCinema) {
    stopTheatreSync(sf);
    return;
  }

  const curDoc = safeFrameDoc(sf);
  if (!curDoc) return;

  if (!sf.theatreDoc) sf.theatreDoc = curDoc;
  if (sf.theatreDoc && sf.theatreDoc !== curDoc) {
    stopTheatreSync(sf);
    sf.theatreDoc = curDoc;
  }

  const attempt = () => {
    const doc = safeFrameDoc(sf);
    if (!prefs.autoCinema || !doc) return false;
    const btn = getTheatreButton(doc);
    if (!btn) return false;
    if (!isTheatreOn(btn)) {
      btn.click();
      return false;
    }
    return true;
  };

  if (attempt()) {
    stopTheatreSync(sf);
    return;
  }

  if (!sf.theatreInterval) {
    sf.theatreInterval = setInterval(() => {
      const doc = safeFrameDoc(sf);
      if (!prefs.autoCinema || !doc) {
        stopTheatreSync(sf);
        return;
      }
      if (sf.theatreDoc && sf.theatreDoc !== doc) {
        stopTheatreSync(sf);
        sf.theatreDoc = doc;
      }
      if (attempt()) stopTheatreSync(sf);
    }, 1000);
  }

  if (!sf.theatreObserver) {
    const doc = safeFrameDoc(sf);
    if (!doc) return;

    sf.theatreDoc = doc;
    sf.theatreObserver = new MutationObserver(() => {
      if (attempt()) stopTheatreSync(sf);
    });

    try {
      sf.theatreObserver.observe(doc, { childList: true, subtree: true });
    } catch {
      try { sf.theatreObserver.disconnect(); } catch { /* noop */ }
      sf.theatreObserver = null;
    }
  }
}

// ---- Frame helpers ----
function onFrameLoaded(e) {
  const obj = streamFrames.find(x => x.frame === e.target);
  if (!obj) return;

  try {
    ['pushState', 'replaceState'].forEach(fn => {
      const h = e.target?.contentWindow?.history;
      if (!h || typeof h[fn] !== 'function') return;
      if (h[fn] && h[fn]._tl_wrapped) return;

      const prox = new Proxy(h[fn], {
        // eslint-disable-next-line func-names
        apply(target, thisArg, argList) {
          const url = argList?.[2];
          if (url) log(`${fn} to ${url}`);
          ensureTheatreMode(obj);
          return target.apply(thisArg, argList);
        }
      });

      prox._tl_wrapped = true;
      h[fn] = prox;
    });
  } catch {
    /* noop */
  }

  ensureTheatreMode(obj);
}

function setFrameSize(item) {
  item.frame.style.transform = `scale(${prefs.frameScale})`;
  item.container.style.width = `${Math.round(1100 * prefs.frameScale)}px`;
  item.container.style.height = `${Math.round(480 * prefs.frameScale)}px`;
}

function safeTearDownStream(sf) {
  try { stopTheatreSync(sf); } catch { /* noop */ }
  safeRemoveNode(sf?.container);
}

function teardownAllStreams() {
  try {
    for (const sf of streamFrames) safeTearDownStream(sf);
  } catch {
    /* noop */
  }
  streamFrames.length = 0;
}

function setupFrame(url) {
  log(`Setting up new frame for ${url}`);

  const elem = document.createElement('iframe');
  elem.src = url;
  elem.style.width = '1100px';
  elem.style.height = '480px';
  elem.style.gridColumnStart = '1';
  elem.style.gridRowStart = '1';
  elem.style.transformOrigin = '0 0';
  elem.addEventListener('load', onFrameLoaded);

  const container = document.createElement('div');
  container.style.position = 'relative';
  container.style.display = 'grid';
  container.style.placeItems = 'start';

  const result = {
    container,
    frame: elem,
    timeout: 0,
    wait: 0,
    theatreObserver: null,
    theatreInterval: 0,
    theatreDoc: null,

    // Chat tab gating (hardening)
    chatClicks: 0,
    chatLastClick: 0,
    chatPath: '',

    _path: '' // cached per detect pass
  };
  setFrameSize(result);

  const closeBtn = document.createElement('button');
  closeBtn.innerText = 'Close stream';
  closeBtn.style.gridColumnStart = '1';
  closeBtn.style.gridRowStart = '1';
  closeBtn.style.zIndex = '666';
  closeBtn.addEventListener('click', () => {
    safeTearDownStream(result);
    streamFrames = streamFrames.filter(x => x.frame !== elem);
    setStreamsBadge(streamFrames.length, null);
  });

  container.append(elem, closeBtn);

  const host = getStreamsHost();
  if (host) {
    host.appendChild(container);
  } else if (document.body) {
    document.body.appendChild(container);
  }

  streamFrames.push(result);
  ensureTheatreMode(result);

  setStreamsBadge(streamFrames.length, null);
  return result;
}

// ---- Request helpers ----
function headersToPlain(hLike) {
  const out = {};
  try {
    if (hLike && typeof hLike.forEach === 'function') {
      hLike.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
    } else if (hLike && typeof hLike === 'object') {
      for (const [k, v] of Object.entries(hLike)) out[String(k).toLowerCase()] = String(v);
    }
  } catch {
    /* noop */
  }

  for (const k of Object.keys(out)) {
    if (FORBIDDEN_HEADERS.has(k)) delete out[k];
  }
  return out;
}

// Hardened: allow adaptive anonymous mode, and preserve status in errors for smarter fallback.
function gmPostJSON(url, { headers, body, method = 'POST' }, anonymous = true) {
  return new Promise((resolve, reject) => {
    GM.xmlHttpRequest({
      url,
      method,
      data: body,
      headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
      timeout: 15000,
      anonymous: !!anonymous,
      onload: r => {
        if (r.status >= 200 && r.status < 400) {
          resolve(r.responseText);
          return;
        }
        const err = new Error(`HTTP ${r.status}`);
        try { err.status = r.status; } catch { /* noop */ }
        try { err.responseText = r.responseText; } catch { /* noop */ }
        reject(err);
      },
      onerror: e => reject(new Error(e?.error || 'Network error')),
      ontimeout: () => reject(new Error('Timeout'))
    });
  });
}

function responseLooksUnauthed(root) {
  try {
    if (!root) return false;

    // Common patterns: currentUser null / errors contain unauth code.
    const cu = root?.data?.currentUser;
    if (cu === null) return true;

    const errs = root?.errors;
    if (Array.isArray(errs)) {
      for (const er of errs) {
        const code = er?.extensions?.code;
        const msg = String(er?.message || '').toLowerCase();
        if (String(code || '').toUpperCase().includes('UNAUTH')) return true;
        if (msg.includes('unauth')) return true;
        if (msg.includes('login')) return true;
        if (msg.includes('authentication')) return true;
      }
    }
  } catch {
    /* noop */
  }
  return false;
}

function shouldFlipAnonymousOnHttpError(err) {
  const s = Number(err?.status || 0);
  return s === 401 || s === 403;
}

function canFlipAnonymous() {
  const last = Number(fetchOpts?._anonLastFlip || 0);
  const now = Date.now();
  // Prevent flapping: at most one flip per minute.
  return (now - last) >= 60000;
}

// ---- Chat tab gating (hardening) ----
function isTabActive(el) {
  try {
    if (!el) return false;
    const sel = el.getAttribute('aria-selected');
    if (sel === 'true') return true;
    const pressed = el.getAttribute('aria-pressed');
    if (pressed === 'true') return true;
    const parent = el.closest('[aria-selected="true"],[aria-pressed="true"]');
    return !!parent;
  } catch {
    return false;
  }
}

// Returns true when we want to short-circuit further per-frame checks (matches old behaviour).
function handleChatTab(sf, doc, pathLower) {
  try {
    const chatLink = doc.querySelector('a[tabname="chat"]');
    if (!chatLink) return false;

    // Reset gating state when stream path changes (or becomes known).
    const p = pathLower || '';
    if (sf.chatPath !== p) {
      sf.chatPath = p;
      sf.chatClicks = 0;
      sf.chatLastClick = 0;
    }

    const active = isTabActive(chatLink);
    if (!active) {
      const now = Date.now();
      const cooled = (now - (sf.chatLastClick || 0)) >= 15000; // 15s cooldown
      if (cooled && sf.chatClicks < 3) {
        sf.chatLastClick = now;
        sf.chatClicks += 1;
        chatLink.click();
        setTimeout(() => ensureTheatreMode(sf), 300);
      }
    }

    // Preserve original short-circuit intent: when chatLink exists, skip other per-frame actions.
    return true;
  } catch {
    return false;
  }
}

// ---- Detection loop ----
async function detect() {
  if (!isActivationPath()) return;
  if (prefs.detectPause || detectBusy) return;
  if (!fetchOpts?.url || !fetchOpts?.opts) return;

  detectBusy = true;
  try {
    let items = null;

    // Hardened: adaptive anonymous mode
    let text = null;
    let parsed = null;
    let usedAnonymous = !!fetchOpts.anonymous;
    let flippedThisPass = false;

    const doRequest = async (anon) => gmPostJSON(fetchOpts.url, fetchOpts.opts, anon);

    try {
      text = await doRequest(usedAnonymous);
    } catch (err) {
      if (shouldFlipAnonymousOnHttpError(err) && canFlipAnonymous()) {
        const nextAnon = !usedAnonymous;
        fetchOpts._anonLastFlip = Date.now();
        flippedThisPass = true;
        usedAnonymous = nextAnon;
        log(`detect() HTTP auth error; retrying with anonymous=${String(nextAnon)}`);
        try {
          text = await doRequest(nextAnon);
          fetchOpts.anonymous = nextAnon; // persist working mode (session)
        } catch (err2) {
          log(`detect() request failed: ${err2?.message || String(err2)}`);
          text = null;
        }
      } else {
        log(`detect() request failed: ${err?.message || String(err)}`);
        text = null;
      }
    }

    if (typeof text === 'string') {
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        log(`detect() JSON parse failed: ${e?.message || String(e)}`);
        parsed = null;
      }
    }

    if (parsed) {
      const root = Array.isArray(parsed) ? parsed[0] : parsed;
      const edges = root?.data?.currentUser?.followedLiveUsers?.edges;

      if (!Array.isArray(edges) && responseLooksUnauthed(root) && !flippedThisPass && canFlipAnonymous()) {
        // If the payload looks unauthenticated, do one controlled retry flipping anonymous mode.
        const nextAnon = !usedAnonymous;
        fetchOpts._anonLastFlip = Date.now();
        log(`detect() payload looks unauthenticated; retrying with anonymous=${String(nextAnon)}`);
        try {
          const t2 = await doRequest(nextAnon);
          const p2 = JSON.parse(t2);
          const r2 = Array.isArray(p2) ? p2[0] : p2;
          const e2 = r2?.data?.currentUser?.followedLiveUsers?.edges;
          if (Array.isArray(e2)) {
            fetchOpts.anonymous = nextAnon; // persist working mode (session)
            items = e2
              .map(e => e?.node?.login)
              .filter(Boolean)
              .map(s => `/${String(s).toLowerCase()}`);
          } else {
            const diag2 = r2?.errors ? { errors: r2.errors } : r2;
            log(`Live list missing after retry. Payload: ${JSON.stringify(diag2)}`);
            items = null;
          }
        } catch (e) {
          log(`detect() retry failed: ${e?.message || String(e)}`);
          items = null;
        }
      } else if (Array.isArray(edges)) {
        items = edges
          .map(e => e?.node?.login)
          .filter(Boolean)
          .map(s => `/${String(s).toLowerCase()}`);
      } else {
        const diag = root?.errors ? { errors: root.errors } : root;
        log(`Live list missing or unexpected. Payload: ${JSON.stringify(diag)}`);
        items = null;
      }
    } else {
      items = null;
    }

    const itemsSet = Array.isArray(items) ? new Set(items) : null;

    // Step 1: prune/maintain frames
    const nextFrames = [];
    const seenPaths = new Set();

    for (const sf of streamFrames) {
      const doc = safeFrameDoc(sf);
      if (!doc) {
        log(`Frame ${sf.frame?.src || '(unknown)'} invalid`);
        safeTearDownStream(sf);
        continue;
      }

      const pathLower = tryGetPathLower(doc);
      sf._path = pathLower;

      if (pathLower) {
        if (!seenPaths.has(pathLower)) {
          sf.wait = 0;
          seenPaths.add(pathLower);
        } else if (++sf.wait > 2) {
          log(`Frame ${pathLower} duplicated`);
          safeTearDownStream(sf);
          continue;
        }
      }

      // Hardening: gate repeated chat-tab clicking; preserve old short-circuit behaviour.
      if (handleChatTab(sf, doc, pathLower)) {
        nextFrames.push(sf);
        continue;
      }

      let hostLink = doc.querySelector('a[data-a-target="hosting-indicator"]');
      if (!hostLink) {
        hostLink = Array
          .from(doc.querySelectorAll('a.tw-link'))
          .find(a => /Watch\s+\w+\s+with\s+\d+\s+viewers/.test(a.innerText));
      }
      if (hostLink) {
        log(`Frame ${pathLower || sf.frame?.src} redirecting to ${hostLink.href}`);
        hostLink.click();
        setTimeout(() => ensureTheatreMode(sf), 500);
      }

      const vid = doc.querySelector('video');
      if (vid && !vid.paused && !vid.ended && vid.readyState > 2) {
        sf.timeout = 0;
      } else if (++sf.timeout > 6) {
        log(`Frame ${pathLower || sf.frame?.src} timed out`);
        safeTearDownStream(sf);
        continue;
      }

      nextFrames.push(sf);
    }

    streamFrames = nextFrames;

    // Step 2: auto-close no longer live
    if (prefs.autoClose && itemsSet) {
      const kept = [];
      for (const sf of streamFrames) {
        const p = sf._path || getFramePathLower(sf);
        sf._path = p;

        if (p && !itemsSet.has(p)) {
          log(`Frame ${p} auto-closing`);
          safeTearDownStream(sf);
          continue;
        }
        kept.push(sf);
      }
      streamFrames = kept;
    }

    // Step 3: filtered open list
    const openCandidates = (Array.isArray(items))
      ? ((prefs.whitelist.length)
        ? items.filter(x => prefs.whitelist.includes(x.slice(1)))
        : items)
      : [];

    // Step 4: enforce MAX_FRAMES cap
    if (streamFrames.length > MAX_FRAMES) {
      if (openCandidates.length) {
        const desired = new Set(openCandidates.slice(0, MAX_FRAMES));
        const kept = [];
        const extras = [];

        for (const fr of streamFrames) {
          const p = fr._path || getFramePathLower(fr);
          fr._path = p;
          if (p && desired.has(p)) {
            kept.push(fr);
            desired.delete(p);
          } else {
            extras.push(fr);
          }
        }

        const allowedExtras = Math.max(0, MAX_FRAMES - kept.length);
        for (const fr of extras.slice(0, allowedExtras)) kept.push(fr);

        for (const fr of extras.slice(allowedExtras)) {
          log(`Closing extra frame ${fr._path || fr.frame?.src}`);
          safeTearDownStream(fr);
        }
        streamFrames = kept;
      } else {
        const toClose = streamFrames.slice(MAX_FRAMES);
        for (const fr of toClose) {
          log(`Closing extra frame ${fr._path || fr.frame?.src}`);
          safeTearDownStream(fr);
        }
        streamFrames = streamFrames.slice(0, MAX_FRAMES);
      }
    }

    // Step 5: open new frames if slots available
    const openPathsSet = new Set(streamFrames.map(f => f._path).filter(Boolean));

    const slots = Math.max(0, MAX_FRAMES - streamFrames.length);
    if (slots > 0 && openCandidates.length) {
      const needToOpen = [];
      for (const p of openCandidates) {
        if (!openPathsSet.has(p)) needToOpen.push(p);
        if (needToOpen.length >= slots) break;
      }

      if (needToOpen.length) {
        applyPlayerPrefs();
        needToOpen.forEach(setupFrame);
      }
    }

    // Step 6: theatre syncing
    if (prefs.autoCinema) {
      for (const sf of streamFrames) {
        const doc = safeFrameDoc(sf);
        if (!doc) continue;

        const isSyncing = !!(sf.theatreObserver || sf.theatreInterval);
        const docChanged = !!(sf.theatreDoc && sf.theatreDoc !== doc);

        if (!isSyncing || docChanged) ensureTheatreMode(sf);
      }
    }

    // Step 7: badge
    setStreamsBadge(streamFrames.length, Array.isArray(items) ? items.length : null);
  } finally {
    detectBusy = false;
  }
}

// ---- Settings UI / helpers ----
function setRefresh(value) {
  prefs.autoRefresh = value;
  if (value) armRefreshTimer();
  else disarmRefreshTimer();
}

function setStreamsBadge(openCount, liveCount) {
  const el = document.getElementById('tl-stats');
  if (!el) return;
  const hasLive = (liveCount !== null && liveCount !== undefined);
  el.textContent = hasLive ? `${openCount} / ${liveCount} streams` : `${openCount} streams`;
}

function makeSwitch(id, label, hint, init, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'tl-switch';

  const left = document.createElement('div');
  const title = document.createElement('div');
  title.textContent = label;
  const small = document.createElement('small');
  small.textContent = hint || '';
  left.append(title, small);

  const togg = document.createElement('input');
  togg.type = 'checkbox';
  togg.id = id;
  togg.checked = init;
  togg.addEventListener('change', () => onChange(togg.checked));

  wrap.append(left, togg);
  return wrap;
}

function renderWhitelistChips(container) {
  container.innerHTML = '';
  prefs.whitelist.forEach(name => {
    const chip = document.createElement('span');
    chip.className = 'tl-chip';
    chip.textContent = `${name} `;
    const x = document.createElement('button');
    x.setAttribute('aria-label', 'Remove');
    x.textContent = '×';
    x.addEventListener('click', e => {
      e.preventDefault();
      const idx = prefs.whitelist.indexOf(name);
      if (idx > -1) prefs.whitelist.splice(idx, 1);
      GM.setValue('whitelist', prefs.whitelist.join(','));
      renderWhitelistChips(container);
    });
    chip.append(x);
    container.append(chip);
  });
}

async function setupControls() {
  await loadPrefs();
  setRefresh(prefs.autoRefresh);

  applyPlayerPrefs();

  // Mount overlay without destroying Twitch DOM
  if (!mountOverlay()) {
    setTimeout(setupControls, 50);
    return;
  }

  // Clear any previous overlay UI (keep streams host if it exists)
  overlayRoot = document.getElementById(OVERLAY_ID) || overlayRoot;
  if (!overlayRoot) return;

  streamsHostEl = overlayRoot.querySelector(`#${STREAMS_ID}`) || streamsHostEl;
  // Remove existing UI nodes but keep streams host
  for (const child of Array.from(overlayRoot.children)) {
    if (child && child.id !== STREAMS_ID) safeRemoveNode(child);
  }

  // Panel
  const panel = document.createElement('div');
  panel.className = 'tl-panel is-closed';
  panel.id = 'tl-panel';

  // Header
  const header = document.createElement('div');
  header.className = 'tl-header';
  const title = document.createElement('div');
  title.className = 'tl-title';
  title.textContent = 'Auto-lurk Settings';
  const badge = document.createElement('div');
  badge.className = 'tl-badge';
  badge.id = 'tl-stats';
  badge.textContent = '0 streams';
  header.append(title, badge);

  // Section: Whitelist
  const sWL = document.createElement('div');
  sWL.className = 'tl-section';
  const sWLTitle = document.createElement('div');
  sWLTitle.className = 'tl-section-title';
  sWLTitle.textContent = 'Whitelist';

  const wlRow = document.createElement('form');
  wlRow.className = 'tl-row';
  wlRow.autocomplete = 'off';

  const wlInput = document.createElement('input');
  wlInput.className = 'tl-input';
  wlInput.placeholder = 'Add channel (username)';
  wlInput.spellcheck = false;

  const wlAdd = document.createElement('button');
  wlAdd.className = 'tl-btn tl-btn-primary';
  wlAdd.type = 'submit';
  wlAdd.textContent = 'Add';

  wlRow.append(wlInput, wlAdd);

  const chips = document.createElement('div');
  chips.className = 'tl-chiplist';
  chips.id = 'tl-chips';

  wlRow.addEventListener('submit', e => {
    e.preventDefault();
    const v = wlInput.value.trim().toLowerCase();
    if (!v || prefs.whitelist.includes(v)) return;
    prefs.whitelist.push(v);
    prefs.whitelist.sort();
    GM.setValue('whitelist', prefs.whitelist.join(','));
    wlInput.value = '';
    renderWhitelistChips(chips);
  });

  renderWhitelistChips(chips);
  sWL.append(sWLTitle, wlRow, chips);

  // Section: Switches
  const sSW = document.createElement('div');
  sSW.className = 'tl-section';
  const sSWTitle = document.createElement('div');
  sSWTitle.className = 'tl-section-title';
  sSWTitle.textContent = 'Behaviour';

  const grid = document.createElement('div');
  grid.className = 'tl-grid';
  grid.append(
    makeSwitch('sw-autoclose', 'Auto-close raids & hosts', 'Remove frames not in your live list', prefs.autoClose, v => {
      prefs.autoClose = v;
      GM.setValue('autoClose', v);
    }),
    makeSwitch('sw-cinema', 'Auto enable Theatre Mode', 'Apply inside each frame when possible', prefs.autoCinema, v => {
      prefs.autoCinema = v;
      GM.setValue('autoCinema', v);
      if (v) streamFrames.forEach(ensureTheatreMode);
      else streamFrames.forEach(stopTheatreSync);
    }),
    makeSwitch('sw-refresh', 'Refresh page every 4 hours', 'Only while on the Auto-lurk page', prefs.autoRefresh, v => {
      setRefresh(v);
      GM.setValue('autoRefresh', v);
    }),
    makeSwitch('sw-lowlat', 'Disable low-latency mode', 'Reduce bandwidth/CPU usage', prefs.lowLatDisable, v => {
      prefs.lowLatDisable = v;
      GM.setValue('lowLatDisable', v);
      applyPlayerPrefs();
    }),
    makeSwitch('sw-pause', 'Pause streams detection', 'Stops polling & frame changes', prefs.detectPause, v => {
      prefs.detectPause = v;
      GM.setValue('detectPause', v);
    }),
    makeSwitch('sw-panelopen', 'Open panel on load', 'Show settings drawer automatically on this page', prefs.panelAutoOpen, v => {
      prefs.panelAutoOpen = v;
      GM.setValue('panelAutoOpen', v);
    })
  );
  sSW.append(sSWTitle, grid);

  // Section: Scale
  const sSL = document.createElement('div');
  sSL.className = 'tl-section';
  const sSLTitle = document.createElement('div');
  sSLTitle.className = 'tl-section-title';
  sSLTitle.textContent = 'Frame scale';

  const sliderRow = document.createElement('div');
  sliderRow.className = 'tl-slider';

  const range = document.createElement('input');
  range.type = 'range';
  range.min = '0.1';
  range.max = '1';
  range.step = '0.05';
  range.value = String(prefs.frameScale);

  const out = document.createElement('div');
  out.style.minWidth = '48px';
  out.textContent = `${Math.round(prefs.frameScale * 100)}%`;

  range.addEventListener('input', () => { out.textContent = `${Math.round(Number(range.value) * 100)}%`; });
  range.addEventListener('change', () => {
    prefs.frameScale = Number(range.value);
    GM.setValue('frameScale', prefs.frameScale);
    out.textContent = `${Math.round(prefs.frameScale * 100)}%`;
    streamFrames.forEach(setFrameSize);
  });

  sliderRow.append(range, out);
  sSL.append(sSLTitle, sliderRow);

  // Footer
  const foot = document.createElement('div');
  foot.className = 'tl-footer';

  const closeAll = document.createElement('button');
  closeAll.className = 'tl-btn tl-btn-danger';
  closeAll.textContent = 'Close all streams';
  closeAll.addEventListener('click', () => {
    teardownAllStreams();
    setStreamsBadge(0, null);
  });
  foot.append(closeAll);

  panel.append(header, sWL, sSW, sSL, foot);

  // Floating action button (icon drawn in CSS for perfect centring)
  const fab = document.createElement('button');
  fab.type = 'button';
  fab.className = 'tl-fab';
  fab.id = 'tl-toggle';
  fab.setAttribute('aria-expanded', 'false');
  fab.title = 'Settings panel';

  const fabIcon = document.createElement('span');
  fabIcon.className = 'tl-fab-icon';
  fabIcon.setAttribute('aria-hidden', 'true');
  fab.appendChild(fabIcon);

  fab.addEventListener('click', () => {
    const closed = panel.classList.toggle('is-closed');
    fab.setAttribute('aria-expanded', String(!closed));
  });

  overlayRoot.append(panel, fab);

  // Respect saved preference: open panel on load only if enabled
  if (prefs.panelAutoOpen) {
    panel.classList.remove('is-closed');
    fab.setAttribute('aria-expanded', 'true');
  }
}

// ---- Detect loop control ----
function startDetectLoop() {
  if (detectJob !== -1) return;
  detectJob = setInterval(detect, 10000);
}

function stopDetectLoop() {
  if (detectJob === -1) return;
  clearInterval(detectJob);
  detectJob = -1;
}

// ---- Tab injection (refactored scoring; no double-scan) ----
function markTabNode(node) {
  try {
    if (!node) return;
    node.setAttribute(TAB_MARK_ATTR, TAB_MARK_VAL);
  } catch {
    /* noop */
  }
}

function findMarkedAutoLurkTabNode(within) {
  try {
    const scope = within && within.querySelector ? within : document;
    return scope.querySelector(`[${TAB_MARK_ATTR}="${TAB_MARK_VAL}"]`);
  } catch {
    return null;
  }
}

function pruneDuplicateAutoLurkTabs(preferredContainer) {
  try {
    const nodes = Array.from(document.querySelectorAll(`[${TAB_MARK_ATTR}="${TAB_MARK_VAL}"]`));
    if (nodes.length <= 1) return;

    const keep = (preferredContainer && nodes.find(n => preferredContainer.contains(n))) || nodes[0];
    for (const n of nodes) {
      if (n !== keep) safeRemoveNode(n);
    }
  } catch {
    /* noop */
  }
}

function isFollowingLinkAnchor(a) {
  try {
    if (!a) return false;
    const hrefAttr = a.getAttribute('href') || '';
    if (hrefAttr.startsWith('/directory/following')) return true;
    const p = a.pathname;
    return typeof p === 'string' && p.startsWith('/directory/following');
  } catch {
    return false;
  }
}

function isActivationLinkAnchor(a) {
  try {
    if (!a) return false;
    const hrefAttr = a.getAttribute('href') || '';
    if (hrefAttr === activationPath || hrefAttr.endsWith(activationPath)) return true;
    const p = a.pathname;
    return typeof p === 'string' && p === activationPath;
  } catch {
    return false;
  }
}

function resolveTabNodeForAnchor(a) {
  try {
    if (!a) return null;
    return (
      a.closest('li[role="presentation"], li[role="tab"], [role="tab"]') ||
      a.closest('li') ||
      null
    );
  } catch {
    return null;
  }
}

function adoptLegacyAutoLurkTabInContainer(container) {
  try {
    if (!container || !container.querySelectorAll) return false;

    const anchors = Array.from(container.querySelectorAll('a'));
    const a = anchors.find(isActivationLinkAnchor);
    if (!a) return false;

    const tabNode = resolveTabNodeForAnchor(a);
    if (!tabNode) return false;

    if (!container.contains(tabNode)) return false;

    markTabNode(tabNode);
    return true;
  } catch {
    return false;
  }
}

function scoreFromTabsMetrics({ distinctCount, liCount, hasTablist }) {
  if (distinctCount >= 2 && liCount >= 2) {
    return (distinctCount * 10) + liCount + (hasTablist ? 5 : 0);
  }

  // Fallback is capped so it cannot outscore a likely-correct primary match (>=22).
  if (hasTablist && distinctCount >= 1 && liCount >= 2) {
    return 19;
  }

  return -1;
}

function computeTabsContainerMetrics(container) {
  try {
    if (!container || !container.isConnected) {
      return { score: -1, tablistRank: 0, distinctCount: 0, anchorCount: 0, liCount: 0, hasTablist: false };
    }

    const liCount = container.querySelectorAll('li[role="presentation"], li[role="tab"], [role="tab"]').length;

    const anchors = Array.from(container.querySelectorAll('a')).filter(isFollowingLinkAnchor);
    const anchorCount = anchors.length;

    const distinct = new Set();
    for (const a of anchors) {
      const hrefAttr = a.getAttribute('href') || '';
      const key = hrefAttr.startsWith('/directory/following') ? hrefAttr : (a.pathname || '');
      if (key) distinct.add(key);
    }
    const distinctCount = distinct.size;

    const isRoleTablist = container.getAttribute('role') === 'tablist';
    const withinTablist = !!container.closest('[role="tablist"]');
    const hasTablist = isRoleTablist || withinTablist;
    const tablistRank = isRoleTablist ? 2 : (withinTablist ? 1 : 0);

    const score = scoreFromTabsMetrics({ distinctCount, liCount, hasTablist });

    return { score, tablistRank, distinctCount, anchorCount, liCount, hasTablist };
  } catch {
    return { score: -1, tablistRank: 0, distinctCount: 0, anchorCount: 0, liCount: 0, hasTablist: false };
  }
}

function compareDocumentOrder(a, b) {
  try {
    if (a === b) return 0;
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  } catch {
    return 0;
  }
}

function findBestTabsContainer() {
  try {
    if (!document.body) return null;

    const anchors = Array.from(document.querySelectorAll('a')).filter(isFollowingLinkAnchor);
    if (!anchors.length) return null;

    const candidatesSet = new Set();

    for (const a of anchors) {
      const li = a.closest('li[role="presentation"], li[role="tab"], [role="tab"]');
      if (li && li.parentElement) candidatesSet.add(li.parentElement);
      const ul = a.closest('ul');
      if (ul) candidatesSet.add(ul);
      const tablist = a.closest('[role="tablist"]');
      if (tablist) candidatesSet.add(tablist);
    }

    const candidates = Array.from(candidatesSet);
    if (!candidates.length) return null;

    let best = null;
    let bestM = null;

    for (const c of candidates) {
      const m = computeTabsContainerMetrics(c);
      if (m.score < 0) continue;

      if (!best) {
        best = c;
        bestM = m;
        continue;
      }

      if (m.score > bestM.score) {
        best = c;
        bestM = m;
        continue;
      }
      if (m.score < bestM.score) continue;

      if (m.tablistRank > bestM.tablistRank) {
        best = c;
        bestM = m;
        continue;
      }
      if (m.tablistRank < bestM.tablistRank) continue;

      if (m.distinctCount > bestM.distinctCount) {
        best = c;
        bestM = m;
        continue;
      }
      if (m.distinctCount < bestM.distinctCount) continue;

      if (m.anchorCount > bestM.anchorCount) {
        best = c;
        bestM = m;
        continue;
      }
      if (m.anchorCount < bestM.anchorCount) continue;

      if (m.liCount > bestM.liCount) {
        best = c;
        bestM = m;
        continue;
      }
      if (m.liCount < bestM.liCount) continue;

      if (compareDocumentOrder(c, best) < 0) {
        best = c;
        bestM = m;
      }
    }

    return best;
  } catch {
    return null;
  }
}

function scheduleTabInjection() {
  if (tabInjectTimer) return;
  tabInjectTimer = setTimeout(() => {
    tabInjectTimer = 0;
    maybeInjectTab();
    ensureTabsObserverAttached();
  }, 200);
}

function maybeInjectTab() {
  if (!isFollowingArea() || isActivationPath()) return false;
  if (!document.body) return false;

  const container = findBestTabsContainer();
  if (!container) return false;

  const existingInContainer = findMarkedAutoLurkTabNode(container);
  if (existingInContainer) {
    pruneDuplicateAutoLurkTabs(container);
    return true;
  }

  if (adoptLegacyAutoLurkTabInContainer(container)) {
    pruneDuplicateAutoLurkTabs(container);
    return true;
  }

  const existingGlobal = findMarkedAutoLurkTabNode(null);
  if (existingGlobal && !container.contains(existingGlobal)) {
    safeRemoveNode(existingGlobal);
  }

  const tabItems = container.querySelectorAll('li[role="presentation"], li[role="tab"], [role="tab"]');
  if (!tabItems.length) return false;

  const lastTab = tabItems[tabItems.length - 1];

  if (findMarkedAutoLurkTabNode(container)) {
    pruneDuplicateAutoLurkTabs(container);
    return true;
  }

  // Hardening: match the injected node tag to lastTab.tagName (prevents invalid structure under non-UL tablists).
  let tag = 'li';
  try {
    const t = lastTab?.tagName;
    if (t && typeof t === 'string') tag = t.toLowerCase();
  } catch {
    /* noop */
  }

  const newTab = document.createElement(tag);
  newTab.className = lastTab.className || '';
  newTab.innerHTML = lastTab.innerHTML;
  markTabNode(newTab);

  const link = newTab.querySelector('a');
  if (!link) return false;

  try { link.setAttribute('href', activationPath); } catch { link.href = activationPath; }

  const tNode = link.querySelector("[class^='ScTitle']");
  if (tNode) tNode.innerText = 'Auto-lurk';

  if (findMarkedAutoLurkTabNode(container)) {
    pruneDuplicateAutoLurkTabs(container);
    return true;
  }

  container.appendChild(newTab);
  log('Auto-lurk navigation tab injected');
  return true;
}

function disconnectTabsObserver() {
  if (!tabsObserver) return;
  try { tabsObserver.disconnect(); } catch { /* noop */ }
  tabsObserver = null;
  tabsObservedRoot = null;
}

function ensureTabsObserverAttached() {
  if (!isFollowingArea() || isActivationPath()) {
    disconnectTabsObserver();
    return;
  }

  const container = findBestTabsContainer();
  if (!container) {
    disconnectTabsObserver();
    return;
  }

  if (tabsObserver && tabsObservedRoot === container) return;

  disconnectTabsObserver();

  tabsObservedRoot = container;
  tabsObserver = new MutationObserver(() => {
    scheduleTabInjection();
  });

  try {
    tabsObserver.observe(container, { childList: true, subtree: false });
  } catch {
    disconnectTabsObserver();
  }
}

function startTabsWatchdog() {
  if (tabsWatchdogJob !== -1) return;
  tabsWatchdogJob = setInterval(() => {
    if (!isFollowingArea() || isActivationPath()) {
      stopTabsWatchdog();
      disconnectTabsObserver();
      return;
    }
    maybeInjectTab();
    ensureTabsObserverAttached();
  }, 5000);
}

function stopTabsWatchdog() {
  if (tabsWatchdogJob === -1) return;
  clearInterval(tabsWatchdogJob);
  tabsWatchdogJob = -1;
}

function ensureTabsWatchState() {
  if (!isFollowingArea() || isActivationPath()) {
    stopTabsWatchdog();
    disconnectTabsObserver();
    return;
  }
  startTabsWatchdog();
  ensureTabsObserverAttached();
  scheduleTabInjection();
}

// ---- Activation initialisation (SPA-safe) ----
function maybeInitActivation() {
  if (!isActivationPath()) {
    // Stop background work + teardown streams + remove overlay so Twitch returns instantly.
    stopDetectLoop();
    teardownAllStreams();
    unmountOverlay();

    // Risk B: do not allow refresh to fire outside activation.
    disarmRefreshTimer();
    return;
  }

  if (!fetchOpts?.url || !fetchOpts?.opts) return;

  if (isUiPresent()) {
    mountOverlay();
    // Ensure refresh timer is armed while in activation (preference-driven).
    armRefreshTimer();
    startDetectLoop();
    return;
  }

  if (!document.body || !document.head) {
    setTimeout(maybeInitActivation, 50);
    return;
  }

  setupControls()
    .then(() => {
      startDetectLoop();
      setTimeout(detect, 250);
    })
    .catch(e => log(`setupControls() failed: ${e?.message || String(e)}`));
}

// ---- Fetch interception (SPA-safe + Request-safe) ----
const MAX_CAPTURE_BODY_CHARS = 250000;

// Hardened: use an explicit page-global state to prevent false "already installed" decisions
// (and to detect if window.fetch gets replaced later).
const FETCH_PROXY_STATE_KEY = '__tl_autolurk_fetch_proxy_state_v13';
let localFetchProxyRef = null;

function getFetchProxyState(uw) {
  try {
    return uw ? uw[FETCH_PROXY_STATE_KEY] : null;
  } catch {
    return null;
  }
}

function setFetchProxyState(uw, state) {
  try {
    if (!uw) return;
    uw[FETCH_PROXY_STATE_KEY] = state;
  } catch {
    /* noop */
  }
}

function tryCaptureLiveList({ pathOk, reqUrl, method, headersLike, bodyStr, callerMeta }) {
  try {
    if (!pathOk) return;
    if (!reqUrl || !reqUrl.includes('gql.twitch.tv')) return;
    if (method && String(method).toUpperCase() !== 'POST') return;
    if (typeof bodyStr !== 'string') return;
    if (bodyStr.length > MAX_CAPTURE_BODY_CHARS) return;
    if (!bodyStr.includes('FollowingLive_CurrentUser')) return;

    log('Intercepted live list request');

    let opBody = null;
    try {
      const parsed = JSON.parse(bodyStr);
      opBody = Array.isArray(parsed)
        ? parsed.find(x => x?.operationName === 'FollowingLive_CurrentUser')
        : (parsed?.operationName === 'FollowingLive_CurrentUser' ? parsed : null);
    } catch (e) {
      log(`Body parse error: ${e?.message || String(e)}`);
    }

    if (!opBody) return;

    const plainHeaders = headersToPlain(headersLike || {});
    const forwardedVars = Object.assign({}, opBody.variables || {}, { limit: 50, includeIsDJ: false });

    fetchOpts.url = reqUrl;
    fetchOpts.opts = {
      method: 'POST',
      headers: plainHeaders,
      body: JSON.stringify([{
        operationName: opBody.operationName,
        variables: forwardedVars,
        extensions: opBody.extensions
      }])
    };

    // Hardened: choose initial anonymous mode intelligently.
    // - If we captured Authorization, we can usually avoid cookies (anonymous=true).
    // - If not, we likely need cookies (anonymous=false).
    const hasAuth = !!plainHeaders.authorization;
    fetchOpts.anonymous = hasAuth;
    if (!fetchOpts._anonLastFlip) fetchOpts._anonLastFlip = 0;

    setTimeout(maybeInitActivation, 0);
  } catch (e) {
    log(`Capture error: ${e?.message || String(e)}`);
  }
}

function ensureFetchProxy() {
  const uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  let curFetch = null;
  try {
    curFetch = uw?.fetch;
  } catch {
    return;
  }
  if (typeof curFetch !== 'function') return;

  // Fast path: our locally-tracked proxy is still installed.
  if (localFetchProxyRef && curFetch === localFetchProxyRef) return;

  // If page-global state indicates the installed proxy is current, accept it.
  const st = getFetchProxyState(uw);
  if (st && st.version === 13 && st.proxy && st.proxy === curFetch) {
    localFetchProxyRef = st.proxy;
    return;
  }

  const originalFetch = curFetch;

  try {
    const prox = new Proxy(originalFetch, {
      // eslint-disable-next-line func-names
      apply(target, thisArg, argList) {
        try {
          const [input, opts = {}] = argList;

          const pathOk = isFollowingArea();

          const reqUrl = (typeof input === 'string')
            ? input
            : (input && typeof input.url === 'string' ? input.url : '');

          if (!pathOk || !reqUrl || !reqUrl.includes('gql.twitch.tv')) {
            return target.apply(thisArg, argList);
          }

          const callerMeta = SCRIPT_NAME;
          const method = opts?.method || (input && input.method) || 'GET';
          const headersLike = opts?.headers || (input && input.headers) || {};

          // Fast path: fetch(url, { body: "..." })
          if (typeof opts?.body === 'string') {
            if (opts._meta !== callerMeta) {
              tryCaptureLiveList({ pathOk, reqUrl, method, headersLike, bodyStr: opts.body, callerMeta });
            }
            return target.apply(thisArg, argList);
          }

          // Request path: fetch(Request) with implicit body
          const isCloneable = input && typeof input === 'object' && typeof input.clone === 'function';
          if (isCloneable && opts._meta !== callerMeta) {
            try {
              const cloned = input.clone();
              if (cloned && typeof cloned.text === 'function') {
                cloned.text().then(bodyStr => {
                  tryCaptureLiveList({ pathOk, reqUrl, method, headersLike, bodyStr, callerMeta });
                }).catch(() => { /* noop */ });
              }
            } catch {
              /* noop */
            }
          }
        } catch (e) {
          log(`Fetch proxy error: ${e?.message || String(e)}`);
        }

        return target.apply(thisArg, argList);
      }
    });

    // Track via both local reference and a page-global state object.
    localFetchProxyRef = prox;
    setFetchProxyState(uw, { version: 13, proxy: prox, original: originalFetch });

    uw.fetch = prox;
  } catch (e) {
    log(`Failed to install fetch proxy: ${e?.message || String(e)}`);
  }
}

// ---- Route watchdog (Risk A elimination, only when needed) ----
function startRouteWatchdog() {
  if (routeWatchdogJob !== -1) return;
  lastPathname = location.pathname;
  routeWatchdogJob = setInterval(() => {
    const p = location.pathname;
    if (p !== lastPathname) {
      lastPathname = p;
      handleRouteChange();
    }
  }, 500);
}

function stopRouteWatchdog() {
  if (routeWatchdogJob === -1) return;
  clearInterval(routeWatchdogJob);
  routeWatchdogJob = -1;
}

// ---- SPA navigation hooks (Risk A elimination) ----
function ensureNavHooks() {
  // Always attempt; if wrapping fails, we keep retrying, backed by a lightweight watchdog.
  let wrapped = false;

  try {
    const uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    if (!popHookInstalled) {
      try {
        uw.addEventListener('popstate', () => setTimeout(handleRouteChange, 0), true);
        popHookInstalled = true;
      } catch {
        // ignore
      }
    }

    const wrapHistory = (fnName) => {
      const h = uw.history;
      if (!h || typeof h[fnName] !== 'function') return false;
      if (h[fnName]._tl_wrapped) return true;

      const original = h[fnName];
      const wrappedFn = function (...args) {
        const ret = original.apply(this, args);
        setTimeout(handleRouteChange, 0);
        return ret;
      };
      wrappedFn._tl_wrapped = true;
      h[fnName] = wrappedFn;
      return true;
    };

    const a = wrapHistory('pushState');
    const b = wrapHistory('replaceState');
    wrapped = !!(a || b);
  } catch {
    wrapped = false;
  }

  if (wrapped) {
    navHooksInstalled = true;
    stopRouteWatchdog();
  } else {
    // Risk A: If we cannot wrap history yet, use watchdog and retry later.
    startRouteWatchdog();
    setTimeout(ensureNavHooks, 500);
  }
}

// ---- Bootstrap ----
function handleRouteChange() {
  ensureFetchProxy();
  ensureTabsWatchState();
  maybeInitActivation();
}

log(`Script loaded on path ${location.pathname}`);
ensureFetchProxy();
ensureTabsWatchState();
ensureNavHooks();
handleRouteChange();
