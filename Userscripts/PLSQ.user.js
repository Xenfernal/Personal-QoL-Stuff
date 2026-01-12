// ==UserScript==
// @name         Prefer lowest stream quality on Twitch
// @namespace    https://github.com/Xenfernal
// @version      1.2
// @icon         https://www.google.com/s2/favicons?sz=64&domain=twitch.tv
// @license      MIT
// @author       Xen
// @description  Selects the lowest available Twitch quality per stream (SPA-safe) with minimal UI spam.
// @match        https://www.twitch.tv/*
// @exclude      https://www.twitch.tv/settings*
// @exclude      https://www.twitch.tv/wallet*
// @exclude      https://www.twitch.tv/subscriptions*
// @exclude      https://www.twitch.tv/inventory*
// @exclude      https://www.twitch.tv/drops/inventory*
// @exclude      https://www.twitch.tv/p/*
// @grant        none
// @homepageURL  https://github.com/Xenfernal/Personal-QoL-Stuff/tree/main/Userscripts
// @downloadURL  https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/PLSQ.user.js
// @updateURL    https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/PLSQ.user.js
// @run-at       document-start
// ==/UserScript==

(() => {
  "use strict";

  // ---------------- CONFIG ---------------- //
  const CFG = {
    // If "Audio Only" exists, treat it as the lowest option.
    preferAudioOnly: false,

    // Close menu only if the script opened it.
    closeMenuAfterSelect: true,

    maxAttemptsPerUrl: 2,
    retryCooldownMs: 1200,

    // Optional: also write localStorage hints (useful when UI selectors fail).
    writeLocalStorageHint: true,

    // Poll for selection after clicking a quality option.
    verifyTimeoutMs: 1800,
    verifyIntervalMs: 110,

    // Open/close polling.
    menuToggleTimeoutMs: 1200,
    menuToggleIntervalMs: 70,

    // Close robustness.
    closeRetries: 2,
    closeRetryBaseDelayMs: 220,
    deferredCloseDelaysMs: [450, 1000, 1800, 2600],

    debug: false,
  };

  const log = (...a) => CFG.debug && console.log("[Twitch Lowest Quality]", ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------- STRICT PAGE GATING ---------------- //
  const RESERVED_ROUTES = new Set([
    "", "directory", "downloads", "jobs", "p", "settings", "wallet", "subscriptions",
    "inventory", "search", "turbo", "prime", "store", "friends", "messages", "payments",
    "bits", "creatorcamp", "blog", "security", "manage", "signup", "login",
  ]);

  function isChannelHomePath(pathname) {
    const p = String(pathname || "/").trim();
    if (p === "/" || p.length < 2) return false;

    const segs = p.split("/").filter(Boolean);
    if (segs.length !== 1) return false;

    const name = segs[0];
    if (!name) return false;
    if (RESERVED_ROUTES.has(name.toLowerCase())) return false;

    // Keep conservative: only canonical channel slugs.
    return /^[A-Za-z0-9_]+$/.test(name);
  }

  function isEligiblePage() {
    return location.host === "www.twitch.tv" && isChannelHomePath(location.pathname);
  }

  // ---------------- SELECTORS ---------------- //
  const SEL = {
    video: "video",

    settingsBtn: [
      'button[data-a-target="player-settings-button"]',
      'button[aria-label*="Settings"]',
      'button[aria-label*="settings"]',
    ],

    settingsMenu: 'div[data-a-target="player-settings-menu"]',

    // Quality row can be non-button; keep broad.
    qualityRow: [
      '[data-a-target="player-settings-menu-item-quality"]',
      '[aria-label*="Quality"]',
      '[aria-label*="quality"]',
    ],

    qualityOptionsMenuLocal: [
      '[data-a-target="player-settings-submenu-quality-option"]',
      '[role="menuitemradio"]',
      "label",
    ],

    playerRoots: [
      'div[data-test-selector="video-player__container"]',
      'div[data-a-target="player-overlay-click-handler"]',
      "div.video-player",
      'div[data-a-target="player-controls"]',
    ],
  };

  function qsAny(selectors, root = document) {
    for (const s of selectors) {
      const el = root.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function qsaAny(selectors, root = document) {
    for (const s of selectors) {
      const els = Array.from(root.querySelectorAll(s));
      if (els.length) return els;
    }
    return [];
  }

  // ---------------- VISIBILITY / GEOMETRY ---------------- //
  function isVisible(el) {
    if (!el || !el.isConnected) return false;

    const cs = getComputedStyle(el);
    if (!cs) return false;
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    if (parseFloat(cs.opacity || "1") <= 0) return false;

    const rect = el.getBoundingClientRect?.();
    if (!rect || rect.width <= 2 || rect.height <= 2) return false;

    if (el.getClientRects && el.getClientRects().length === 0) return false;
    return true;
  }

  function centreOf(el) {
    const r = el?.getBoundingClientRect?.();
    if (!r) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function dist(a, b) {
    if (!a || !b) return Number.POSITIVE_INFINITY;
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // ---------------- PRIMARY PLAYER CONTEXT (LOCK-ON) ---------------- //
  function getLargestVisibleVideo() {
    const vids = Array.from(document.querySelectorAll(SEL.video));
    let best = null;
    let bestArea = 0;

    for (const v of vids) {
      if (!isVisible(v)) continue;
      const r = v.getBoundingClientRect();
      if (r.width < 260 || r.height < 160) continue; // ignore tiny previews
      const area = Math.max(0, r.width) * Math.max(0, r.height);
      if (area > bestArea) {
        bestArea = area;
        best = v;
      }
    }
    return best;
  }

  function getPlayerRootForVideo(videoEl) {
    if (!videoEl?.closest) return null;
    return videoEl.closest(SEL.playerRoots.join(",")) || null;
  }

  function pickNearestSettingsButton(videoEl) {
    const candidates = qsaAny(SEL.settingsBtn, document).filter(isVisible);
    if (!candidates.length) return null;

    const vc = centreOf(videoEl);
    let best = candidates[0];
    let bestD = dist(centreOf(best), vc);

    for (const c of candidates) {
      const d = dist(centreOf(c), vc);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  function getMainContext(hintVideoEl = null) {
    if (!isEligiblePage()) return null;

    const videoEl =
      (hintVideoEl && hintVideoEl.tagName === "VIDEO" && isVisible(hintVideoEl))
        ? hintVideoEl
        : getLargestVisibleVideo();

    if (!videoEl) return null;

    const rootEl = getPlayerRootForVideo(videoEl) || document;
    const settingsBtn = qsAny(SEL.settingsBtn, rootEl) || pickNearestSettingsButton(videoEl);

    if (!settingsBtn || !settingsBtn.isConnected) return null;
    return { videoEl, rootEl, settingsBtn };
  }

  // ---------------- Storage hint ---------------- //
  function setLocalStorageHintLowest() {
    try {
      localStorage.setItem("s-qs-ts", String(Date.now()));
      localStorage.setItem("quality-bitrate", "230000");
      localStorage.setItem("video-quality", '{"default":"160p30"}');
    } catch {
      // ignore
    }
  }

  // ---------------- Control visibility ---------------- //
  function dispatchPointerNudge(target) {
    if (!target) return;

    const rect = target.getBoundingClientRect?.();
    const cx = rect ? Math.max(1, Math.floor(rect.left + rect.width / 2)) : 10;
    const cy = rect ? Math.max(1, Math.floor(rect.top + rect.height / 2)) : 10;
    const evOpts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };

    try { target.dispatchEvent(new MouseEvent("mousemove", evOpts)); } catch {}
    try { target.dispatchEvent(new MouseEvent("mouseenter", evOpts)); } catch {}
    try { target.dispatchEvent(new MouseEvent("mouseover", evOpts)); } catch {}
    try { target.dispatchEvent(new PointerEvent("pointermove", evOpts)); } catch {}
  }

  async function ensurePlayerControlsVisible(ctx) {
    if (!ctx?.videoEl) return false;
    dispatchPointerNudge(ctx.rootEl);
    dispatchPointerNudge(ctx.videoEl);
    await sleep(90);
    return true;
  }

  // ---------------- Menu discovery ---------------- //
  function getBestSettingsMenuEl(ctx) {
    if (!ctx?.settingsBtn) return null;

    const inRoot = ctx.rootEl?.querySelector?.(SEL.settingsMenu);
    if (isVisible(inRoot)) return inRoot;

    const menus = Array.from(document.querySelectorAll(SEL.settingsMenu)).filter(isVisible);
    if (!menus.length) return null;

    const bc = centreOf(ctx.settingsBtn);
    let best = menus[0];
    let bestD = dist(centreOf(best), bc);

    for (const m of menus) {
      const d = dist(centreOf(m), bc);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  function isMenuOpen(ctx) {
    const menu = getBestSettingsMenuEl(ctx);
    if (isVisible(menu)) return true;

    // Secondary hint only.
    const expanded = ctx?.settingsBtn?.getAttribute?.("aria-expanded");
    return expanded === "true";
  }

  async function waitForMenuState(ctx, wantOpen, timeoutMs, intervalMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const open = isMenuOpen(ctx);
      if (wantOpen ? open : !open) return true;
      await sleep(intervalMs);
    }
    return false;
  }

  // ---------------- Close helpers ---------------- //
  function findMenuCloseControl(menuEl) {
    if (!menuEl) return null;

    const candidates = Array.from(
      menuEl.querySelectorAll('button,[role="menuitem"],[role="menuitemradio"],[tabindex]')
    );

    for (const el of candidates) {
      if (!el || typeof el.click !== "function") continue;
      const t = (el.innerText || el.textContent || "").trim();
      if (t === "Close") return el; // exact match to avoid "Closed Captions"
    }
    return null;
  }

  function findQualityRow(menuEl, rootEl) {
    // Selector-based first.
    if (menuEl) {
      const bySel = qsAny(SEL.qualityRow, menuEl);
      if (bySel) return bySel;
    }
    if (rootEl) {
      const bySelRoot = qsAny(SEL.qualityRow, rootEl);
      if (bySelRoot) return bySelRoot;
    }

    // Text scan fallback.
    const scope = menuEl || rootEl;
    if (!scope) return null;

    const candidates = Array.from(
      scope.querySelectorAll('button,[role="menuitem"],[role="menuitemradio"],div[tabindex],a[tabindex]')
    ).filter(isVisible);

    for (const el of candidates) {
      const t = (el.innerText || el.textContent || "").trim();
      if (/^Quality\b/i.test(t)) return el;
    }
    return null;
  }

  // ---------------- Quality parsing ---------------- //
  function parseQualityText(raw) {
    const text = (raw || "").trim();
    if (!text) return null;

    if (/^auto\b/i.test(text)) return { type: "auto", text };
    if (/source/i.test(text)) return { type: "source", text };
    if (/audio/i.test(text)) return { type: "audio", text };

    // 160p, 360p, 720p60, etc.
    const m = text.match(/(\d+)\s*p\s*(\d+)?/i);
    if (!m) return null;

    const height = parseInt(m[1], 10);
    const fps = m[2] ? parseInt(m[2], 10) : 0;
    if (!Number.isFinite(height)) return null;

    return { type: "video", text, height, fps };
  }

  function qualityKey(info) {
    if (!info) return "";
    if (info.type === "video") return `v:${info.height}:${info.fps || 0}`;
    if (info.type === "audio") return "a:audio";
    if (info.type === "auto") return "a:auto";
    if (info.type === "source") return "a:source";
    return `u:${String(info.type || "")}`;
  }

  // ---------------- Option normalisation / selection detection ---------------- //
  function normaliseOptionElement(el) {
    if (!el) return null;

    if (el.getAttribute?.("role") === "menuitemradio") {
      return { root: el, stateEl: el, clickEl: el };
    }

    const within = el.querySelector?.('[role="menuitemradio"]');
    if (within) return { root: el, stateEl: within, clickEl: within };

    const above = el.closest?.('[role="menuitemradio"]');
    if (above) return { root: el, stateEl: above, clickEl: above };

    return { root: el, stateEl: el, clickEl: el };
  }

  function getOptionText(norm) {
    const el = norm?.root || norm?.stateEl || norm?.clickEl;
    return el ? (el.innerText || el.textContent || "").trim() : "";
  }

  function isSelectedOption(norm) {
    const stateEl = norm?.stateEl;
    if (!stateEl) return false;

    if (stateEl.getAttribute?.("role") === "menuitemradio") {
      return stateEl.getAttribute("aria-checked") === "true";
    }

    if (stateEl.getAttribute?.("aria-checked") === "true") return true;
    if (stateEl.getAttribute?.("aria-selected") === "true") return true;

    const root = norm?.root || stateEl;
    return !!root?.querySelector?.('input[type="radio"]:checked');
  }

  function pickLowest(optionEls) {
    const items = optionEls
      .map(normaliseOptionElement)
      .filter(Boolean)
      .map((norm) => {
        const txt = getOptionText(norm);
        const info = parseQualityText(txt);
        return info ? { norm, info, txt, selected: isSelectedOption(norm) } : null;
      })
      .filter(Boolean);

    if (!items.length) return null;

    const selected = items.find((x) => x.selected) || null;

    if (CFG.preferAudioOnly) {
      const audio = items.find((x) => x.info.type === "audio");
      if (audio) return { chosen: audio, selected };
    }

    const vids = items
      .filter((x) => x.info.type === "video")
      .sort((a, b) => (a.info.height - b.info.height) || (a.info.fps - b.info.fps));

    if (vids.length) return { chosen: vids[0], selected };

    const auto = items.find((x) => x.info.type === "auto");
    const source = items.find((x) => x.info.type === "source");
    if (auto) return { chosen: auto, selected };
    if (source) return { chosen: source, selected };

    return null;
  }

  function getQualityOptions(ctx) {
    const menu = getBestSettingsMenuEl(ctx);
    if (menu) {
      return Array.from(menu.querySelectorAll(SEL.qualityOptionsMenuLocal.join(",")));
    }

    // Fallback (rare with current gating).
    return qsaAny([
      '[data-a-target="player-settings-submenu-quality-option"]',
      'div[data-a-target="player-settings-menu"] [role="menuitemradio"]',
      'div[data-a-target="player-settings-menu"] label',
    ], document);
  }

  async function waitForQualityOptions(ctx, timeoutMs = 900, intervalMs = 90) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const opts = getQualityOptions(ctx);
      if (opts.length) return opts;
      await sleep(intervalMs);
    }
    return [];
  }

  // ---------------- OPEN / CLOSE (transactional) ---------------- //
  let lastMenuOpenedByUsAt = 0;
  let deferredCloseToken = 0;

  async function openSettingsMenu(ctx) {
    const live = getMainContext(ctx?.videoEl) || ctx;
    if (!live?.settingsBtn) return { ok: false, reason: "no-settings-btn" };

    await ensurePlayerControlsVisible(live);

    const wasOpen = isMenuOpen(live);
    if (wasOpen) return { ok: true, ctx: live, openedNow: false };

    live.settingsBtn.click();
    const ok = await waitForMenuState(live, true, CFG.menuToggleTimeoutMs, CFG.menuToggleIntervalMs);
    if (!ok) {
      await ensurePlayerControlsVisible(live);
      const live2 = getMainContext(live.videoEl) || live;
      live2?.settingsBtn?.click?.();
      const ok2 = await waitForMenuState(live2, true, CFG.menuToggleTimeoutMs, CFG.menuToggleIntervalMs);
      if (!ok2) return { ok: false, reason: "settings-menu-not-open" };

      lastMenuOpenedByUsAt = Date.now();
      return { ok: true, ctx: live2, openedNow: true };
    }

    lastMenuOpenedByUsAt = Date.now();
    return { ok: true, ctx: live, openedNow: true };
  }

  async function closeMenuIfOpen(ctx, openedNow) {
    if (!CFG.closeMenuAfterSelect) return true;
    if (!openedNow) return true;

    for (let i = 0; i < CFG.closeRetries; i++) {
      const live = getMainContext(ctx?.videoEl) || ctx;
      if (!live?.settingsBtn) return false;

      if (!isMenuOpen(live)) return true;

      const menu = getBestSettingsMenuEl(live);

      // Close-only item first.
      const closeItem = findMenuCloseControl(menu);
      if (closeItem) {
        closeItem.click();
        const ok = await waitForMenuState(live, false, CFG.menuToggleTimeoutMs, CFG.menuToggleIntervalMs);
        if (ok && !isMenuOpen(live)) return true;
      }

      // Toggle fallback.
      live.settingsBtn.click();
      const ok2 = await waitForMenuState(live, false, CFG.menuToggleTimeoutMs, CFG.menuToggleIntervalMs);
      if (ok2 && !isMenuOpen(live)) return true;

      await sleep(CFG.closeRetryBaseDelayMs * (i + 1));
    }

    const finalCtx = getMainContext(ctx?.videoEl) || ctx;
    return finalCtx ? !isMenuOpen(finalCtx) : false;
  }

  // ESLint fix: no inline function inside loop; pass args to setTimeout.
  function deferredCloseTick(token, openedAt, videoEl) {
    if (token !== deferredCloseToken) return;
    if (Date.now() - openedAt > 4500) return;

    const ctx = getMainContext(videoEl);
    if (!ctx) return;

    if (isMenuOpen(ctx)) {
      // Only closes if we opened it (enforced by caller).
      closeMenuIfOpen(ctx, true).catch(() => {});
    }
  }

  function scheduleDeferredClose(videoEl, openedNow) {
    if (!CFG.closeMenuAfterSelect) return;
    if (!openedNow) return;

    deferredCloseToken += 1;
    const token = deferredCloseToken;
    const openedAt = lastMenuOpenedByUsAt || Date.now();

    for (const delay of CFG.deferredCloseDelaysMs) {
      setTimeout(deferredCloseTick, delay, token, openedAt, videoEl);
    }
  }

  async function openQualitySubmenu(ctx) {
    const opened = await openSettingsMenu(ctx);
    if (!opened.ok) return opened;

    const live = opened.ctx;
    const openedNow = !!opened.openedNow;

    const menu = getBestSettingsMenuEl(live);
    if (!menu) {
      scheduleDeferredClose(live.videoEl, openedNow);
      await closeMenuIfOpen(live, openedNow);
      return { ok: false, reason: "no-settings-menu", ctx: live, openedNow };
    }

    const qualityRow = findQualityRow(menu, live.rootEl);
    if (!qualityRow) {
      scheduleDeferredClose(live.videoEl, openedNow);
      await closeMenuIfOpen(live, openedNow);
      return { ok: false, reason: "no-quality-btn", ctx: live, openedNow };
    }

    qualityRow.click();
    await sleep(120);

    return { ok: true, ctx: live, openedNow };
  }

  // ---------------- Verification polling ---------------- //
  async function waitForSelectedKey(ctx, targetKey, timeoutMs, intervalMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const opts = getQualityOptions(ctx);
      if (opts.length) {
        const picked = pickLowest(opts);
        const selKey = picked?.selected ? qualityKey(picked.selected.info) : "";
        if (selKey && selKey === targetKey) return { ok: true, selKey };
      }
      await sleep(intervalMs);
    }
    return { ok: false, selKey: "" };
  }

  async function applyLowestQualityOnce(hintVideoEl = null) {
    if (!isEligiblePage()) return { ok: false, reason: "not-channel-page" };

    const ctx = getMainContext(hintVideoEl);
    if (!ctx) return { ok: false, reason: "no-main-player" };

    if (CFG.writeLocalStorageHint) setLocalStorageHintLowest();

    const opened = await openQualitySubmenu(ctx);
    if (!opened.ok) return opened;

    const live = opened.ctx;
    const openedNow = !!opened.openedNow;

    const options = await waitForQualityOptions(live);
    if (!options.length) {
      scheduleDeferredClose(live.videoEl, openedNow);
      await closeMenuIfOpen(live, openedNow);
      return { ok: false, reason: "no-options", ctx: live, openedNow };
    }

    const picked = pickLowest(options);
    if (!picked) {
      scheduleDeferredClose(live.videoEl, openedNow);
      await closeMenuIfOpen(live, openedNow);
      return { ok: false, reason: "pick-failed", ctx: live, openedNow };
    }

    const { chosen, selected } = picked;
    const chosenKey = qualityKey(chosen.info);
    const selectedKey = selected ? qualityKey(selected.info) : "";

    log("Selected:", selected?.txt, "Chosen:", chosen.txt);

    if (selectedKey && chosenKey && selectedKey === chosenKey) {
      scheduleDeferredClose(live.videoEl, openedNow);
      await closeMenuIfOpen(live, openedNow);
      return { ok: true, reason: "already-lowest", ctx: live, openedNow };
    }

    chosen.norm?.clickEl?.click?.();

    const verify = await waitForSelectedKey(live, chosenKey, CFG.verifyTimeoutMs, CFG.verifyIntervalMs);

    scheduleDeferredClose(live.videoEl, openedNow);
    await closeMenuIfOpen(live, openedNow);

    if (verify.ok) return { ok: true, reason: "changed-to-lowest", ctx: live, openedNow };
    return { ok: false, reason: "not-applied-yet", ctx: live, openedNow };
  }

  // ---------------- Scheduler ---------------- //
  let lastUrl = location.href;
  let attempts = 0;
  let applying = false;
  let done = false;
  let lastTryAt = 0;
  let observer = null;

  function reset() {
    lastUrl = location.href;
    attempts = 0;
    applying = false;
    done = false;
    lastTryAt = 0;

    if (isEligiblePage() && CFG.writeLocalStorageHint) setLocalStorageHintLowest();

    if (observer) {
      try { observer.disconnect(); } catch {}
      observer = null;
    }
    startObserver();
  }

  function maybeRun(reason, hintVideoEl = null) {
    if (location.href !== lastUrl) reset();
    if (done || applying) return;
    if (attempts >= CFG.maxAttemptsPerUrl) return;

    if (!isEligiblePage()) return;

    const now = Date.now();
    if (now - lastTryAt < CFG.retryCooldownMs) return;

    if (!getMainContext(hintVideoEl)) return;

    applying = true;
    lastTryAt = now;
    attempts++;

    setTimeout(async () => {
      try {
        const res = await applyLowestQualityOnce(hintVideoEl);
        log(reason, "attempt", attempts, res);
        if (res.ok) done = true;
      } finally {
        applying = false;
        if (done && observer) {
          try { observer.disconnect(); } catch {}
          observer = null;
        }
      }
    }, 150);
  }

  // SPA navigation hooks
  const _pushState = history.pushState;
  const _replaceState = history.replaceState;

  history.pushState = function (...args) {
    const r = _pushState.apply(this, args);
    window.dispatchEvent(new Event("locationchange"));
    return r;
  };
  history.replaceState = function (...args) {
    const r = _replaceState.apply(this, args);
    window.dispatchEvent(new Event("locationchange"));
    return r;
  };
  window.addEventListener("popstate", () => window.dispatchEvent(new Event("locationchange")));
  window.addEventListener("locationchange", () => maybeRun("locationchange"));

  // Media triggers (capture)
  document.addEventListener("loadeddata", (e) => {
    if (e?.target?.tagName === "VIDEO") maybeRun("video-loadeddata", e.target);
  }, true);
  document.addEventListener("playing", (e) => {
    if (e?.target?.tagName === "VIDEO") maybeRun("video-playing", e.target);
  }, true);

  function startObserver() {
    if (!isEligiblePage()) return;

    observer = new MutationObserver(() => {
      if (!isEligiblePage()) return;
      if (done) return;
      if (getMainContext()) maybeRun("observer");
    });

    const target = document.documentElement;
    if (target) observer.observe(target, { childList: true, subtree: true });

    setTimeout(() => {
      if (observer) {
        try { observer.disconnect(); } catch {}
        observer = null;
      }
    }, 30000);
  }

  // Initial
  reset();
  maybeRun("init");
})();
