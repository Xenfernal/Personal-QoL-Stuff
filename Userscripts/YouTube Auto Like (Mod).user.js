// ==UserScript==
// @name         YouTube Auto Like (Mod)
// @version      0.2
// @description  Automatically likes a video or livestream on YouTube, even after navigating between videos/livestreams. This is a modified script by Yukiteru found on GreasyFork.
// @license      MIT
// @match        https://www.youtube.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_addValueChangeListener
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

let likeButtonObserver = null;
let videoEventListenerAdded = false;

function getLikeButton() {
  return document.querySelector("like-button-view-model button");
}

function getVideo() {
  return document.querySelector("video.html5-main-video");
}

function isLiked() {
  const likeButton = getLikeButton();
  return likeButton && likeButton.getAttribute("aria-pressed") === "true";
}

function isSubscribed() {
  const subscribeButton = document.querySelector("ytd-subscribe-button-renderer");
  return subscribeButton && subscribeButton.hasAttribute("subscribed");
}

function shouldLike() {
  if (config.get('only_sub') && !isSubscribed()) return false;
  return true;
}

function isLivestream() {
  const liveBadge = document.querySelector(".ytp-live");
  return liveBadge !== null;
}

function like() {
  const likeButton = getLikeButton();
  if (!likeButton) {
    printLog("Like button not found.");
    return;
  }

  if (isLiked()) {
    printLog("User liked manually.");
  } else {
    likeButton.click();
    printLog("Video liked automatically.");
  }

  // Remove the timeupdate listener to prevent multiple likes
  const video = getVideo();
  if (video) {
    video.removeEventListener("timeupdate", listener);
    videoEventListenerAdded = false;
  }
}

function listener() {
  const video = getVideo();
  if (!video) return;

  const percentage = config.get('ratio') / 100;
  if (video.currentTime / video.duration > percentage && shouldLike()) {
    like();
  }
}

function findLikeButton() {
  if (likeButtonObserver) {
    likeButtonObserver.disconnect();
  }

  likeButtonObserver = new MutationObserver((mutations, observer) => {
    const likeButton = getLikeButton();
    if (!likeButton) return;

    printLog("Like button found.");
    observer.disconnect();

    if (!shouldLike()) {
      printLog("Skipping like (user not subscribed or only_sub enabled).");
      return;
    }

    if (isLivestream() && config.get('livestream')) {
      printLog("Livestream detected. Liking immediately.");
      like();
      return;
    }

    const video = getVideo();
    if (video && !videoEventListenerAdded) {
      video.addEventListener("timeupdate", listener);
      videoEventListenerAdded = true;
      printLog("Added timeupdate listener.");
    }
  });

  likeButtonObserver.observe(document, { childList: true, subtree: true });
}

// Reinitialize the script on navigation
document.addEventListener("yt-navigate-finish", () => {
  printLog("Navigation detected. Reinitializing...");
  findLikeButton();
});

// Initial run
findLikeButton();
