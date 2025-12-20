// ==UserScript==
// @name         Prefer lowest stream quality on Twitch
// @namespace    https://github.com/Xenfernal
// @version      1.0
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

    maxAttemptsPerUrl: 4,
    retryCooldownMs: 1200,

    // Optional: also write localStorage hints (useful when UI selectors fail)
    writeLocalStorageHint: true,

    // Debug logs
    debug: true,
  };

  const log = (...a) => CFG.debug && console.log("[Twitch Lowest Quality]", ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function setLocalStorageHintLowest() {
    // Hint Twitch towards 160p30 (if available). If not available, Twitch may ignore/fallback.
    try {
      localStorage.setItem("s-qs-ts", String(Date.now()));
      localStorage.setItem("quality-bitrate", "230000");
      localStorage.setItem("video-quality", '{"default":"160p30"}');
    } catch (e) {
      // ignore
    }
  }

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

  function isSelectedOption(el) {

    if (el?.getAttribute?.("aria-checked") === "true") return true;
    if (el?.getAttribute?.("aria-selected") === "true") return true;

    const checked = el?.querySelector?.('input[type="radio"]:checked,[aria-checked="true"],[aria-selected="true"]');
    return !!checked;
  }

  function pickLowest(options) {
    const items = options
      .map((el) => {
        const txt = (el.innerText || el.textContent || "").trim();
        const info = parseQualityText(txt);
        return info ? { el, info, txt, selected: isSelectedOption(el) } : null;
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

    const source = items.find((x) => x.info.type === "source");
    if (source) return { chosen: source, selected };

    const auto = items.find((x) => x.info.type === "auto");
    if (auto) return { chosen: auto, selected };

    return null;
  }

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

  async function openSettingsAndQuality() {
    const settingsBtn = qsAny([
      'button[data-a-target="player-settings-button"]',
      'button[aria-label*="Settings"]',
      'button[aria-label*="settings"]',
    ]);
    if (!settingsBtn) return { ok: false, reason: "no-settings-btn" };

    if (!document.querySelector('div[data-a-target="player-settings-menu"]')) {
      settingsBtn.click();
      await sleep(120);
    }

    const qualityBtn = qsAny([
      'button[data-a-target="player-settings-menu-item-quality"]',
      'button[aria-label*="Quality"]',
      'button[aria-label*="quality"]',
    ]);
    if (!qualityBtn) return { ok: false, reason: "no-quality-btn", settingsBtn };

    qualityBtn.click();
    await sleep(160);

    return { ok: true, settingsBtn };
  }

  async function applyLowestQualityOnce() {
    if (CFG.writeLocalStorageHint) setLocalStorageHintLowest();

    const opened = await openSettingsAndQuality();
    if (!opened.ok) return opened;

    const { settingsBtn } = opened;

    const options = qsaAny([
      '[data-a-target="player-settings-submenu-quality-option"]',
      'div[data-a-target="player-settings-menu"] [role="menuitemradio"]',
      'div[data-a-target="player-settings-menu"] label',
    ]);

    if (!options.length) {
      if (CFG.closeMenuAfterSelect && document.querySelector('div[data-a-target="player-settings-menu"]')) {
        settingsBtn.click();
      }
      return { ok: false, reason: "no-options" };
    }

    const picked = pickLowest(options);
    if (!picked) {
      if (CFG.closeMenuAfterSelect && document.querySelector('div[data-a-target="player-settings-menu"]')) {
        settingsBtn.click();
      }
      return { ok: false, reason: "pick-failed" };
    }

    const { chosen, selected } = picked;

    log("Selected:", selected?.txt, "Chosen:", chosen.txt);

    if (selected && selected.txt && chosen.txt && selected.txt === chosen.txt) {
      if (CFG.closeMenuAfterSelect && document.querySelector('div[data-a-target="player-settings-menu"]')) {
        settingsBtn.click();
      }
      return { ok: true, reason: "already-lowest" };
    }

    chosen.el.click();
    await sleep(260);

    const options2 = qsaAny([
      '[data-a-target="player-settings-submenu-quality-option"]',
      'div[data-a-target="player-settings-menu"] [role="menuitemradio"]',
      'div[data-a-target="player-settings-menu"] label',
    ]);
    const picked2 = options2.length ? pickLowest(options2) : null;
    const nowSel = picked2?.selected?.txt || "";

    if (CFG.closeMenuAfterSelect && document.querySelector('div[data-a-target="player-settings-menu"]')) {
      settingsBtn.click();
    }

    if (nowSel && nowSel === chosen.txt) return { ok: true, reason: "changed-to-lowest" };

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

  document.addEventListener("loadeddata", (e) => e?.target?.tagName === "VIDEO" && maybeRun("video-loadeddata"), true);
  document.addEventListener("playing", (e) => e?.target?.tagName === "VIDEO" && maybeRun("video-playing"), true);

  function startObserver() {
    const obs = new MutationObserver(() => {

      if (
        document.querySelector('button[data-a-target="player-settings-button"]') ||
        document.querySelector('div[data-a-target="player-settings-menu"]')
      ) {
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
