// ==UserScript==
// @name         YouTube Auto Like (Mod)
// @namespace    https://github.com/Xenfernal
// @version      0.4
// @description  Automatically likes a video/livestream on YouTube. Modified Script by Yukiteru on Greasy Fork to better detect page navigations.
// @author       Xen
// @license      MIT
// @match        https://www.youtube.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_addValueChangeListener
// @homepageURL  https://github.com/Xenfernal/Personal-QoL-Stuff/tree/main/Userscripts
// @downloadURL  https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/YT%20Auto-Liker.user.js
// @updateURL    https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/YT%20Auto-Liker.user.js
// @require      https://greasyfork.org/scripts/470224-tampermonkey-config/code/Tampermonkey%20Config.js
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

// Cached DOM elements
let likeButtonCache = null;
let videoCache = null;
let subscribeButtonCache = null;

// Cached config values
let configCache = null;

// Listener state
let listenerActive = false;

// Get and cache the like button
function getLikeButton() {
  if (!likeButtonCache) {
    likeButtonCache = document.querySelector("like-button-view-model button.yt-spec-button-shape-next");
  }
  return likeButtonCache;
}

// Get and cache the video element
function getVideo() {
  if (!videoCache) {
    videoCache = document.querySelector("video.html5-main-video");
  }
  return videoCache;
}

// Get and cache the subscribe button
function isSubscribed() {
  if (!subscribeButtonCache) {
    subscribeButtonCache = document.querySelector("ytd-subscribe-button-renderer");
  }
  return subscribeButtonCache.hasAttribute("subscribed");
}

// Get and cache config values
function getConfig() {
  if (!configCache) {
    configCache = {
      ratio: config.get('ratio'),
      livestream: config.get('livestream'),
      only_sub: config.get('only_sub'),
    };
  }
  return configCache;
}

// Check if the video is already liked
function isLiked() {
  return getLikeButton().getAttribute("aria-pressed") === "true";
}

// Determine if the video should be liked
function shouldLike() {
  if (isSubscribed()) return true;
  return !getConfig().only_sub;
}

// Check if the video is a livestream
function isLivestream() {
  const liveBadge = document.querySelector(".ytp-live");
  return liveBadge !== null;
}

// Like the video
function like() {
  if (isLiked()) printLog("user liked manually");
  else getLikeButton().click();
  if (listenerActive) {
    getVideo().removeEventListener("timeupdate", listener);
    listenerActive = false;
  }
}

// Listener for video progress
function listener() {
  const video = getVideo();
  const percentage = getConfig().ratio / 100;
  if (video.currentTime / video.duration > percentage && shouldLike()) {
    like(video);
  }
}

// Find the like button and set up the observer
function findLikeButton() {
  const observer = new MutationObserver((mutations, observer) => {
    const likeButton = getLikeButton();
    if (!likeButton) return;

    printLog("like button checked");
    observer.disconnect();

    if (!shouldLike()) return false;
    if (isLivestream() && shouldLike() && getConfig().livestream === true) return like(); // like and exit if this is a livestream

    if (!listenerActive) {
      getVideo().addEventListener("timeupdate", listener);
      listenerActive = true;
    }
  });

  // Observe only the video player container and its attributes
  const targetNode = document.querySelector("ytd-watch-flexy #player-container");
  if (targetNode) {
    observer.observe(targetNode, { attributes: true, childList: true, subtree: true });
  }
}

// Detect URL changes and SPA navigations
function handleUrlChange() {
  const currentUrl = window.location.href;
  let lastUrl = currentUrl;
  let lastIsLivestream = isLivestream();

  const checkUrlChange = () => {
    if (window.location.href !== lastUrl || isLivestream() !== lastIsLivestream) {
      lastUrl = window.location.href;
      lastIsLivestream = isLivestream();
      resetState();
      findLikeButton();
    }
  };

  setInterval(checkUrlChange, 1000); // Check for URL changes every second
}

// Reset caches and listeners on page navigation
function resetState() {
  likeButtonCache = null;
  videoCache = null;
  subscribeButtonCache = null;
  configCache = null;
  listenerActive = false;
}

// Initialize the script
function init() {
  findLikeButton();
  handleUrlChange();
}

// Listen for page navigation events
document.addEventListener("yt-navigate-finish", () => {
  resetState();
  findLikeButton();
});

// Start the script
init();
