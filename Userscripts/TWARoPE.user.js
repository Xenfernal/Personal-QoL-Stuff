// ==UserScript==
// @name         Twitch Auto Reload on Player Errors (God Mode)
// @namespace    https://github.com/Xenfernal
// @version      1.0
// @icon         https://static.twitchcdn.net/assets/favicon-32-e29e246c157142c94346.png
// @description  Reload Twitch stream if any player error appears. Full feature set: GUI, retry counter, audio, notifications, logs, dark mode, draggable panel, and error history tracking. Improved script made originally by SNOOKEE.
// @author       Xen
// @match        https://www.twitch.tv/*
// @grant        GM_registerMenuCommand
// @license      MIT
// @homepageURL  https://github.com/Xenfernal/Personal-QoL-Stuff/tree/main/Userscripts
// @downloadURL  https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/TWARoPE.user.js
// @updateURL    https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/TWARoPE.user.js
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const SETTINGS_KEY = 'twitchErrorReloadSettings_v5.3';
    const LOGS_KEY = 'twitchErrorLogs_v5.3';

    // Define all Twitch player errors with their codes and messages
    const TWITCH_ERRORS = [
        {
            code: 1000,
            message: "The video download was cancelled. Please try again. (Error #1000)",
            description: "Video Download Cancelled"
        },
        {
            code: 2000,
            message: "There was a network error. Please try again. (Error #2000)",
            description: "Network Error"
        },
        {
            code: 3000,
            message: "Your browser encountered an error while decoding the video. (Error #3000)",
            description: "Video Decoding Error"
        },
        {
            code: 4000,
            message: "This video is either unavailable or not supported in this browser. (Error #4000)",
            description: "Video Unavailable/Unsupported"
        },
        {
            code: 5000,
            message: "This video is unavailable. (Error #5000)",
            description: "Video Unavailable"
        },
        {
            code: 5000,
            message: "5000: Content not available",
            description: "Content Not Available"
        }
    ];

    const DEFAULT_SETTINGS = {
        maxRetries: 5,
        startDelayMs: 5000,
        reloadDelayMs: 2000,
        retryCount: 0,
        darkMode: true,
        enableAudio: true,
        enableNotify: true,
        // Individual error toggles - all enabled by default
        enableError1000: true,
        enableError2000: true,
        enableError3000: true,
        enableError4000: true,
        enableError5000: true
    };

    let settings = loadSettings();
    let logs = loadLogs();

    function loadSettings() {
        const saved = localStorage.getItem(SETTINGS_KEY);
        return saved ? JSON.parse(saved) : { ...DEFAULT_SETTINGS };
    }

    function saveSettings() {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }

    function loadLogs() {
        const saved = localStorage.getItem(LOGS_KEY);
        return saved ? JSON.parse(saved) : [];
    }

    function saveLogs() {
        localStorage.setItem(LOGS_KEY, JSON.stringify(logs));
    }

    function logEvent(msg) {
        const time = new Date().toLocaleTimeString();
        const entry = `[${time}] ${msg}`;
        logs.push(entry);
        if (logs.length > 50) logs.shift(); // Keep last 50
        saveLogs();
        updateLogPanel();
    }

    function playAlertSound() {
        if (!settings.enableAudio) return;
        const beep = new Audio("https://notificationsounds.com/storage/sounds/file-sounds-1153-pristine.mp3");
        beep.volume = 0.5;
        beep.play().catch(e => console.log('Audio play failed:', e));
    }

    function showToast(message, success = true) {
        if (!settings.enableNotify) return;
        const toast = document.createElement('div');
        toast.innerText = message;
        toast.style.position = 'fixed';
        toast.style.bottom = '20px';
        toast.style.left = '50%';
        toast.style.transform = 'translateX(-50%)';
        toast.style.background = success ? '#28a745' : '#dc3545';
        toast.style.color = 'white';
        toast.style.padding = '10px 16px';
        toast.style.borderRadius = '5px';
        toast.style.zIndex = 9999;
        toast.style.boxShadow = '0 4px 10px rgba(0,0,0,0.3)';
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);
    }

    function updateLogPanel() {
        const panel = document.getElementById('log-panel');
        if (panel) {
            panel.innerHTML = '<strong>📜 Error History:</strong><br>' + logs.slice().reverse().map(l => `<div style='margin:2px 0'>${l}</div>`).join('');
        }
    }

    // Global function to toggle UI visibility
    function toggleUI() {
        const panel = document.getElementById('twitch-reload-ui');
        if (panel) {
            // Toggle visibility
            const isCurrentlyVisible = panel.style.display !== 'none';
            panel.style.display = isCurrentlyVisible ? 'none' : 'block';
            showToast(`Control Panel ${isCurrentlyVisible ? 'hidden' : 'shown'}`, true);
        } else {
            // Create UI if it doesn't exist
            createUI();
            showToast('Control Panel shown', true);
        }
    }

    function createUI() {
        // Check if UI already exists to avoid duplicates
        if (document.getElementById('twitch-reload-ui')) return;

        const container = document.createElement('div');
        container.id = 'twitch-reload-ui';
        container.style.position = 'fixed';
        container.style.top = '20px';
        container.style.right = '20px';
        container.style.zIndex = '9999';
        container.style.padding = '10px';
        container.style.borderRadius = '8px';
        container.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)';
        container.style.fontFamily = 'Arial, sans-serif';
        container.style.width = '320px';
        container.style.maxWidth = '90vw';
        container.style.cursor = 'move';
        applyTheme(container);

        let offsetX = 0, offsetY = 0, isDragging = false;

        container.addEventListener('mousedown', function(e) {
            isDragging = true;
            offsetX = e.clientX - container.getBoundingClientRect().left;
            offsetY = e.clientY - container.getBoundingClientRect().top;
        });
        document.addEventListener('mouseup', () => isDragging = false);
        document.addEventListener('mousemove', function(e) {
            if (isDragging) {
                container.style.left = (e.clientX - offsetX) + 'px';
                container.style.top = (e.clientY - offsetY) + 'px';
                container.style.right = 'auto';
            }
        });

        const title = document.createElement('div');
        title.innerText = '⚙️ Twitch Auto Reload';
        title.style.fontWeight = 'bold';
        title.style.marginBottom = '10px';

        const counter = document.createElement('div');
        counter.id = 'retry-counter';
        counter.innerText = `Retries: ${settings.retryCount}/${settings.maxRetries}`;
        counter.style.marginBottom = '10px';

        function createSetting(labelText, type, settingKey, extra = {}) {
            const wrapper = document.createElement('div');
            wrapper.style.margin = '5px 0';

            const label = document.createElement('label');
            label.innerText = labelText;
            label.style.display = 'block';
            label.style.marginBottom = '2px';

            let input;
            if (type === 'checkbox') {
                input = document.createElement('input');
                input.type = 'checkbox';
                input.checked = settings[settingKey];
                input.onchange = () => {
                    settings[settingKey] = input.checked;
                    saveSettings();
                    if (settingKey === 'darkMode') applyTheme(container);
                };
            } else {
                input = document.createElement('input');
                input.type = 'number';
                input.value = settings[settingKey];
                input.min = extra.min || 0;
                input.style.width = '100%';
                input.onchange = () => {
                    settings[settingKey] = parseInt(input.value);
                    saveSettings();
                    updateRetryDisplay();
                };
            }

            wrapper.appendChild(label);
            wrapper.appendChild(input);
            return wrapper;
        }

        // Create error-specific toggles
        const errorToggles = document.createElement('div');
        errorToggles.style.marginTop = '10px';
        errorToggles.style.paddingTop = '10px';
        errorToggles.style.borderTop = '1px solid #555';

        const errorTitle = document.createElement('div');
        errorTitle.innerText = '🛑 Error Detection:';
        errorTitle.style.fontWeight = 'bold';
        errorTitle.style.marginBottom = '5px';
        errorToggles.appendChild(errorTitle);

        // Add toggle for each error type
        errorToggles.appendChild(createSetting('Error #1000 (Video Download)', 'checkbox', 'enableError1000'));
        errorToggles.appendChild(createSetting('Error #2000 (Network)', 'checkbox', 'enableError2000'));
        errorToggles.appendChild(createSetting('Error #3000 (Decoding)', 'checkbox', 'enableError3000'));
        errorToggles.appendChild(createSetting('Error #4000 (Unsupported)', 'checkbox', 'enableError4000'));
        errorToggles.appendChild(createSetting('Error #5000 (Unavailable)', 'checkbox', 'enableError5000'));

        const retryBtn = document.createElement('button');
        retryBtn.innerText = '🔁 Retry Now';
        retryBtn.onclick = () => {
            showToast('Manual Reload', true);
            logEvent('Manual reload triggered.');
            location.reload();
        };

        const closeBtn = document.createElement('button');
        closeBtn.innerText = '❌ Close Panel';
        closeBtn.onclick = () => {
            container.style.display = 'none';
            showToast('Control Panel hidden', true);
        };
        closeBtn.style.marginTop = '5px';

        const logPanel = document.createElement('div');
        logPanel.id = 'log-panel';
        logPanel.style.marginTop = '10px';
        logPanel.style.maxHeight = '120px';
        logPanel.style.overflowY = 'auto';
        logPanel.style.fontSize = '12px';

        container.appendChild(title);
        container.appendChild(counter);
        container.appendChild(createSetting('Max Retries', 'number', 'maxRetries'));
        container.appendChild(createSetting('Start Delay (ms)', 'number', 'startDelayMs'));
        container.appendChild(createSetting('Reload Delay (ms)', 'number', 'reloadDelayMs'));
        container.appendChild(createSetting('Enable Audio', 'checkbox', 'enableAudio'));
        container.appendChild(createSetting('Enable Notify', 'checkbox', 'enableNotify'));
        container.appendChild(createSetting('Dark Mode', 'checkbox', 'darkMode'));
        container.appendChild(errorToggles);
        container.appendChild(retryBtn);
        container.appendChild(closeBtn);
        container.appendChild(logPanel);
        document.body.appendChild(container);
        updateLogPanel();
    }

    function applyTheme(container) {
        const isDark = settings.darkMode;
        container.style.backgroundColor = isDark ? '#1f1f23' : '#f4f4f4';
        container.style.color = isDark ? '#f4f4f4' : '#1f1f23';

        const inputs = container.querySelectorAll('input');
        inputs.forEach(input => {
            input.style.backgroundColor = isDark ? '#333' : '#fff';
            input.style.color = isDark ? '#f4f4f4' : '#1f1f23';
        });
        const buttons = container.querySelectorAll('button');
        buttons.forEach(btn => {
            btn.style.width = '100%';
            btn.style.padding = '8px';
            btn.style.marginTop = '10px';
            btn.style.backgroundColor = isDark ? '#9147ff' : '#e6e6e6';
            btn.style.color = isDark ? 'white' : 'black';
            btn.style.border = 'none';
            btn.style.borderRadius = '5px';
            btn.style.cursor = 'pointer';
        });
    }

    function updateRetryDisplay() {
        const counter = document.getElementById('retry-counter');
        if (counter) counter.innerText = `Retries: ${settings.retryCount}/${settings.maxRetries}`;
    }

    function detectPlayerError() {
        const bodyText = document.body.innerText;

        for (const error of TWITCH_ERRORS) {
            // Check if this error type is enabled and if the message is found
            const errorEnabled = settings[`enableError${error.code}`];
            if (errorEnabled && bodyText.includes(error.message)) {
                return error;
            }
        }
        return null;
    }

    function observeError() {
        const observer = new MutationObserver(() => {
            const detectedError = detectPlayerError();
            if (detectedError) {
                if (settings.retryCount < settings.maxRetries) {
                    settings.retryCount++;
                    saveSettings();
                    updateRetryDisplay();
                    playAlertSound();
                    showToast(`Reloading due to ${detectedError.description}...`, true);
                    logEvent(`Auto reload: ${detectedError.description} (Error #${detectedError.code})`);
                    setTimeout(() => location.reload(), settings.reloadDelayMs);
                } else {
                    showToast('Retry limit reached. Not reloading.', false);
                    logEvent(`Retry limit reached for ${detectedError.description}. No reload.`);
                }
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });

        logEvent(`Observer started. Monitoring ${TWITCH_ERRORS.length} error types.`);
    }

    // Tampermonkey menu command to toggle the UI
    GM_registerMenuCommand("Toggle Twitch Reload Panel", toggleUI);

    // Toggle UI with F2 key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'F2') {
            toggleUI();
        }
    });

    // Initialize observer on page load without creating UI
    window.addEventListener('load', () => {
        setTimeout(() => {
            observeError();
        }, settings.startDelayMs);
    });
})();
