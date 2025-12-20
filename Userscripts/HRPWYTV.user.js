// ==UserScript==
// @name        Hide Read Posts & Watched YouTube Videos
// @namespace   https://github.com/Xenfernal
// @version     1.1
// @icon        https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @description Companion for "Mark Read Posts & Watched YouTube Videos" userscript: hide/unhide tiles marked as .watched or .read-post. Toggle via GM menu or Alt+H.
// @author      Xen
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
// @grant       GM_setValue
// @grant       GM_registerMenuCommand
// @grant       GM_addValueChangeListener
// @homepageURL https://github.com/Xenfernal/Personal-QoL-Stuff/tree/main/Userscripts
// @downloadURL https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/HRPWYTV.user.js
// @updateURL   https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/HRPWYTV.user.js
// @license     MIT
// @run-at      document-start
// ==/UserScript==

(() => {
  "use strict";

  const KEY_ENABLED = "mwyv_companion_hide_marked_enabled";
  const ATTR = "data-mwyv-hide-marked";
  const STYLE_ID = "mwyv_companion_hide_marked_style";
  const TOAST_ID = "mwyv_companion_hide_marked_toast";
  const DEFAULT_ENABLED = false;

  const isEditableTarget = (el) => {
    if (!el) return false;
    const t = (el.tagName || "").toUpperCase();
    return t === "INPUT" || t === "TEXTAREA" || t === "SELECT" || !!el.isContentEditable;
  };

  const getEnabled = () => !!GM_getValue(KEY_ENABLED, DEFAULT_ENABLED);

  const applyEnabledToDOM = (enabled) => {
    const root = document.documentElement;
    if (!root) return;
    if (enabled) root.setAttribute(ATTR, "1");
    else root.removeAttribute(ATTR);
  };

  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;

    style.textContent = `
html[${ATTR}="1"] ytd-rich-item-renderer.watched,
html[${ATTR}="1"] ytd-video-renderer.watched,
html[${ATTR}="1"] ytd-compact-video-renderer.watched,
html[${ATTR}="1"] ytd-playlist-video-renderer.watched,
html[${ATTR}="1"] ytd-playlist-panel-video-renderer.watched,
html[${ATTR}="1"] yt-lockup-view-model.watched,
html[${ATTR}="1"] .yt-lockup-view-model.watched,
html[${ATTR}="1"] li.watched,
html[${ATTR}="1"] .pl-video.watched,

html[${ATTR}="1"] ytd-rich-item-renderer.read-post,
html[${ATTR}="1"] ytd-backstage-post-thread-renderer.read-post,
html[${ATTR}="1"] ytd-backstage-post-renderer.read-post,
html[${ATTR}="1"] ytd-post-renderer.read-post,
html[${ATTR}="1"] ytd-community-post-renderer.read-post,
html[${ATTR}="1"] ytd-sponsorships-post-renderer.read-post,
html[${ATTR}="1"] ytd-sponsorships-posts-renderer.read-post,
html[${ATTR}="1"] ytd-membership-post-renderer.read-post,

/* Fallback: if main script marks something else with these classes, still hide it */
html[${ATTR}="1"] ytd-app .watched,
html[${ATTR}="1"] ytd-app .read-post {
  display: none !important;
}

#${TOAST_ID}{
  position:fixed;
  right:14px;
  bottom:14px;
  z-index:2147483647;
  padding:10px 12px;
  border-radius:12px;
  font: 12px/1.25 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  box-shadow: 0 8px 24px rgba(0,0,0,.25);
  background: rgba(20,20,20,.90);
  color: #fff;
  pointer-events:none;
  transform: translateY(6px);
  opacity: 0;
  transition: opacity .12s ease, transform .12s ease;
}
#${TOAST_ID}[data-show="1"]{ opacity:1; transform: translateY(0); }
`;
    (document.head || document.documentElement).appendChild(style);
  };

  const toast = (msg) => {
    try {
      let el = document.getElementById(TOAST_ID);
      if (!el) {
        el = document.createElement("div");
        el.id = TOAST_ID;
        (document.body || document.documentElement).appendChild(el);
      }
      el.textContent = msg;
      el.setAttribute("data-show", "1");
      clearTimeout(el.__mwyv_toast_t);
      el.__mwyv_toast_t = setTimeout(() => el.removeAttribute("data-show"), 1400);
    } catch (_) {}
  };

  const setEnabled = (enabled) => {
    enabled = !!enabled;
    GM_setValue(KEY_ENABLED, enabled);
    applyEnabledToDOM(enabled);
    toast(`Hide marked items: ${enabled ? "ON" : "OFF"}`);
  };

  const toggleEnabled = () => setEnabled(!getEnabled());

  const showStatus = () => {
    const enabled = getEnabled();
    alert(
      [
        "YouTube Companion: Hide Marked (Read/Watched)",
        "",
        `Current state: ${enabled ? "ON (marked items are hidden)" : "OFF (marked items are visible)"}`,
        "",
        "How it works:",
        "- Your main script adds .watched and .read-post classes to tiles",
        "- This companion hides those tiles via CSS when enabled",
        "",
        "Controls:",
        "- GM menu: Toggle hide/unhide",
        "- Hotkey: Alt + H"
      ].join("\n")
    );
  };

  ensureStyle();
  applyEnabledToDOM(getEnabled());

  if (typeof GM_addValueChangeListener === "function") {
    GM_addValueChangeListener(KEY_ENABLED, (_name, _oldVal, newVal) => {
      applyEnabledToDOM(!!newVal);
    });
  }

  addEventListener("keydown", (ev) => {
    if (ev.repeat) return;
    if (!ev.altKey || ev.ctrlKey || ev.metaKey) return;

    const keyOk = ev.code === "KeyH" || (typeof ev.key === "string" && ev.key.toLowerCase() === "h");
    if (!keyOk) return;

    if (isEditableTarget(ev.target) || isEditableTarget(document.activeElement)) return;

    ev.preventDefault();
    ev.stopImmediatePropagation();
    toggleEnabled();
  }, true);

  GM_registerMenuCommand("Toggle: Hide marked items (Read/Watched)", toggleEnabled);
  GM_registerMenuCommand("Status / Help (Hide Marked Companion)", showStatus);
})();
