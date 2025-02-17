// ==UserScript==
// @name         Mute/Block X followers automatically
// @namespace    https://github.com/Xenfernal
// @version      1.2
// @description  Mute/Block users automatically found on follower pages/lists with an exclude feature.
// @author       Xen
// @match        https://x.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=x.com
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @homepageURL  https://github.com/Xenfernal/Personal-QoL-Stuff/tree/main/Userscripts
// @downloadURL  https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/XMB.user.js
// @updateURL    https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/XMB.user.js
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    let affectedAccountUrls = {}; // Stores muted or blocked users
    const excludedUsers = new Set(JSON.parse(GM_getValue("excludedUsers", "[]")));

    const getNextPerson = function () {
        const elements = Array.from(
            document.querySelectorAll('[aria-label="Timeline: Verified Followers"] > div > div')
        ).concat(
            Array.from(document.querySelectorAll('[aria-label="Timeline: Followers"] > div > div'))
        );

        for (const element of elements) {
            try {
                const accountLink = element.firstChild.firstChild.firstChild.firstChild.children[1]
                .firstChild.firstChild.firstChild.firstChild.firstChild;
                if (accountLink.href && !affectedAccountUrls[accountLink.href] && !excludedUsers.has(accountLink.href)) {
                    return accountLink;
                }
            } catch (error) {}
        }
        return false;
    };

    const findButton = function (username) {
        const dropdown = document.querySelector('[data-testid="Dropdown"]') || document.querySelector('[data-testid="sheetDialog"]');
        const children = Array.from(dropdown.children);

        for (const child of children) {
            if (child.children[1].firstChild.firstChild.textContent.startsWith(username + ' @')) {
                return child;
            }
        }
        console.log(`Could not find ${username.toLowerCase()} button`);
        return false;
    };

    const performActionOnPerson = async function (person, actionType) {
        affectedAccountUrls[person.href] = true;
        person.click();

        while (!document.querySelector('[data-testid="userActions"]')) {
            await sleep(10);
        }
        document.querySelector('[data-testid="userActions"]').firstChild.click();

        while (!document.querySelector('[data-testid="Dropdown"]') && !document.querySelector('[data-testid="sheetDialog"]')) {
            await sleep(10);
        }

        const button = findButton(actionType);
        if (button) {
            button.click();
            if (actionType === 'Block') {
                await sleep(50);
                document.querySelector('[data-testid="confirmationSheetConfirm"]').click();
            }
            await sleep(50);
        }
        history.back();

        while (!document.querySelector('[aria-label="Timeline: Verified Followers"]') &&
               !document.querySelector('[aria-label="Timeline: Followers"]')) {
            await sleep(10);
        }
        return Boolean(button);
    };

    const scrollToNewPeople = async function () {
        const element = document.querySelector('[data-viewportview="true"]') || document.documentElement;
        let prevScrollTop = element.scrollTop;
        let lastPerformanceTime = performance.now();

        while (!getNextPerson()) {
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
        let count = 0;
        affectedAccountUrls = {}; // Reset the list for restart functionality

        while (true) {
            console.log('Starting script');
            await scrollToNewPeople();
            console.log('Scrolled');

            const nextPerson = getNextPerson();
            if (nextPerson) {
                const success = await performActionOnPerson(nextPerson, actionType);
                console.log('Successfully performed action');
                if (success) {
                    count++;
                }
            } else {
                if (actionType === 'Mute') {
                    alert(`${count} people muted.`);
                } else if (actionType === 'Block') {
                    alert(`${count} people blocked.`);
                }
                return;
            }
        }
    };

    const sleep = async function (ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    };

    const addMuteBlockContainer = () => {
        if (document.getElementById('mute-block-container')) return;

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

        const followersSection = document.querySelector('[aria-label="Timeline: Verified Followers"]') || document.querySelector('[aria-label="Timeline: Followers"]');
        if (followersSection) {
            followersSection.insertBefore(muteBlockContainer, followersSection.firstChild);

            muteButton.addEventListener('click', async () => {
                if (window.confirm('Mute all users on this page?')) {
                    await performActionOnPeople('Mute');
                }
            });

            blockButton.addEventListener('click', async () => {
                if (window.confirm('Block all users on this page?')) {
                    await performActionOnPeople('Block');
                }
            });

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

    .exclude-button.include {
        background-color: #2c2c2c;
    }

    .exclude-button.include:hover {
        background-color: #444;
    }

    .exclude-button.include:active {
        background-color: #1a1a1a;
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
`);
        }
    };

    const addExcludeButtons = () => {
        const users = document.querySelectorAll('[aria-label="Timeline: Verified Followers"] > div > div, [aria-label="Timeline: Followers"] > div > div');

        users.forEach(user => {
            if (!user.querySelector(".exclude-button-wrapper")) {
                const accountLink = user.querySelector("a");
                const buttonWrapper = document.createElement("div");
                buttonWrapper.className = "exclude-button-wrapper";

                const button = document.createElement("button");
                button.className = "exclude-button";
                button.textContent = excludedUsers.has(accountLink.href) ? "Exclude" : "Include";

                // Update button text and background color based on the exclusion state
                button.classList.add(excludedUsers.has(accountLink.href) ? "exclude" : "include");

                button.addEventListener("click", () => {
                    if (excludedUsers.has(accountLink.href)) {
                        excludedUsers.delete(accountLink.href);
                        button.textContent = "Include";
                        button.classList.remove("exclude");
                        button.classList.add("include");
                    } else {
                        excludedUsers.add(accountLink.href);
                        button.textContent = "Exclude";
                        button.classList.remove("include");
                        button.classList.add("exclude");
                    }
                    GM_setValue("excludedUsers", JSON.stringify([...excludedUsers]));
                });

                buttonWrapper.appendChild(button);

                // Insert the button next to the user
                const targetElement = user.querySelector('.css-175oi2r.r-1awozwy.r-18u37iz.r-1wtj0ep');
                if (targetElement) {
                    targetElement.insertBefore(buttonWrapper, targetElement.children[1]);
                }
            }
        });
    };

    const removeMuteBlockContainer = () => {
        const muteBlockContainer = document.getElementById('mute-block-container');
        if (muteBlockContainer) {
            muteBlockContainer.remove();
        }
    };

    const observer = new MutationObserver(() => {
        const followersSection = document.querySelector('[aria-label="Timeline: Verified Followers"]') || document.querySelector('[aria-label="Timeline: Followers"]');
        const followingSection = document.querySelector('[aria-label="Timeline: Following"]') || document.querySelector('[aria-label="Timeline: Followers you know"]');

        if (followersSection && !followingSection) {
            addMuteBlockContainer();
            addExcludeButtons();
        } else {
            removeMuteBlockContainer();
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
    });
})();
