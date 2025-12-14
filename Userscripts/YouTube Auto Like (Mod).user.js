// ==UserScript==
// @name         YouTube Auto Like (Mod)
// @version      1.0
// @description  Automatically likes a video or livestream on YouTube (SPA navigation supported). This is a modified script by Yukiteru found on GreasyFork.
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @match        https://www.youtube.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_addValueChangeListener
// @homepageURL  https://github.com/Xenfernal/Personal-QoL-Stuff/tree/main/Userscripts
// @downloadURL  https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/YouTube%20Auto%20Like%20(Mod).user.js
// @updateURL    https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/YouTube%20Auto%20Like%20(Mod).user.js
// @require      https://greasyfork.org/scripts/470224-tampermonkey-config/code/Tampermonkey%20Config.js
// @license      MIT
// ==/UserScript==

function printLog(message) {
  console.log(`[YouTube Auto Like]: ${message}`);
}

const config_desc = {
  ratio: {
    name: "Like after percentage",
    processor: "int_range-1-100",
    value: 50,
  },
  livestream: {
    name: "Auto like livestreams",
    input: "current",
    processor: "not",
    formatter: "boolean",
    value: true,
  },
  only_sub: {
    name: "Only like subscribed channels",
    input: "current",
    processor: "not",
    formatter: "boolean",
    value: true,
  },
};
const config = new GM_config(config_desc);

let currentVideo = null;
let likeButtonObserver = null;
let observerTimeoutId = null;
let reinitPending = false;
let reinitReason = "";
let setupQueued = false;
let skipLogged = false;

function detachVideoListener() {
  if (currentVideo) {
    currentVideo.removeEventListener("timeupdate", listener);
    currentVideo = null;
  }
}

function scheduleReinit(reason) {
  reinitReason = reason;
  if (reinitPending) return;
  reinitPending = true;

  requestAnimationFrame(() => {
    reinitPending = false;
    reinit(reinitReason);
  });
}

function getLikeButton() {
  return (
    document.querySelector("#top-level-buttons-computed like-button-view-model button") ||
    document.querySelector("like-button-view-model button")
  );
}

function getVideo() {
  return (
    document.querySelector("#movie_player video.html5-main-video") ||
    document.querySelector("video.html5-main-video")
  );
}

function isLiked(btn = null) {
  if (!btn || !btn.isConnected) btn = getLikeButton();
  return !!btn && btn.getAttribute("aria-pressed") === "true";
}

function isSubscribed() {
  const r =
    document.querySelector("ytd-watch-flexy ytd-subscribe-button-renderer") ||
    document.querySelector("ytd-subscribe-button-renderer");

  if (!r) return false;

  if (r.hasAttribute("subscribed")) return true;

  const state = r.getAttribute("subscribe-button-state");
  if (state && state.toUpperCase().includes("SUBSCRIBED") && !state.toUpperCase().includes("UNSUB")) return true;

  const btn = r.querySelector("button, tp-yt-paper-button");
  const pressed = btn?.getAttribute("aria-pressed");
  if (pressed === "true") return true;

  return false;
}

function shouldLike() {
  if (config.get('only_sub') && !isSubscribed()) return false;
  return true;
}

function isLivestream() {
  if (document.querySelector(".ytp-live")) return true;

  const v = getVideo();
  if (v && v.duration === Infinity) return true; // <- only true live behaviour

  return false;
}

function like() {
  const likeButton = getLikeButton();
  if (!likeButton) {
    printLog("Like button not found.");
    return;
  }

  if (isLiked(likeButton)) {
    printLog("Already liked. Skipping click.");
  } else {
    likeButton.click();
    printLog("Video liked automatically.");
  }

  // Remove the timeupdate listener to prevent multiple likes
  detachVideoListener();
}

function listener() {
  const video = getVideo();
  if (!video) return;

  const dur = video.duration;
  if (!Number.isFinite(dur) || dur <= 0) return;

  const percentage = config.get('ratio') / 100;
  if (video.currentTime / dur > percentage && shouldLike()) {
    like();
  }
}

function trySetup() {
  const likeButton = getLikeButton();
  const video = getVideo();

  if (!likeButton) return false;

  // If already liked, no need to add listeners
  if (isLiked(likeButton)) {
    printLog("Already liked. No action needed.");
    detachVideoListener();
    return true;
  }

  // Only-sub gate: don’t arm yet if not subscribed
  if (!shouldLike()) {
    if (!skipLogged) {
      printLog("Skipping like.");
      skipLogged = true;
    }
    return false;
  }
  skipLogged = false;

  // Livestream: like immediately if enabled
  if (isLivestream() && config.get("livestream")) {
    printLog("Livestream detected. Liking immediately.");
    like();
    return true;
  }

  // Normal video: attach to the *current* video element
  if (video) {
    if (currentVideo !== video) {
      detachVideoListener();
      currentVideo = video;
      currentVideo.addEventListener("timeupdate", listener);
      printLog("Added timeupdate listener.");
    }
    return true;
  }

  return false;
}

function findLikeButton() {
  if (likeButtonObserver) {
    likeButtonObserver.disconnect();
    likeButtonObserver = null;
  }

  if (observerTimeoutId) {
    clearTimeout(observerTimeoutId);
    observerTimeoutId = null;
  }

  setupQueued = false;

  // Immediate attempt first (important for SPA navigations)
  if (trySetup()) return;

  likeButtonObserver = new MutationObserver((mutations, observer) => {
    if (setupQueued) return;
    setupQueued = true;

    requestAnimationFrame(() => {
      setupQueued = false;
      if (trySetup()) {
        observer.disconnect();
        likeButtonObserver = null;
        if (observerTimeoutId) clearTimeout(observerTimeoutId);
        observerTimeoutId = null;
      }
    });
  });

  likeButtonObserver.observe(document, { childList: true, subtree: true });

  observerTimeoutId = setTimeout(() => {
    if (likeButtonObserver) likeButtonObserver.disconnect();
    likeButtonObserver = null;
    printLog("Observer timeout. Will re-arm on next navigation.");
  }, 20000);
}

function reinit(reason) {
  printLog(`${reason}. Reinitializing...`);

  skipLogged = false;
  setupQueued = false;

  detachVideoListener();

  if (likeButtonObserver) {
    likeButtonObserver.disconnect();
    likeButtonObserver = null;
  }

  if (observerTimeoutId) {
    clearTimeout(observerTimeoutId);
    observerTimeoutId = null;
  }

  findLikeButton();
}

// Reinitialize the script on navigation
document.addEventListener("yt-navigate-finish", () => scheduleReinit("Navigation detected"));
document.addEventListener("yt-page-data-updated", () => scheduleReinit("Page data updated"));

(function hookUrlChangeFallback() {
  let lastUrl = location.href;

  const fire = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    scheduleReinit("URL changed (fallback)");
  };

  const origPush = history.pushState;
  history.pushState = function (...args) {
    const ret = origPush.apply(this, args);
    fire();
    return ret;
  };

  const origReplace = history.replaceState;
  history.replaceState = function (...args) {
    const ret = origReplace.apply(this, args);
    fire();
    return ret;
  };

  window.addEventListener("popstate", fire);
})();

// Initial run
findLikeButton();
