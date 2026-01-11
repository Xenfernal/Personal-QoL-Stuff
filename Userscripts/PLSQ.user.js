// ==UserScript==
// @name         Prefer lowest stream quality on Twitch
// @namespace    https://github.com/Xenfernal
// @version      1.1
// @icon         https://www.google.com/s2/favicons?sz=64&domain=twitch.tv
// @license      MIT
// @author       Xen
// @description  Selects the lowest available Twitch quality per stream (SPA-safe) with minimal UI spam.
// @match        https://www.twitch.tv/*
// @match        https://clips.twitch.tv/*
// @match        https://m.twitch.tv/*
// @match        https://player.twitch.tv/*
// @exclude      https://www.twitch.tv/settings*
// @exclude      https://m.twitch.tv/settings*
// @exclude      https://www.twitch.tv/wallet*
// @exclude      https://m.twitch.tv/wallet*
// @exclude      https://www.twitch.tv/subscriptions*
// @exclude      https://m.twitch.tv/subscriptions*
// @exclude      https://www.twitch.tv/inventory*
// @exclude      https://m.twitch.tv/inventory*
// @exclude      https://www.twitch.tv/drops/inventory*
// @exclude      https://m.twitch.tv/drops/inventory*
// @exclude      https://www.twitch.tv/p/*
// @exclude      https://m.twitch.tv/p/*
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
    // (Lowest bandwidth, but no video.)
    preferAudioOnly: false,

    closeMenuAfterSelect: true,

    maxAttemptsPerUrl: 1,
    retryCooldownMs: 1200,

    // Optional: also write localStorage hints (useful when UI selectors fail)
    writeLocalStorageHint: true,

    // Poll for selection after clicking a quality option (improvement B)
    verifyTimeoutMs: 1800,
    verifyIntervalMs: 110,

    // Debug logs
    debug: false,
  };

  const log = (...a) => CFG.debug && console.log("[Twitch Lowest Quality]", ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------- SELECTORS (unified) ---------------- //
  const SEL = {
    // Player presence / gating
    video: "video",
    settingsBtn: [
      'button[data-a-target="player-settings-button"]',
      'button[aria-label*="Settings"]',
      'button[aria-label*="settings"]',
    ],
    settingsMenu: 'div[data-a-target="player-settings-menu"]',

    qualityBtn: [
      'button[data-a-target="player-settings-menu-item-quality"]',
      'button[aria-label*="Quality"]',
      'button[aria-label*="quality"]',
    ],

    // Quality options (ordered: most specific -> broad fallback)
    qualityOptions: [
      '[data-a-target="player-settings-submenu-quality-option"]',
      'div[data-a-target="player-settings-menu"] [role="menuitemradio"]',
      // broad fallback, normalised later:
      'div[data-a-target="player-settings-menu"] label',
    ],

    // Optional hover targets (player container) for more precise overlay nudges
    hoverTargets: [
      'div[data-a-target="player-overlay-click-handler"]',
      'div[data-test-selector="video-player__container"]',
      'div.video-player', // common class in some Twitch layouts
      'div[data-a-target="player-controls"]',
    ],
  };

  function qsAny(selectors) {
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function qsaAny(selectors) {
    for (const s of selectors) {
      const els = Array.from(document.querySelectorAll(s));
      if (els.length) return els;
    }
    return [];
  }

  function getSettingsMenuEl() {
    return document.querySelector(SEL.settingsMenu);
  }

  // ---------------- Visibility-aware menu open/close (improvement A) ---------------- //
  function isVisible(el) {
    if (!el) return false;

    // If detached, treat as not visible
    if (!el.isConnected) return false;

    const cs = getComputedStyle(el);
    if (!cs) return false;
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    if (parseFloat(cs.opacity || "1") <= 0) return false;

    const rect = el.getBoundingClientRect?.();
    if (!rect) return false;
    if (rect.width <= 1 || rect.height <= 1) return false;

    // A final sanity check: at least one client rect
    if (el.getClientRects && el.getClientRects().length === 0) return false;

    return true;
  }

  function isMenuOpen(settingsBtn) {
    const menu = getSettingsMenuEl();
    if (isVisible(menu)) return true;

    // Sometimes the menu node exists but is CSS-hidden; aria-expanded can still be useful if present.
    const expanded = settingsBtn?.getAttribute?.("aria-expanded");
    if (expanded === "true") return true;

    return false;
  }

  // ---------------- Storage hint ---------------- //
  function setLocalStorageHintLowest() {
    // Hint Twitch towards 160p30 (if available). If not available, Twitch may ignore/fallback.
    try {
      localStorage.setItem("s-qs-ts", String(Date.now()));
      localStorage.setItem("quality-bitrate", "230000");
      localStorage.setItem("video-quality", '{"default":"160p30"}');
    } catch {
      // ignore
    }
  }

  // ---------------- Player gating (improvement #5 retained) ---------------- //
  function isPlayerContext() {
    if (document.querySelector(SEL.video)) return true;
    if (qsAny(SEL.settingsBtn)) return true;
    if (getSettingsMenuEl()) return true;
    return false;
  }

  // ---------------- Control visibility with hover target (optional) ---------------- //
  function dispatchPointerNudge(target) {
    if (!target) return;

    const rect = target.getBoundingClientRect?.();
    const cx = rect ? Math.max(1, Math.floor(rect.left + rect.width / 2)) : 10;
    const cy = rect ? Math.max(1, Math.floor(rect.top + rect.height / 2)) : 10;

    const evOpts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };

    // Mouse events (most likely to trigger control overlay)
    try { target.dispatchEvent(new MouseEvent("mousemove", evOpts)); } catch {}
    try { target.dispatchEvent(new MouseEvent("mouseenter", evOpts)); } catch {}
    try { target.dispatchEvent(new MouseEvent("mouseover", evOpts)); } catch {}

    // Pointer events (some builds lean on pointer events)
    try { target.dispatchEvent(new PointerEvent("pointermove", evOpts)); } catch {}
  }

  function findHoverTarget(videoEl) {
    // Prefer an explicit player container if present.
    const explicit = qsAny(SEL.hoverTargets);
    if (explicit) return explicit;

    // Otherwise, climb from the video to likely containers.
    if (videoEl?.closest) {
      return (
        videoEl.closest(SEL.hoverTargets.join(",")) ||
        videoEl.parentElement ||
        videoEl
      );
    }
    return videoEl || document.documentElement;
  }

  async function ensurePlayerControlsVisible() {
    // Avoid clicking the video (can pause/play). Prefer pointer nudges.
    const v = document.querySelector(SEL.video);
    if (!v) return false;

    const hoverTarget = findHoverTarget(v);

    // Nudge the most likely control overlay surface, then the video, then the document.
    dispatchPointerNudge(hoverTarget);
    dispatchPointerNudge(v);
    dispatchPointerNudge(document.documentElement);

    // Small settle window to allow overlays to appear.
    await sleep(90);
    return true;
  }

  // ---------------- Quality parsing ---------------- //
  function parseQualityText(raw) {
    const text = (raw || "").trim();
    if (!text) return null;

    if (/^auto\b/i.test(text)) return { type: "auto", text };
    if (/source/i.test(text)) return { type: "source", text };
    if (/audio/i.test(text)) return { type: "audio", text };

    // Examples: 160p, 360p, 720p60
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
    if (!el) return "";
    return (el.innerText || el.textContent || "").trim();
  }

  function isSelectedOption(norm) {
    const stateEl = norm?.stateEl;
    if (!stateEl) return false;

    const role = stateEl.getAttribute?.("role");
    if (role === "menuitemradio") {
      return stateEl.getAttribute("aria-checked") === "true";
    }

    if (stateEl.getAttribute?.("aria-checked") === "true") return true;
    if (stateEl.getAttribute?.("aria-selected") === "true") return true;

    const root = norm?.root || stateEl;
    const checked = root?.querySelector?.('input[type="radio"]:checked');
    return !!checked;
  }

  function pickLowest(optionEls) {
    const items = optionEls
      .map((el) => normaliseOptionElement(el))
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

    // Prefer Auto over Source when no explicit video resolutions are detected (bandwidth minimisation).
    const auto = items.find((x) => x.info.type === "auto");
    const source = items.find((x) => x.info.type === "source");

    if (auto) return { chosen: auto, selected };
    if (source) return { chosen: source, selected };

    return null;
  }

  function getQualityOptions() {
    return qsaAny(SEL.qualityOptions);
  }

  async function waitForQualityOptions(timeoutMs = 900, intervalMs = 90) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const opts = getQualityOptions();
      if (opts.length) return opts;
      await sleep(intervalMs);
    }
    return [];
  }

  async function closeMenuIfOpen(settingsBtn) {
    if (!CFG.closeMenuAfterSelect) return;

    // Visibility-aware close: only click if menu is actually open/visible.
    if (!isMenuOpen(settingsBtn)) return;

    settingsBtn.click();
    await sleep(120);

    // If still visible, try one more (sometimes animations swallow the first click).
    if (isMenuOpen(settingsBtn)) {
      await ensurePlayerControlsVisible();
      settingsBtn.click();
      await sleep(140);
    }
  }

  // ---------------- UI navigation ---------------- //
  async function openSettingsAndQuality() {
    if (!isPlayerContext()) return { ok: false, reason: "no-player-context" };

    await ensurePlayerControlsVisible();

    const settingsBtn = qsAny(SEL.settingsBtn);
    if (!settingsBtn) return { ok: false, reason: "no-settings-btn" };

    // Visibility-aware open: only click if menu is not actually open/visible.
    if (!isMenuOpen(settingsBtn)) {
      settingsBtn.click();
      await sleep(150);

      // If still not open, do one more nudge+click.
      if (!isMenuOpen(settingsBtn)) {
        await ensurePlayerControlsVisible();
        settingsBtn.click();
        await sleep(180);
      }
    }

    if (!isMenuOpen(settingsBtn)) return { ok: false, reason: "settings-menu-not-open" };

    const qualityBtn = qsAny(SEL.qualityBtn);
    if (!qualityBtn) return { ok: false, reason: "no-quality-btn", settingsBtn };

    qualityBtn.click();
    await sleep(140);

    return { ok: true, settingsBtn };
  }

  // ---------------- Verification polling (improvement B) ---------------- //
  async function waitForSelectedKey(targetKey, timeoutMs, intervalMs) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const opts = getQualityOptions();
      if (opts.length) {
        const picked = pickLowest(opts);
        const selKey = picked?.selected ? qualityKey(picked.selected.info) : "";
        if (selKey && selKey === targetKey) return { ok: true, selKey };
      }
      await sleep(intervalMs);
    }

    return { ok: false, selKey: "" };
  }

  async function applyLowestQualityOnce() {
    if (!isPlayerContext()) return { ok: false, reason: "no-player-context" };
    if (CFG.writeLocalStorageHint) setLocalStorageHintLowest();

    const opened = await openSettingsAndQuality();
    if (!opened.ok) return opened;

    const { settingsBtn } = opened;

    // Wait a little for quality options to render (reduces spurious retries).
    const options = await waitForQualityOptions();
    if (!options.length) {
      await closeMenuIfOpen(settingsBtn);
      return { ok: false, reason: "no-options" };
    }

    const picked = pickLowest(options);
    if (!picked) {
      await closeMenuIfOpen(settingsBtn);
      return { ok: false, reason: "pick-failed" };
    }

    const { chosen, selected } = picked;

    const chosenKey = qualityKey(chosen.info);
    const selectedKey = selected ? qualityKey(selected.info) : "";

    log("Selected:", selected?.txt, "Chosen:", chosen.txt);

    // Already at desired option (key-based, robust vs label suffixes).
    if (selectedKey && chosenKey && selectedKey === chosenKey) {
      await closeMenuIfOpen(settingsBtn);
      return { ok: true, reason: "already-lowest" };
    }

    // Click the canonical clickable element.
    chosen.norm?.clickEl?.click?.();

    // Poll for selection state to update instead of immediately failing and retrying.
    const verify = await waitForSelectedKey(chosenKey, CFG.verifyTimeoutMs, CFG.verifyIntervalMs);

    await closeMenuIfOpen(settingsBtn);

    if (verify.ok) return { ok: true, reason: "changed-to-lowest" };
    return { ok: false, reason: "not-applied-yet" };
  }

  // ---------------- Scheduler ---------------- //
  let lastUrl = location.href;
  let attempts = 0;
  let applying = false;
  let done = false;
  let lastTryAt = 0;

  function reset() {
    lastUrl = location.href;
    attempts = 0;
    applying = false;
    done = false;
    lastTryAt = 0;

    if (CFG.writeLocalStorageHint) setLocalStorageHintLowest();
  }

  function maybeRun(reason) {
    if (location.href !== lastUrl) reset();
    if (done || applying) return;
    if (attempts >= CFG.maxAttemptsPerUrl) return;

    if (!isPlayerContext()) return;

    const now = Date.now();
    if (now - lastTryAt < CFG.retryCooldownMs) return;

    applying = true;
    lastTryAt = now;
    attempts++;

    setTimeout(async () => {
      try {
        const res = await applyLowestQualityOnce();
        log(reason, "attempt", attempts, res);

        if (res.ok) {
          done = true;
        }
      } finally {
        applying = false;
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
  document.addEventListener("loadeddata", (e) => e?.target?.tagName === "VIDEO" && maybeRun("video-loadeddata"), true);
  document.addEventListener("playing", (e) => e?.target?.tagName === "VIDEO" && maybeRun("video-playing"), true);

  function startObserver() {
    const obs = new MutationObserver(() => {
      if (!isPlayerContext()) return;

      // Only react if player UI is likely present.
      if (qsAny(SEL.settingsBtn) || getSettingsMenuEl()) {
        maybeRun("observer");
      }
    });

    const target = document.documentElement;
    if (target) obs.observe(target, { childList: true, subtree: true });

    const stopAfterMs = 30000;
    setTimeout(() => obs.disconnect(), stopAfterMs);
  }

  // Initial
  reset();
  startObserver();
  maybeRun("init");
})();

