// ==UserScript==
// @name         YT Auto-Liker
// @namespace    https://github.com/Xenfernal
// @version      1.0
// @description  Automatically likes a video/livestream on YouTube. Based on another script I modified to make it more lightweight and compatabile with different layouts on desktop.
// @author       Xen
// @match        https://www.youtube.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @homepageURL  https://github.com/Xenfernal/Personal-QoL-Stuff/tree/main/Userscripts
// @license      MIT
// ==/UserScript==

const defaultConfig = {
    ratio: 50, // Like after 50% of the video is played
    livestream: true, // Auto like livestreams
    only_sub: true, // Only like videos from subscribed channels
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
    let likeButton = document.querySelector("like-button-view-model button.yt-spec-button-shape-next");
    if (likeButton) return likeButton;

    likeButton = document.querySelector("ytd-toggle-button-renderer.style-scope.ytd-video-primary-info-renderer");
    if (likeButton) return likeButton.querySelector("button");

    likeButton = document.querySelector('button[aria-label="I like this"]');
    if (likeButton) return likeButton;

    likeButton = document.querySelector('button[aria-label*="like"]');
    return likeButton;
}

function getVideo() {
    return document.querySelector('video.html5-main-video');
}

function isLiked() {
    const likeButton = getLikeButton();
    return likeButton.getAttribute("aria-pressed") === "true" || likeButton.textContent.includes("Liked");
}

function isSubscribed() {
    const subscribeButton = document.querySelector("ytd-subscribe-button-renderer");
    if (subscribeButton && subscribeButton.hasAttribute("subscribed")) return true;
    return subscribeButton && subscribeButton.textContent.toLowerCase().includes("subscribed");
}

function shouldLike() {
    return isSubscribed() || !config.only_sub;
}

function isLivestream() {
    const video = getVideo();
    if (video && video.duration === Infinity) return true;

    const liveBadge = document.querySelector('.ytp-live');
    if (liveBadge !== null) return true;

    const liveMetadata = document.querySelector("ytd-video-owner-renderer #info-contents");
    if (liveMetadata && liveMetadata.textContent.includes("LIVE")) return true;

    return window.location.href.includes("live");
}

function like() {
    const likeButton = getLikeButton();
    if (!isLiked()) {
        likeButton.click();
        console.log("[YT Auto-Liker]: Video/Livestream liked successfully.");
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
    const observer = new MutationObserver((mutations, observer) => {
        if (!getLikeButton()) return;

        observer.disconnect();
        if (!shouldLike()) return;

        if (isLivestream() && config.livestream) {
            like();
            return;
        }

        getVideo().addEventListener("timeupdate", listener);
    });

    const vidPlayer = document.querySelector('ytd-watch-flexy');
    if (!vidPlayer) {
        setTimeout(findLikeButton, 500);
    } else {
        observer.observe(vidPlayer, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'class'] });
    }
}

document.addEventListener("yt-navigate-finish", findLikeButton);
