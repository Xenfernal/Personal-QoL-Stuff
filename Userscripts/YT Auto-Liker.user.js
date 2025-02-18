// ==UserScript==
// @name         YT Auto-Liker
// @namespace    https://github.com/Xenfernal
// @version      1.8
// @description  Automatically likes a video/livestream on YouTube. Lightweight and compatible with different layouts.
// @author       Xen
// @match        https://www.youtube.com/live/*
// @match        https://www.youtube.com/watch*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @homepageURL  https://github.com/Xenfernal/Personal-QoL-Stuff/tree/main/Userscripts
// @downloadURL  https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/YT%20Auto-Liker.user.js
// @updateURL    https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/YT%20Auto-Liker.user.js
// @license      MIT
// ==/UserScript==

const defaultConfig = {
    ratio: 50,
    livestream: true,
    only_sub: true,
};

const config = {
    ratio: GM_getValue('ratio', defaultConfig.ratio),
    livestream: GM_getValue('livestream', defaultConfig.livestream),
    only_sub: GM_getValue('only_sub', defaultConfig.only_sub),
};

const menuCommands = {};

function saveConfig() {
    GM_setValue('ratio', config.ratio);
    GM_setValue('livestream', config.livestream);
    GM_setValue('only_sub', config.only_sub);
    console.info("%c[YT Auto-Liker]: Configuration saved.", "color: green;");
}

function updateMenu() {
    GM_unregisterMenuCommand(menuCommands.setLikePercentage);
    GM_unregisterMenuCommand(menuCommands.toggleLivestream);
    GM_unregisterMenuCommand(menuCommands.toggleOnlySubscribed);

    menuCommands.setLikePercentage = GM_registerMenuCommand(`Set Like After Percentage: ${config.ratio}%`, () => {
        const ratio = prompt('Enter percentage (1-100):', config.ratio);
        if (ratio >= 1 && ratio <= 100) {
            config.ratio = parseInt(ratio);
            saveConfig();
            updateMenu();
        }
    });

    menuCommands.toggleLivestream = GM_registerMenuCommand(`Auto Like Livestreams: ${config.livestream ? '✅' : '❌'}`, () => {
        config.livestream = !config.livestream;
        saveConfig();
        updateMenu();
    });

    menuCommands.toggleOnlySubscribed = GM_registerMenuCommand(`Only Like Subscribed Channels: ${config.only_sub ? '✅' : '❌'}`, () => {
        config.only_sub = !config.only_sub;
        saveConfig();
        updateMenu();
    });
}

updateMenu();

function getLikeButton() {
    const selectors = [
        "like-button-view-model button.yt-spec-button-shape-next",
        "ytd-toggle-button-renderer[is-icon-button][aria-pressed] button",
        "button[aria-label*='like']",
        "button[aria-label*='Like']",
        "button[title*='like']",
        "button[title*='Like']"
    ];

    for (let selector of selectors) {
        let likeButton = document.querySelector(selector);
        if (likeButton) {
            console.info(`%c[YT Auto-Liker]: Like button found using selector: %c${selector}`, "color: blue;", "color: yellow;");
            return likeButton;
        }
    }

    let buttons = document.querySelectorAll("button");
    for (let button of buttons) {
        let label = button.getAttribute("aria-label") || button.getAttribute("title");
        if (label && /like/i.test(label)) {
            console.info(`%c[YT Auto-Liker]: Like button found via manual scan.`, "color: blue;");
            return button;
        }
    }

    console.warn("%c[YT Auto-Liker]: Like button NOT found.", "color: red;");
    return null;
}

function getVideo() {
    const video = document.querySelector('video.html5-main-video');
    if (!video) {
        console.warn("%c[YT Auto-Liker]: Video element not found.", "color: red;");
        setTimeout(getVideo, 500);
    }
    return video;
}

function isLiked() {
    const likeButton = getLikeButton();
    return likeButton && (likeButton.getAttribute("aria-pressed") === "true" || likeButton.textContent.includes("Liked"));
}

function isSubscribed() {
    const subscribeButton = document.querySelector("ytd-subscribe-button-renderer");
    if (subscribeButton) {
        if (subscribeButton.hasAttribute("subscribed")) {
            console.info("%c[YT Auto-Liker]: Channel is Subscribed to.", "color: green;");
            return true;
        } else {
            console.info("%c[YT Auto-Liker]: Channel is NOT Subscribed to.", "color: red;");
            return false;
        }
    } else {
        console.warn("%c[YT Auto-Liker]: Subscription status element not found.", "color: red;");
        return false;
    }
}

function shouldLike() {
    return isSubscribed() || !config.only_sub;
}

function isLivestream() {
    const liveBadge = document.querySelector('.ytp-live');
    if (liveBadge) {
        console.info("%c[YT Auto-Liker]: Livestream detected by live badge.", "color: green;");
        return true;
    }

    const liveMeta = document.querySelector('meta[itemprop="liveBroadcastContent"]');
    if (liveMeta && liveMeta.getAttribute('content') === 'live') {
        console.info("%c[YT Auto-Liker]: Livestream detected by meta tag.", "color: green;");
        return true;
    }

    const liveChat = document.querySelector('#live-chat');
    if (liveChat) {
        console.info("%c[YT Auto-Liker]: Livestream detected by live chat presence.", "color: green;");
        return true;
    }

    const premiereBadge = document.querySelector('.ytp-premiere');
    if (premiereBadge) {
        console.info("%c[YT Auto-Liker]: Livestream detected by premiere badge.", "color: green;");
        return true;
    }

    const joinButton = document.querySelector('button[aria-label="Join the livestream"]');
    if (joinButton) {
        console.info("%c[YT Auto-Liker]: Livestream detected by join button.", "color: green;");
        return true;
    }

    console.warn("%c[YT Auto-Liker]: Is not a Livestream.", "color: red;");
    return false;
}

function like() {
    const likeButton = getLikeButton();
    if (!isLiked()) {
        likeButton.click();
        console.info("%c[YT Auto-Liker]: Video/Livestream liked successfully.", "color: green;");
    }
    getVideo().removeEventListener("timeupdate", listener);
}

function listener() {
    const video = getVideo();
    if (video.currentTime / video.duration > config.ratio / 100 && shouldLike()) {
        like();
    }
}

function findLikeButton() {
    console.info("%c[YT Auto-Liker]: Searching for the Like button...", "color: blue;");

    const observer = new MutationObserver((mutations, observer) => {
        const likeButton = getLikeButton();
        if (!likeButton) {
            console.warn("%c[YT Auto-Liker]: Like button not found.", "color: red;");
            return;
        }

        observer.disconnect();
        console.info("%c[YT Auto-Liker]: Like button detected, starting auto-like process.", "color: blue;");

        if (!shouldLike()) return;

        if (isLivestream() && config.livestream) {
            like();
            return;
        }

        getVideo().addEventListener("timeupdate", listener);
    });

    const vidPlayer = document.querySelector('ytd-watch-flexy');
    if (!vidPlayer) {
        console.warn("%c[YT Auto-Liker]: Like button not found. Retrying in 500ms.", "color: red;");
        setTimeout(findLikeButton, 500); // Retry logic
    } else {
        observer.observe(vidPlayer, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'class'] });
    }
}

document.addEventListener("yt-navigate-finish", findLikeButton);
