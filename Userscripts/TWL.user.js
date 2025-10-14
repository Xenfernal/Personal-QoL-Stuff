// ==UserScript==
// @name        Twitch Lurker
// @description Automatically lurk on Twitch channels you prefer to follow. Based on Twitching Lurkist userscript by Xspeed.
// @author      Xen
// @namespace   https://github.com/Xenfernal
// @version     1.0
// @icon        https://static.twitchcdn.net/assets/favicon-32-e29e246c157142c94346.png
// @match       *://www.twitch.tv/*
// @grant       GM.getValue
// @grant       GM.setValue
// @grant       GM.xmlHttpRequest
// @connect     gql.twitch.tv
// @license     MIT
// @homepageURL https://github.com/Xenfernal/Personal-QoL-Stuff/tree/main/Userscripts
// @downloadURL https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/TWL.user.js
// @updateURL   https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/TWL.user.js
// @run-at      document-start
// @noframes
// ==/UserScript==

/* global GM, unsafeWindow */
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

let intervalJob = -1;
let refreshJob = -1;
let fetchOpts = { init: false }; // { url, opts:{ method, headers, body } }
let streamFrames = [];
let detectBusy = false; // prevent overlapping detect() runs

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
  const name = (GM && GM.info && GM.info.script && GM.info.script.name) || 'Twitching Lurkist';
  console.log(`[${name}] ${txt}`);
}

function clearChildren(parent) {
  while (parent.firstChild) parent.removeChild(parent.lastChild);
}

// ---- Theatre Mode helpers (robust syncing) ----
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
  if (sf.theatreObserver) {
    try { sf.theatreObserver.disconnect(); } catch { /* noop */ }
  }
  if (sf.theatreInterval) {
    clearInterval(sf.theatreInterval);
  }
  sf.theatreObserver = null;
  sf.theatreInterval = 0;
}

function ensureTheatreMode(sf) {
  if (!sf || !sf.frame || !sf.frame.contentDocument) return;
  if (!prefs.autoCinema) { // user disabled auto theatre; stop enforcing
    stopTheatreSync(sf);
    return;
  }

  const doc = sf.frame.contentDocument;

  const attempt = () => {
    const btn = getTheatreButton(doc);
    if (!btn) return false;
    if (!isTheatreOn(btn)) {
      btn.click();
      // Give Twitch a moment to update aria-pressed; we'll re-check on next tick
      return false;
    }
    return true;
  };

  // If already on, ensure we aren't looping.
  if (attempt()) {
    stopTheatreSync(sf);
  } else {
    // Retry via interval (frequent, but lightweight)
    if (!sf.theatreInterval) {
      sf.theatreInterval = setInterval(() => {
        if (!prefs.autoCinema || !sf.frame?.contentDocument) {
          stopTheatreSync(sf);
          return;
        }
        if (attempt()) stopTheatreSync(sf);
      }, 1000);
    }
    // Also listen for DOM replacements inside the frame (navigations/renders)
    if (!sf.theatreObserver) {
      sf.theatreObserver = new MutationObserver(() => {
        if (attempt()) stopTheatreSync(sf);
      });
      sf.theatreObserver.observe(doc, { childList: true, subtree: true });
    }
  }
}

// ---- Frame helpers ----
function onFrameLoaded(e) {
  const obj = streamFrames.find(x => x.frame === e.target);
  ['pushState', 'replaceState'].forEach(fn => {
    e.target.contentWindow.history[fn] = new Proxy(e.target.contentWindow.history[fn], {
      // eslint-disable-next-line func-names
      apply(target, thisArg, argList) {
        const url = argList?.[2];
        if (url) log(`${fn} to ${url}`);
        ensureTheatreMode(obj);
        return target.apply(thisArg, argList);
      }
    });
  });

  // Initial try when the frame finishes loading
  ensureTheatreMode(obj);
}

function setFrameSize(item) {
  item.frame.style.transform = `scale(${prefs.frameScale})`;
  item.container.style.width = `${Math.round(1000 * prefs.frameScale)}px`;
  item.container.style.height = `${Math.round(480 * prefs.frameScale)}px`;
}

function setupFrame(url) {
  log(`Setting up new frame for ${url}`);

  const elem = document.createElement('iframe');
  elem.src = url;
  elem.style.width = '1000px';
  elem.style.height = '480px';
  elem.style.gridColumnStart = '1';
  elem.style.gridRowStart = '1';
  elem.style.transformOrigin = '0 0';
  elem.addEventListener('load', onFrameLoaded);

  const container = document.createElement('div');
  container.style.position = 'static';
  container.style.display = 'grid';
  container.style.placeItems = 'start';

  const result = { container, frame: elem, timeout: 0, wait: 0, theatre: false, theatreObserver: null, theatreInterval: 0 };
  setFrameSize(result);

  const closeBtn = document.createElement('button');
  closeBtn.innerText = 'Close stream';
  closeBtn.style.gridColumnStart = '1';
  closeBtn.style.gridRowStart = '1';
  closeBtn.style.zIndex = '666';
  closeBtn.addEventListener('click', () => {
    stopTheatreSync(result);
    container.parentElement.removeChild(container);
    streamFrames = streamFrames.filter(x => x.frame !== elem);
    setStreamsBadge(streamFrames.length, null);
  });

  container.append(elem, closeBtn);

  // Origin-wide player preferences
  localStorage.setItem('video-muted', '{"default":false,"carousel":false}');
  localStorage.setItem('video-quality', '{"default":"160p30"}');
  localStorage.setItem('mature', 'true');
  if (prefs.lowLatDisable) localStorage.setItem('lowLatencyModeEnabled', 'false');

  document.body.append(container);
  streamFrames.push(result);

  // Kick off theatre enforcement early (in case controls render before 'load' fires)
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
  const forbidden = new Set([
    'accept-encoding', 'accept-charset', 'access-control-request-headers', 'access-control-request-method',
    'connection', 'content-length', 'cookie', 'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive',
    'origin', 'referer', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'via',
    'user-agent', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'
  ]);
  for (const k of Object.keys(out)) if (forbidden.has(k)) delete out[k];
  return out;
}

function gmPostJSON(url, { headers, body, method = 'POST' }) {
  return new Promise((resolve, reject) => {
    GM.xmlHttpRequest({
      url,
      method,
      data: body,
      headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
      timeout: 15000,
      anonymous: true,
      onload: r => (r.status >= 200 && r.status < 400) ? resolve(r.responseText) : reject(new Error(`HTTP ${r.status}`)),
      onerror: e => reject(new Error(e?.error || 'Network error')),
      ontimeout: () => reject(new Error('Timeout'))
    });
  });
}

// ---- Detection loop ----
async function detect() {
  if (prefs.detectPause || detectBusy) return;
  if (!fetchOpts?.url || !fetchOpts?.opts) return;

  detectBusy = true;
  try {
    let items = [];
    try {
      const text = await gmPostJSON(fetchOpts.url, fetchOpts.opts);
      const obj = JSON.parse(text);
      const root = Array.isArray(obj) ? obj[0] : obj;
      const edges = root?.data?.currentUser?.followedLiveUsers?.edges;
      if (Array.isArray(edges)) {
        items = edges.map(e => e?.node?.login).filter(Boolean).map(s => `/${s.toLowerCase()}`);
      } else {
        const diag = root?.errors ? { errors: root.errors } : root;
        log(`Live list missing or unexpected. Payload: ${JSON.stringify(diag)}`);
      }
    } catch (err) {
      log(`detect() request failed: ${err?.message || String(err)}`);
    }

    // Step 1: prune/maintain existing frames (invalid, duplicates, host redirects, timeouts)
    const currentUrls = [];
    streamFrames = streamFrames.filter(x => {
      if (!x.frame.contentDocument) {
        log(`Frame ${x.frame.src} invalid`);
        stopTheatreSync(x);
        x.container.parentElement.removeChild(x.container);
        return false;
      }

      const url = x.frame.contentDocument.location.pathname.toLowerCase();
      if (!currentUrls.includes(url)) {
        x.wait = 0;
        currentUrls.push(url);
      } else if (++x.wait > 2) {
        log(`Frame ${x.frame.contentDocument.location.pathname} duplicated`);
        stopTheatreSync(x);
        x.container.parentElement.removeChild(x.container);
        return false;
      }

      const chatLink = x.frame.contentDocument.querySelector('a[tabname="chat"]');
      if (chatLink) {
        x.theatre = false;
        chatLink.click();
        setTimeout(() => ensureTheatreMode(x), 300); // re-sync after tab change
        return true;
      }

      let hostLink = x.frame.contentDocument.querySelector('a[data-a-target="hosting-indicator"]');
      if (!hostLink) {
        hostLink = Array
          .from(x.frame.contentDocument.querySelectorAll('a.tw-link'))
          .find(a => /Watch\s+\w+\s+with\s+\d+\s+viewers/.test(a.innerText));
      }
      if (hostLink) {
        log(`Frame ${url} redirecting to ${hostLink.href}`);
        x.theatre = false;
        hostLink.click();
        setTimeout(() => ensureTheatreMode(x), 500); // re-sync after redirect
        return true;
      }

      const vid = x.frame.contentDocument.querySelector('video');
      if (vid && !vid.paused && !vid.ended && vid.readyState > 2) {
        x.timeout = 0;
      } else if (++x.timeout > 6) {
        log(`Frame ${url} timed out`);
        stopTheatreSync(x);
        x.container.parentElement.removeChild(x.container);
        return false;
      }

      return true;
    });

    // Step 2: auto-close frames for channels no longer live (if enabled)
    if (prefs.autoClose) {
      streamFrames = streamFrames.filter(x => {
        const p = x.frame.contentDocument.location.pathname;
        if (!items.includes(p)) {
          log(`Frame ${p} auto-closing`);
          stopTheatreSync(x);
          x.container.parentElement.removeChild(x.container);
          return false;
        }
        return true;
      });
    }

    // Step 3: prepare filtered list for opening (whitelist only affects what we open)
    const openCandidates = (prefs.whitelist.length)
      ? items.filter(x => prefs.whitelist.includes(x.slice(1)))
      : items;

    // Step 4: enforce the MAX_FRAMES cap among currently open frames
    if (streamFrames.length > MAX_FRAMES) {
      const desired = new Set(items.slice(0, MAX_FRAMES));
      const kept = [];
      const extras = [];

      for (const fr of streamFrames) {
        const path = fr.frame.contentDocument?.location?.pathname?.toLowerCase?.();
        if (path && desired.has(path)) {
          kept.push(fr);
          desired.delete(path);
        } else {
          extras.push(fr);
        }
      }

      const allowedExtras = Math.max(0, MAX_FRAMES - kept.length);
      for (const fr of extras.slice(0, allowedExtras)) kept.push(fr);
      for (const fr of extras.slice(allowedExtras)) {
        const p = fr.frame.contentDocument?.location?.pathname || fr.frame.src;
        log(`Closing extra frame ${p}`);
        stopTheatreSync(fr);
        fr.container.parentElement.removeChild(fr.container);
      }
      streamFrames = kept;
    }

    // Step 5: open new frames only if we have free slots
    const openPaths = streamFrames
      .map(f => f.frame.contentDocument?.location?.pathname?.toLowerCase?.())
      .filter(Boolean);

    const slots = Math.max(0, MAX_FRAMES - streamFrames.length);
    if (slots > 0) {
      const needToOpen = openCandidates.filter(x => !openPaths.includes(x));
      needToOpen.slice(0, slots).forEach(setupFrame);
    }

    // Step 6: keep theatre synced on all frames (covers mid-stream UI rebuilds)
    if (prefs.autoCinema) streamFrames.forEach(ensureTheatreMode);

    // Step 7: update badge
    setStreamsBadge(streamFrames.length, items.length || null);
  } finally {
    detectBusy = false;
  }
}

// ---- Settings UI / helpers ----
function setRefresh(value) {
  prefs.autoRefresh = value;
  if (value) {
    refreshJob = setTimeout(() => location.reload(), (4 * 3600000) + Math.floor(Math.random() * 10000));
  } else if (refreshJob !== -1) {
    clearTimeout(refreshJob);
    refreshJob = -1;
  }
}

function setStreamsBadge(openCount, liveCount) {
  const el = document.getElementById('tl-stats');
  if (!el) return;
  const hasLive = (liveCount !== null && liveCount !== undefined);
  el.textContent = hasLive ? `${openCount} / ${liveCount} streams` : `${openCount} streams`;
}

function buildStyles() {
  const style = document.createElement('style');
  style.id = 'tl-style';
  style.textContent = `
  :root{
    --bg:#0e0e10; --panel:#18181b; --text:#e5e7eb; --muted:#a1a1aa; --border:#2a2a2e;
    --accent:#9146ff; --accent-2:#772ce8; --danger:#e11d48; --shadow:0 10px 25px rgba(0,0,0,.45);
    --radius:14px;
  }
  body, html{ color:var(--text); background:var(--bg); font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, "Noto Sans", "Helvetica Neue", "Segoe UI Emoji"; }
  .tl-panel{
    position:fixed; right:12px; bottom:12px; width:360px; max-height:80vh; overflow:auto;
    background:var(--panel); border:1px solid var(--border); border-radius:var(--radius); box-shadow:var(--shadow);
    transform:translateX(0); transition:transform .18s ease-in-out;
  }
  .tl-panel.is-closed{ transform:translateX(calc(100% + 12px)); }
  .tl-header{ display:flex; align-items:center; gap:8px; padding:12px 14px; border-bottom:1px solid var(--border); position:sticky; top:0; background:var(--panel); z-index:2; }
  .tl-title{ font-weight:700; letter-spacing:.2px; }
  .tl-badge{ margin-left:auto; font-size:12px; padding:2px 8px; border-radius:999px; background:rgba(145,70,255,.12); color:#c9b6ff; border:1px solid rgba(145,70,255,.35); }
  .tl-section{ padding:12px 14px; border-bottom:1px solid var(--border); }
  .tl-section-title{ font-size:12px; text-transform:uppercase; letter-spacing:.14em; color:var(--muted); margin-bottom:8px; }
  .tl-row{ display:flex; gap:8px; align-items:center; }
  .tl-input{ flex:1; background:#0f0f12; color:var(--text); border:1px solid var(--border); border-radius:10px; padding:8px 10px; outline:none; }
  .tl-input::placeholder{ color:#8b8b92; }
  .tl-btn{ border:1px solid var(--border); background:#121216; color:var(--text); padding:8px 10px; border-radius:10px; cursor:pointer; }
  .tl-btn:hover{ border-color:#37373d; }
  .tl-btn-primary{ background:linear-gradient(180deg, var(--accent), var(--accent-2)); border-color:transparent; color:white; }
  .tl-btn-danger{ background:linear-gradient(180deg, #f43f5e, #be123c); border-color:transparent; color:white; }
  .tl-chiplist{ display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
  .tl-chip{ display:inline-flex; align-items:center; gap:8px; background:#101014; border:1px solid var(--border); padding:6px 9px; border-radius:999px; font-size:12px; }
  .tl-chip button{ all:unset; cursor:pointer; font-weight:700; color:#bbb; }
  .tl-chip button:hover{ color:#fff; }
  .tl-grid{ display:grid; grid-template-columns: 1fr; gap:10px; }
  .tl-switch{ display:flex; align-items:center; justify-content:space-between; background:#101014; border:1px solid var(--border); border-radius:10px; padding:10px 12px; }
  .tl-switch input[type="checkbox"]{ width:38px; height:22px; appearance:none; background:#2b2b31; border-radius:999px; position:relative; outline:none; border:1px solid #3a3a41; cursor:pointer; }
  .tl-switch input[type="checkbox"]::after{ content:''; width:18px; height:18px; border-radius:50%; background:#c9cad2; position:absolute; top:1px; left:1px; transition:left .15s ease; }
  .tl-switch input[type="checkbox"]:checked{ background:var(--accent); border-color:transparent; }
  .tl-switch input[type="checkbox"]:checked::after{ left:calc(100% - 19px); background:white; }
  .tl-switch small{ color:var(--muted); display:block; margin-top:2px; }
  .tl-slider{ display:flex; align-items:center; gap:10px; }
  .tl-slider input[type="range"]{ width:100%; accent-color:var(--accent); }
  .tl-footer{
    position:sticky; bottom:0; padding:12px 14px; display:flex; justify-content:flex-start; gap:8px;
    background:var(--panel); border-top:1px solid var(--border);
  }
  .tl-fab{
    position:fixed; right:12px; bottom:12px; z-index:9999; width:44px; height:44px; border-radius:50%;
    border:none; background:linear-gradient(180deg, var(--accent), var(--accent-2)); color:#fff; cursor:pointer; box-shadow:var(--shadow);
  }
  `;
  return style;
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
  // Load persisted settings once (single source of truth)
  await loadPrefs();
  setRefresh(prefs.autoRefresh);

  // Reset page and mount UI
  document.documentElement.style.backgroundColor = '#000';
  document.body.style.backgroundColor = '#000';
  clearChildren(document.body);
  clearChildren(document.head);

  // Styles first
  document.body.append(buildStyles());

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
    makeSwitch('sw-autoclose', 'Auto-close raids & hosts', 'Remove frames not in your live list', prefs.autoClose, v => { prefs.autoClose = v; GM.setValue('autoClose', v); }),
    makeSwitch('sw-cinema', 'Auto enable Theatre Mode', 'Apply inside each frame when possible', prefs.autoCinema, v => {
      prefs.autoCinema = v;
      GM.setValue('autoCinema', v);
      if (v) {
        streamFrames.forEach(ensureTheatreMode);
      } else {
        streamFrames.forEach(stopTheatreSync);
      }
    }),
    makeSwitch('sw-refresh', 'Refresh page every 4 hours', 'Adds small jitter to avoid thundering herd', prefs.autoRefresh, v => { setRefresh(v); GM.setValue('autoRefresh', v); }),
    makeSwitch('sw-lowlat', 'Disable low-latency mode', 'Reduce bandwidth/CPU usage', prefs.lowLatDisable, v => { prefs.lowLatDisable = v; GM.setValue('lowLatDisable', v); }),
    makeSwitch('sw-pause', 'Pause streams detection', 'Stops polling & frame changes', prefs.detectPause, v => { prefs.detectPause = v; GM.setValue('detectPause', v); }),
    makeSwitch('sw-panelopen', 'Open panel on load', 'Show settings drawer automatically on this page', prefs.panelAutoOpen, v => { prefs.panelAutoOpen = v; GM.setValue('panelAutoOpen', v); })
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
    streamFrames.forEach(x => {
      stopTheatreSync(x);
      x.container.parentElement.removeChild(x.container);
    });
    streamFrames.length = 0;
    setStreamsBadge(0, null);
  });
  foot.append(closeAll);

  panel.append(header, sWL, sSW, sSL, foot);

  // Floating action button (open/close)
  const fab = document.createElement('button');
  fab.className = 'tl-fab';
  fab.id = 'tl-toggle';
  fab.setAttribute('aria-expanded', 'false');
  fab.title = 'Settings panel';
  fab.textContent = '≡';
  fab.addEventListener('click', () => {
    const closed = panel.classList.toggle('is-closed');
    fab.setAttribute('aria-expanded', String(!closed));
  });

  // Mount
  document.body.append(panel, fab);

  // Respect saved preference: open panel on load only if enabled
  if (prefs.panelAutoOpen) {
    panel.classList.remove('is-closed');
    fab.setAttribute('aria-expanded', 'true');
  }
}

// ---- Navigation tab + bootstrap ----
function setupTab() {
  if (location.pathname.startsWith(activationPath)) {
    if (fetchOpts.url && !fetchOpts.init) {
      log('Preparing layout and update loop');
      fetchOpts.init = true;
      setupControls();
      setInterval(detect, 10000);
      clearInterval(intervalJob);
    }
    return;
  }

  if (!location.pathname.startsWith('/directory/following')) return;
  if (document.querySelector(`a[href="${activationPath}"]`)) return;

  const tabs = document.body.querySelectorAll('li[role=presentation]');
  if (!tabs.length) return;

  log('Setting up Auto-lurk navigation tab');

  const lastTab = tabs[tabs.length - 1];
  const newTab = document.createElement('li');
  newTab.className = lastTab.className;
  newTab.innerHTML = lastTab.innerHTML;

  const link = newTab.querySelector('a');
  link.href = activationPath;
  const t = link.querySelector("[class^='ScTitle']");
  if (t) t.innerText = 'Auto-lurk';

  lastTab.parentElement.appendChild(newTab);
}

// ---- Intercept Twitch request to capture variables/headers ----
log(`Script loaded on path ${location.pathname}`);

if (location.pathname.startsWith(activationPath)) {
  unsafeWindow.fetch = new Proxy(unsafeWindow.fetch, {
    // eslint-disable-next-line func-names
    apply(target, thisArg, argList) {
      try {
        const [url, opts = {}] = argList;
        if (
          url?.includes('gql.twitch.tv') &&
          typeof opts?.body === 'string' &&
          opts.body.includes('FollowingLive_CurrentUser') &&
          opts._meta !== ((GM && GM.info && GM.info.script && GM.info.script.name) || 'Twitching Lurkist')
        ) {
          log('Intercepted live list request');

          let opBody = null;
          try {
            const parsed = JSON.parse(opts.body);
            opBody = Array.isArray(parsed)
              ? parsed.find(x => x?.operationName === 'FollowingLive_CurrentUser')
              : (parsed?.operationName === 'FollowingLive_CurrentUser' ? parsed : null);
          } catch (e) {
            log(`Body parse error: ${e?.message || String(e)}`);
          }

          if (opBody) {
            const plainHeaders = headersToPlain(opts.headers || {});
            const forwardedVars = Object.assign({}, opBody.variables || {}, { limit: 50, includeIsDJ: false });

            fetchOpts.url = url;
            fetchOpts.opts = {
              method: opts.method || 'POST',
              headers: plainHeaders,
              body: JSON.stringify([{
                operationName: opBody.operationName,
                variables: forwardedVars,
                extensions: opBody.extensions
              }])
            };
          }
        }
      } catch (e) {
        log(`Fetch proxy error: ${e?.message || String(e)}`);
      }
      return target.apply(thisArg, argList);
    }
  });
}

intervalJob = setInterval(setupTab, 1250);
