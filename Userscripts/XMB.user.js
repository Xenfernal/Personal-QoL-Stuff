// ==UserScript==
// @name         Mute/Block X followers automatically
// @namespace    https://github.com/Xenfernal
// @version      1.6
// @description  Mute/Block users automatically found on follower pages/lists with an exclude feature.
// @author       Xen
// @match        https://x.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=x.com
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @homepageURL  https://github.com/Xenfernal/Personal-QoL-Stuff/tree/main/Userscripts
// @downloadURL  https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/XMB.user.js
// @updateURL    https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/XMB.user.js
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const EXCLUDED_KEY = "excludedUsers";

    const USERNAME_RE = /^[A-Za-z0-9_]{1,15}$/;
    const USERNAME_PATH_RE = /^\/[A-Za-z0-9_]{1,15}$/;

    const RESERVED_ROOTS = new Set([
        'home', 'explore', 'notifications', 'messages', 'settings', 'search',
        'i', 'intent', 'compose', 'login', 'logout', 'tos', 'privacy', 'help'
    ]);

    let affectedAccountUrls = Object.create(null);
    const excludedUsers = new Set(loadExcludedUsers());

    const runState = {
        running: false,
        paused: false,
        stopRequested: false,
        actionType: null,
    };

    const excludeWrapperByRow = new WeakMap();
    let stylesInjected = false;

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function ensureStyles() {
        if (stylesInjected) return;
        stylesInjected = true;

        GM_addStyle(`
  #mute-block-container {
        position: relative;
        border-radius: 12px;
        box-shadow: 0px 4px 10px rgba(0, 0, 0, 0.3);
        display: flex;
        flex-direction: row;
        justify-content: center;
        gap: 12px;
        z-index: 9999;
        width: auto;
        min-width: 300px;
    }

  #mute-all-button, #block-all-button {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        font-size: 16px;
        font-weight: bold;
        color: #ffffff;
        border: 2px solid #ffffff;
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.3s ease-in-out;
        width: 48.5%;
        text-align: center;
    }

      #mute-all-button::before {
        content: "🔇";
        font-size: 18px;
    }

      #mute-all-button {
        background: #2c2c2c;
    }

      #mute-all-button:hover {
        background: #444;
    }

      #mute-all-button:active {
        background: #1a1a1a;
    }

      #block-all-button::before {
        content: "🚫";
        font-size: 18px;
    }

      #block-all-button {
        background: #ff4c4c;
    }

      #block-all-button:hover {
        background: #d93b3b;
    }

      #block-all-button:active {
        background: #b82e2e;
    }

    .exclude-button-wrapper {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px;
        border-radius: 12px;
        background-color: rgba(0, 0, 0, 0.05);
        transition: background-color 0.3s ease-in-out, transform 0.2s ease;
        position: absolute;
        right: 120px;
        z-index: 1;
    }

    .exclude-button-wrapper:hover {
        background-color: rgba(0, 0, 0, 0.1);
        transform: scale(1.05);
    }

    .exclude-button {
        font-size: 14px;
        font-weight: bold;
        color: #ffffff;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        padding: 6px 12px;
        transition: background-color 0.3s ease, transform 0.2s ease;
    }

    .exclude-button.exclude {
        background-color: #ff4c4c;
    }

    .exclude-button.exclude:hover {
        background-color: #d93b3b;
    }

    .exclude-button.exclude:active {
        background-color: #b82e2e;
    }

    .exclude-button.include {
        background-color: #2c2c2c;
    }

    .exclude-button.include:hover {
        background-color: #444;
    }

    .exclude-button.include:active {
        background-color: #1a1a1a;
    }

    #x-mute-block-toast {
        position: fixed;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        z-index: 2147483647;
        padding: 12px 16px;
        border-radius: 12px;
        background: rgba(0,0,0,0.85);
        color: #fff;
        font-size: 14px;
        font-weight: 700;
        box-shadow: 0px 10px 30px rgba(0,0,0,0.35);
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.15s ease-in-out;
        max-width: min(520px, 92vw);
        text-align: center;
        line-height: 1.25;
    }

    #x-mute-block-toast.show {
        opacity: 1;
    }
`);
    }

    function showToast(message) {
        ensureStyles();

        let toast = document.getElementById('x-mute-block-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'x-mute-block-toast';
            toast.setAttribute('role', 'status');
            toast.setAttribute('aria-live', 'polite');
            document.documentElement.appendChild(toast);
        }

        toast.textContent = message;
        toast.classList.add('show');

        if (showToast._t) clearTimeout(showToast._t);
        showToast._t = setTimeout(() => {
            toast.classList.remove('show');
        }, 1600);
    }

    function togglePause() {
        if (!runState.running) {
            showToast('No bulk action running.');
            return;
        }
        runState.paused = !runState.paused;
        showToast(runState.paused ? 'Paused. Press Escape to resume.' : 'Resumed.');
    }

    function requestStop() {
        if (!runState.running) {
            showToast('No bulk action running.');
            return;
        }
        runState.stopRequested = true;
        runState.paused = false;
        showToast('Stopping…');
    }

    async function checkpoint() {
        while (runState.running && runState.paused && !runState.stopRequested) {
            await sleep(50);
        }
        return !(runState.running && runState.stopRequested);
    }

    function getFollowersRoots() {
        const roots = [];
        const vf = document.querySelector('[aria-label="Timeline: Verified Followers"]');
        if (vf) roots.push(vf);
        const f = document.querySelector('[aria-label="Timeline: Followers"]');
        if (f) roots.push(f);
        return roots;
    }

    function getFollowersRows() {
        const roots = getFollowersRoots();
        const rows = [];
        for (const root of roots) {
            for (const lvl1 of root.children) {
                for (const lvl2 of lvl1.children) rows.push(lvl2);
            }
        }
        return rows;
    }

    function isFollowersPage() {
        return getFollowersRoots().length > 0;
    }

    function normaliseProfileUrl(rawHref) {
        if (!rawHref) return null;

        let u;
        try {
            u = new URL(rawHref, location.origin);
        } catch {
            return null;
        }

        const pathname = (u.pathname || '').replace(/\/+$/, '');
        const segs = pathname.split('/').filter(Boolean);

        if (segs.length !== 1) return null;

        const username = segs[0];
        if (!USERNAME_RE.test(username)) return null;
        if (RESERVED_ROOTS.has(username.toLowerCase())) return null;

        return `${location.origin}/${username}`;
    }

    function extractProfileAnchorFromRow(row) {
        if (!row) return null;

        const anchors = row.querySelectorAll('a[href]');
        let best = null;

        for (const a of anchors) {
            const hrefAttr = a.getAttribute('href');

            if (hrefAttr && USERNAME_PATH_RE.test(hrefAttr)) {
                const norm = normaliseProfileUrl(hrefAttr);
                if (norm) return a;
            }

            if (!best) {
                const norm = normaliseProfileUrl(a.href);
                if (norm) best = a;
            }
        }
        return best;
    }

    function extractProfileUrlFromRow(row) {
        const a = extractProfileAnchorFromRow(row);
        if (!a) return null;
        return normaliseProfileUrl(a.href) || normaliseProfileUrl(a.getAttribute('href'));
    }

    function getHandleFromProfileUrl(profileUrl) {
        if (!profileUrl) return null;
        try {
            const u = new URL(profileUrl);
            const segs = (u.pathname || '').split('/').filter(Boolean);
            return segs.length === 1 ? segs[0] : null;
        } catch {
            return null;
        }
    }

    function loadExcludedUsers() {
        let arr;
        try {
            arr = JSON.parse(GM_getValue(EXCLUDED_KEY, "[]"));
            if (!Array.isArray(arr)) arr = [];
        } catch {
            arr = [];
        }

        const out = [];
        for (const item of arr) {
            const norm = normaliseProfileUrl(item);
            if (norm) out.push(norm);
        }
        return out;
    }

    function persistExcludedUsers() {
        GM_setValue(EXCLUDED_KEY, JSON.stringify([...excludedUsers]));
    }

    function findButton(actionType) {
        const dropdown = document.querySelector('[data-testid="Dropdown"], [data-testid="sheetDialog"]');
        if (!dropdown) return false;

        const want = actionType.toLowerCase();

        const direct = Array.from(dropdown.children).find(child => {
            const txt = child.textContent.trim().toLowerCase();
            return txt === want || txt.startsWith(want + ' @');
        });
        if (direct) return direct;

        const candidates = dropdown.querySelectorAll('button, [role="menuitem"], [role="button"], a, div');
        for (const el of candidates) {
            const txt = (el.textContent || '').trim().toLowerCase();
            if (!txt) continue;
            if (txt === want || txt.startsWith(want + ' @')) return el;
        }

        return false;
    }

    function clickUserActionsMenuButton() {
        const ua = document.querySelector('[data-testid="userActions"]');
        if (!ua) return false;

        const primary = ua.firstChild;
        if (primary && typeof primary.click === 'function') {
            primary.click();
            return true;
        }

        const fallback = ua.querySelector('button, [role="button"]');
        if (fallback && typeof fallback.click === 'function') {
            fallback.click();
            return true;
        }

        return false;
    }

    // --- Tightened: only consider right-side action button area via data-testid "*-unblock" ---
    function rowIsAlreadyBlocked(row) {
        try {
            const unblockBtn = row.querySelector('button[data-testid$="-unblock"], [role="button"][data-testid$="-unblock"]');
            return Boolean(unblockBtn);
        } catch (_) {
            return false;
        }
    }

    const getNextPerson = function () {
        const rows = getFollowersRows();

        for (const row of rows) {
            try {
                if (rowIsAlreadyBlocked(row)) continue;

                const accountLink = extractProfileAnchorFromRow(row);
                if (!accountLink) continue;

                const normUrl = normaliseProfileUrl(accountLink.href) || normaliseProfileUrl(accountLink.getAttribute('href'));
                if (!normUrl) continue;

                if (!affectedAccountUrls[normUrl] && !excludedUsers.has(normUrl)) {
                    return accountLink;
                }
            } catch (error) {}
        }
        return false;
    };

    const performActionOnPerson = async function (person, actionType) {
        const normUrl = normaliseProfileUrl(person.href) || normaliseProfileUrl(person.getAttribute('href'));
        if (normUrl) affectedAccountUrls[normUrl] = true;

        person.click();

        while (!document.querySelector('[data-testid="userActions"]')) {
            if (!(await checkpoint())) return false;
            await sleep(10);
        }

        if (!(await checkpoint())) return false;
        clickUserActionsMenuButton();

        while (!document.querySelector('[data-testid="Dropdown"]') && !document.querySelector('[data-testid="sheetDialog"]')) {
            if (!(await checkpoint())) return false;
            await sleep(10);
        }

        if (!(await checkpoint())) return false;

        const button = findButton(actionType);
        if (button) {
            button.click();

            if (actionType === 'Block') {
                await sleep(50);
                while (!document.querySelector('[data-testid="confirmationSheetConfirm"]')) {
                    if (!(await checkpoint())) return false;
                    await sleep(10);
                }
                document.querySelector('[data-testid="confirmationSheetConfirm"]').click();
            }

            await sleep(50);
        }

        if (!(await checkpoint())) return false;

        history.back();

        while (!document.querySelector('[aria-label="Timeline: Verified Followers"]') &&
               !document.querySelector('[aria-label="Timeline: Followers"]')) {
            if (!(await checkpoint())) return false;
            await sleep(10);
        }

        return Boolean(button);
    };

    const scrollToNewPeople = async function () {
        const element = document.querySelector('[data-viewportview="true"]') || document.documentElement;
        let prevScrollTop = element.scrollTop;
        let lastPerformanceTime = performance.now();

        while (!getNextPerson()) {
            if (!(await checkpoint())) return;

            element.scrollTop += 100;

            if (prevScrollTop === element.scrollTop) {
                if (performance.now() - lastPerformanceTime >= 2000) return;
            } else {
                lastPerformanceTime = performance.now();
            }

            prevScrollTop = element.scrollTop;
            await sleep(1);
        }
    };

    const performActionOnPeople = async function (actionType) {
        if (!isFollowersPage()) {
            alert('Open a Followers or Verified Followers list page first.');
            return;
        }
        if (runState.running) {
            showToast('A bulk action is already running. Stop it first (Shift+Escape).');
            return;
        }

        runState.running = true;
        runState.paused = false;
        runState.stopRequested = false;
        runState.actionType = actionType;

        let count = 0;
        affectedAccountUrls = Object.create(null);

        try {
            while (true) {
                if (!(await checkpoint())) break;

                await scrollToNewPeople();

                if (!(await checkpoint())) break;

                const nextPerson = getNextPerson();
                if (nextPerson) {
                    const success = await performActionOnPerson(nextPerson, actionType);
                    if (success) count++;
                } else {
                    break;
                }
            }
        } finally {
            runState.running = false;
            runState.paused = false;
            runState.actionType = null;

            const stopped = runState.stopRequested;
            runState.stopRequested = false;

            if (actionType === 'Mute') {
                alert(`${count} people muted.${stopped ? ' (Stopped)' : ''}`);
            } else if (actionType === 'Block') {
                alert(`${count} people blocked.${stopped ? ' (Stopped)' : ''}`);
            }
        }
    };

    const addMuteBlockContainer = () => {
        if (document.getElementById('mute-block-container')) return;

        ensureStyles();

        const muteBlockContainer = document.createElement('div');
        muteBlockContainer.id = 'mute-block-container';

        const muteButton = document.createElement('button');
        muteButton.id = 'mute-all-button';
        muteButton.textContent = 'Mute All';

        const blockButton = document.createElement('button');
        blockButton.id = 'block-all-button';
        blockButton.textContent = 'Block All';

        muteBlockContainer.appendChild(muteButton);
        muteBlockContainer.appendChild(blockButton);

        const followersRoots = getFollowersRoots();
        const followersSection = followersRoots.length ? followersRoots[0] : null;

        if (followersSection) {
            followersSection.insertBefore(muteBlockContainer, followersSection.firstChild);

            muteButton.addEventListener('click', async () => {
                if (!isFollowersPage()) {
                    alert('Open a Followers or Verified Followers list page first.');
                    return;
                }
                if (window.confirm('Mute all users on this page?')) {
                    await performActionOnPeople('Mute');
                }
            });

            blockButton.addEventListener('click', async () => {
                if (!isFollowersPage()) {
                    alert('Open a Followers or Verified Followers list page first.');
                    return;
                }
                if (window.confirm('Block all users on this page?')) {
                    await performActionOnPeople('Block');
                }
            });
        }
    };

    const addExcludeButtons = () => {
        const rows = getFollowersRows();

        for (const user of rows) {
            const mapped = excludeWrapperByRow.get(user);
            if (mapped && mapped.isConnected && user.contains(mapped)) continue;

            if (!mapped) {
                const existing = user.querySelector('.exclude-button-wrapper');
                if (existing) {
                    excludeWrapperByRow.set(user, existing);
                    continue;
                }
            }

            const profileUrl = extractProfileUrlFromRow(user);
            if (!profileUrl) continue;

            ensureStyles();

            const handle = getHandleFromProfileUrl(profileUrl);

            const buttonWrapper = document.createElement("div");
            buttonWrapper.className = "exclude-button-wrapper";

            const button = document.createElement("button");
            button.className = "exclude-button";

            const isExcluded = excludedUsers.has(profileUrl);
            if (isExcluded) {
                button.textContent = "Include";
                button.classList.add("include");
            } else {
                button.textContent = "Exclude";
                button.classList.add("exclude");
            }

            button.addEventListener("click", (ev) => {
                ev.stopPropagation();
                ev.preventDefault();

                if (excludedUsers.has(profileUrl)) {
                    excludedUsers.delete(profileUrl);
                    button.textContent = "Exclude";
                    button.classList.remove("include");
                    button.classList.add("exclude");
                    persistExcludedUsers();
                    showToast(handle ? `Included @${handle} (will be affected).` : 'Included (will be affected).');
                } else {
                    excludedUsers.add(profileUrl);
                    button.textContent = "Include";
                    button.classList.remove("exclude");
                    button.classList.add("include");
                    persistExcludedUsers();
                    showToast(handle ? `Excluded @${handle} from bulk actions.` : 'Excluded from bulk actions.');
                }
            });

            buttonWrapper.appendChild(button);

            const targetElement = user.querySelector('.css-175oi2r.r-1awozwy.r-18u37iz.r-1wtj0ep');
            if (targetElement && targetElement.children && targetElement.children.length >= 2) {
                targetElement.insertBefore(buttonWrapper, targetElement.children[1]);
            } else {
                user.appendChild(buttonWrapper);
            }

            excludeWrapperByRow.set(user, buttonWrapper);
        }
    };

    const removeMuteBlockContainer = () => {
        const muteBlockContainer = document.getElementById('mute-block-container');
        if (muteBlockContainer) muteBlockContainer.remove();
    };

    let mutationScheduled = false;

    function processDom() {
        const followersRoots = getFollowersRoots();
        const followersSection = followersRoots.length ? followersRoots[0] : null;

        const followingSection = document.querySelector('[aria-label="Timeline: Following"]') ||
                                 document.querySelector('[aria-label="Timeline: Followers you know"]');

        if (followersSection && !followingSection) {
            addMuteBlockContainer();
            addExcludeButtons();
        } else {
            removeMuteBlockContainer();
        }
    }

    function scheduleProcessDom() {
        if (mutationScheduled) return;
        mutationScheduled = true;

        requestAnimationFrame(() => {
            mutationScheduled = false;
            processDom();
        });
    }

    const observer = new MutationObserver(() => {
        scheduleProcessDom();
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
    });

    scheduleProcessDom();

    window.addEventListener('keydown', (e) => {
        if (!runState.running) return;
        if (e.key !== 'Escape') return;

        e.preventDefault();
        e.stopPropagation();

        if (e.shiftKey) requestStop();
        else togglePause();
    }, true);

    GM_registerMenuCommand('Bulk Mute/Block: Pause/Resume', () => togglePause());
    GM_registerMenuCommand('Bulk Mute/Block: Stop', () => requestStop());
})();
