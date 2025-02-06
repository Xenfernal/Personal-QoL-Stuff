// ==UserScript==
// @name         Mute/Block Followers semi-automatically.
// @namespace    https://github.com/Xenfernal
// @version      0.0.2
// @description  Adds buttons on X.com to mute/block all followers when you click it on the Followers page on a profile.
// @author       Xen
// @icon         https://www.google.com/s2/favicons?sz=64&domain=x.com
// @match        https://x.com/*/followers
// @match        https://x.com/*/verified_followers
// @run-at       document-idle
// @grant        none
// @homepageURL  https://github.com/Xenfernal/Personal-QoL-Stuff
// @downloadURL  https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/Mute%20or%20Block.user.js
// @updateURL    https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/Mute%20or%20Block.user.js
// ==/UserScript==

/*
Preface: This is for my own personal use but feel free to use it if you want to. I am not a proper programmer or coder so if this script breaks, expect delays for a fix or none at all. 
Most of the code in this userscript is unminified and derived from IsaacKing's javascript code found on outsidetheasylum.blog. Very much appreciated for providing this quality of life 
improvement after recent changes to X.com
How to use: Just click on the mute/block follower button and wait till all the accounts listed are either muted/blocked. Keep the window focused or on foreground as it sometimes fails 
to execute in the background. Also, please refresh the page if you are going to run the mute code after block code or vice versa as these functions are practically executed using the same code.
WARNING! Do not execute the mute/block codes too quickly or X.com will sign you out and probably flag your account for automation resulting in account getting temporary suspensions. 
Give it at least 15-20 minutes intervals after X.com starts rate limiting your account before your next attempt. You will notice this after some accounts and tweets not loading on 
refresh of the page/site if you are not already paying attention to the console errors while running this.
*/

(function () {
    'use strict';

    const affectedAccountUrls = {};

    const getNextPerson = function () {
        let elements = Array.from(document.querySelectorAll('[aria-label="Timeline: Followers"] > div > div'));
        for (let el of elements) {
            try {
                let link = el.firstChild.firstChild.firstChild.firstChild.children[1].firstChild.firstChild.firstChild.firstChild.firstChild;
                if (link.href && !affectedAccountUrls[link.href]) return link;
            } catch (e) {}
        }
        return false;
    };

    const findButton = function (action) {
        let menu = document.querySelector('[data-testid="Dropdown"]') || document.querySelector('[data-testid="sheetDialog"]');
        if (!menu) return false;

        let options = Array.from(menu.children);
        for (let option of options) {
            if (option.children[1].firstChild.firstChild.textContent.startsWith(action + " @")) {
                return option;
            }
        }
        console.log("Could not find " + action.toLowerCase() + " button");
        return false;
    };

    const performActionOnPerson = async function (person, action) {
        affectedAccountUrls[person.href] = true;
        person.click();

        while (!document.querySelector('[data-testid="userActions"]')) await sleep(10);
        document.querySelector('[data-testid="userActions"]').firstChild.click();

        while (!document.querySelector('[data-testid="Dropdown"]') && !document.querySelector('[data-testid="sheetDialog"]')) await sleep(10);

        let button = findButton(action);
        if (button) {
            button.click();
            if (action === "Block") {
                await sleep(50);
                document.querySelector('[data-testid="confirmationSheetConfirm"]').click();
            }
            await sleep(50);
        }

        history.back();

        while (!document.querySelector('[aria-label="Timeline: Followers"]')) await sleep(10);
        return Boolean(button);
    };

    const scrollToNewPeople = async function () {
        let viewport = document.querySelector("[data-viewportview=true]") || document.documentElement;
        let lastScroll = viewport.scrollTop;
        let startTime = performance.now();

        while (!getNextPerson()) {
            viewport.scrollTop += 100;
            if (lastScroll === viewport.scrollTop) {
                if (performance.now() - startTime >= 2000) return;
            } else {
                startTime = performance.now();
            }
            lastScroll = viewport.scrollTop;
            await sleep(1);
        }
    };

    const performActionOnPeople = async function (action) {
        let count = 0;
        while (true) {
            console.log(`Starting ${action.toLowerCase()} script`);
            await scrollToNewPeople();
            console.log("Scrolled");

            let person = getNextPerson();
            if (person) {
                let success = await performActionOnPerson(person, action);
                console.log(`Successfully performed ${action.toLowerCase()}`);
                if (success) count++;
            } else {
                alert(`${count} people ${action.toLowerCase()}ed.`);
                return;
            }
        }
    };

    const sleep = async function (ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    };

    function addControlButtons() {
        let mainSection = document.querySelector('#react-root > div > div > div.css-175oi2r.r-1f2l425.r-13qz1uu.r-417010.r-18u37iz > main > div > div > div > div > div > section');
        if (!mainSection || document.getElementById('muteFollowersButton') || document.getElementById('blockFollowersButton')) return;

        let buttonContainer = document.createElement('div');
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'center';
        buttonContainer.style.gap = '10px';
        buttonContainer.style.margin = '10px auto';

        let muteButton = document.createElement('button');
        muteButton.id = 'muteFollowersButton';
        muteButton.innerText = 'Mute Followers';
        muteButton.style.padding = '10px 15px';
        muteButton.style.backgroundColor = '#0000FF';
        muteButton.style.color = '#000'; // Black text color
        muteButton.style.border = 'none';
        muteButton.style.borderRadius = '5px';
        muteButton.style.cursor = 'pointer';
        muteButton.style.fontSize = '14px';
        muteButton.style.fontWeight = 'bold';

        muteButton.addEventListener('click', () => {
            if (confirm('Are you sure you want to mute all followers?')) {
                performActionOnPeople('Mute');
            }
        });

        let blockButton = document.createElement('button');
        blockButton.id = 'blockFollowersButton';
        blockButton.innerText = 'Block Followers';
        blockButton.style.padding = '10px 15px';
        blockButton.style.backgroundColor = '#DC1E29';
        blockButton.style.color = '#FFFFFF'; // White text color
        blockButton.style.border = 'none';
        blockButton.style.borderRadius = '5px';
        blockButton.style.cursor = 'pointer';
        blockButton.style.fontSize = '14px';
        blockButton.style.fontWeight = 'bold';

        blockButton.addEventListener('click', () => {
            if (confirm('Are you sure you want to block all followers? This action is irreversible!')) {
                performActionOnPeople('Block');
            }
        });

        // Append buttons to container
        buttonContainer.appendChild(muteButton);
        buttonContainer.appendChild(blockButton);

        mainSection.parentNode.insertBefore(buttonContainer, mainSection);
    }

    const observer = new MutationObserver(addControlButtons);
    observer.observe(document.body, { childList: true, subtree: true });
})();
