// ==UserScript==
// @name        Hide Watched YouTube Videos
// @namespace   https://github.com/Xenfernal
// @version     0.0.3
// @description Hide watched videos marked by "Mark Watched YouTube Videos" userscript by jcunews. Toggle with Alt+H or via Userscript manager menu.
// @author      Xen
// @match       https://www.youtube.com/*
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_registerMenuCommand
// @homepageURL https://github.com/Xenfernal/Personal-QoL-Stuff/tree/main/Userscripts
// @downloadURL https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/HWYTV.user.js
// @updateURL   https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/HWYTV.user.js
// @license     MIT
// @run-at      document-start
// ==/UserScript==

(function() {
    'use strict';

    // Configuration
    const CONFIG = {
        storageKey: 'HideWatchedVideos_Enabled',
        hideClass: 'mwyv-hide-watched',
        observerDebounce: 100,
        mutationObserverConfig: {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class']
        }
    };

    // State management
    let isEnabled = GM_getValue(CONFIG.storageKey, true);
    let observer = null;
    let processTimeout = null;
    let mastheadObserver = null;

    // CSS for hiding watched videos
    const hideStyles = `
        .watched.${CONFIG.hideClass} {
            display: none !important;
        }

        /* Visual indicator when hiding is active - placed in masthead */
        .mwyv-hiding-active-indicator {
            display: inline-flex;
            align-items: center;
            background: #ff4444;
            color: white;
            padding: 4px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 500;
            margin: 0 8px;
            white-space: nowrap;
            height: 24px;
        }

        /* Hide in fullscreen */
        .html5-video-player:fullscreen .mwyv-hiding-active-indicator,
        .html5-video-player:-webkit-full-screen .mwyv-hiding-active-indicator,
        .html5-video-player:-moz-full-screen .mwyv-hiding-active-indicator {
            display: none !important;
        }
    `;

    // Initialize the script
    function init() {
        injectStyles();
        setupMutationObserver();
        setupKeyboardShortcut();
        registerMenuCommands();
        setupMastheadObserver();
        updateVisibilityState();

        // Initial processing
        processWatchedVideos();

        console.log('Hide Watched YouTube Videos initialized:', isEnabled);
    }

    // Inject CSS styles
    function injectStyles() {
        if (document.getElementById('mwyv-hide-styles')) return;

        const style = document.createElement('style');
        style.id = 'mwyv-hide-styles';
        style.textContent = hideStyles;
        document.head.appendChild(style);
    }

    // Setup observer for masthead to ensure indicator placement
    function setupMastheadObserver() {
        mastheadObserver = new MutationObserver((mutations) => {
            // If we have enabled hiding but no indicator, try to place it
            if (isEnabled && !document.querySelector('.mwyv-hiding-active-indicator')) {
                updateVisibilityState();
            }
        });

        const masthead = document.querySelector('#masthead');
        if (masthead) {
            mastheadObserver.observe(masthead, {
                childList: true,
                subtree: true
            });
        }
    }

    // Find the target position between microphone and create buttons
    function findIndicatorPosition() {
        // Try to find the end buttons container
        const endContainer = document.querySelector('#end #buttons, ytd-masthead #end, #end');
        if (!endContainer) return null;

        // Find microphone and create buttons
        const buttons = endContainer.children;
        let microphoneIndex = -1;
        let createIndex = -1;

        for (let i = 0; i < buttons.length; i++) {
            const button = buttons[i];
            // Look for microphone button (voice search)
            if (button.querySelector('ytd-button-renderer, button[aria-label*="microphone"], button[aria-label*="voice"]')) {
                microphoneIndex = i;
            }
            // Look for create button (upload/camera)
            if (button.querySelector('ytd-button-renderer, button[aria-label*="create"], button[aria-label*="upload"], ytd-topbar-menu-button-renderer')) {
                createIndex = i;
                break; // Stop after finding create button
            }
        }

        // Place between microphone and create buttons
        if (microphoneIndex !== -1 && createIndex !== -1 && createIndex > microphoneIndex) {
            return {
                parent: endContainer,
                insertAfter: buttons[microphoneIndex]
            };
        }

        // Fallback: insert at beginning of end container
        return {
            parent: endContainer,
            insertAfter: null
        };
    }

    // Toggle hiding functionality
    function toggleHiding() {
        isEnabled = !isEnabled;
        GM_setValue(CONFIG.storageKey, isEnabled);

        updateVisibilityState();
        processWatchedVideos();

        showNotification(isEnabled ? 'Hiding watched videos' : 'Showing watched videos');
    }

    // Update visibility state and UI indicators
    function updateVisibilityState() {
        // Remove existing indicator
        const existingIndicator = document.querySelector('.mwyv-hiding-active-indicator');
        if (existingIndicator) {
            existingIndicator.remove();
        }

        // Add indicator if hiding is enabled
        if (isEnabled) {
            const position = findIndicatorPosition();
            if (position) {
                const indicator = document.createElement('div');
                indicator.className = 'mwyv-hiding-active-indicator';
                indicator.textContent = 'Hiding Watched Videos';

                if (position.insertAfter) {
                    position.insertAfter.parentNode.insertBefore(indicator, position.insertAfter.nextSibling);
                } else {
                    position.parent.insertBefore(indicator, position.parent.firstChild);
                }
            } else {
                // Fallback: try again after a short delay if masthead isn't ready
                setTimeout(updateVisibilityState, 500);
            }
        }
    }

    // Process watched videos and apply hiding
    function processWatchedVideos() {
        if (!isEnabled) {
            // Remove hide class from all elements
            document.querySelectorAll(`.${CONFIG.hideClass}`).forEach(element => {
                element.classList.remove(CONFIG.hideClass);
            });
            return;
        }

        // Find all watched video elements and hide them
        const watchedElements = document.querySelectorAll('.watched');

        watchedElements.forEach(element => {
            // Only hide if it's a video container, not internal elements
            if (isVideoContainer(element)) {
                element.classList.add(CONFIG.hideClass);
            }
        });

        // Clean up any empty sections that might result from hiding videos
        cleanupEmptySections();
    }

    // Check if element is a video container (not a child element)
    function isVideoContainer(element) {
        // Common video container selectors across YouTube
        const videoContainerSelectors = [
            'ytd-rich-item-renderer',
            'ytd-video-renderer',
            'ytd-grid-video-renderer',
            'ytd-compact-video-renderer',
            'ytd-playlist-video-renderer',
            '.yt-shelf-grid-item',
            '.yt-uix-shelfslider-list > *',
            '.ytd-rich-grid-renderer > *',
            '.multirow-shelf > .shelf-content > *'
        ];

        return videoContainerSelectors.some(selector =>
            element.matches && element.matches(selector)
        ) || element.classList.contains('watched');
    }

    // Clean up empty sections after hiding videos
    function cleanupEmptySections() {
        const sections = document.querySelectorAll([
            'ytd-item-section-renderer',
            '.ytd-section-list-renderer',
            '.shelf-content'
        ].join(','));

        sections.forEach(section => {
            // Check if section only contains hidden elements or is empty
            const visibleChildren = section.querySelectorAll(':scope > *:not(.mwyv-hide-watched)');
            if (visibleChildren.length === 0) {
                section.style.display = 'none';
            } else {
                section.style.display = '';
            }
        });
    }

    // Setup MutationObserver to handle dynamic content
    function setupMutationObserver() {
        observer = new MutationObserver((mutations) => {
            // Debounce processing to avoid excessive DOM operations
            clearTimeout(processTimeout);
            processTimeout = setTimeout(() => {
                if (isEnabled) {
                    processWatchedVideos();
                }
            }, CONFIG.observerDebounce);
        });

        // Start observing when DOM is ready
        if (document.body) {
            startObserving();
        } else {
            document.addEventListener('DOMContentLoaded', startObserving);
        }
    }

    function startObserving() {
        const observeTarget = document.querySelector('#contents') || document.body;
        if (observeTarget) {
            observer.observe(observeTarget, CONFIG.mutationObserverConfig);
        }

        // Also observe specific YouTube containers that load content dynamically
        const additionalTargets = [
            '#primary',
            '#secondary',
            '#items',
            '.ytd-rich-grid-renderer'
        ];

        additionalTargets.forEach(selector => {
            const target = document.querySelector(selector);
            if (target) {
                observer.observe(target, CONFIG.mutationObserverConfig);
            }
        });
    }

    // Keyboard shortcut (Alt+H)
    function setupKeyboardShortcut() {
        document.addEventListener('keydown', (event) => {
            if (event.altKey && event.key === 'h') {
                event.preventDefault();
                event.stopPropagation();
                toggleHiding();
            }
        }, true);
    }

    // Register userscript manager menu commands
    function registerMenuCommands() {
        // Single toggle command with consistent name
        GM_registerMenuCommand('Toggle Hide Watched Videos', toggleHiding);

        // Additional info command
        GM_registerMenuCommand('Hide Watched Videos Info', showInfo);
    }

    // Show notification
    function showNotification(message) {
        // Remove existing notification
        const existingNotification = document.querySelector('.mwyv-notification');
        if (existingNotification) {
            existingNotification.remove();
        }

        const notification = document.createElement('div');
        notification.className = 'mwyv-notification';
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 50px;
            right: 10px;
            background: #333;
            color: white;
            padding: 10px 15px;
            border-radius: 5px;
            font-size: 14px;
            z-index: 10000;
            opacity: 0.9;
            transition: opacity 0.3s;
        `;

        document.body.appendChild(notification);

        // Auto-remove after 2 seconds
        setTimeout(() => {
            notification.style.opacity = '0';
            setTimeout(() => notification.remove(), 300);
        }, 2000);
    }

    // Show info dialog
    function showInfo() {
        const infoMessage = `
Hide Watched YouTube Videos

Status: ${isEnabled ? 'Enabled' : 'Disabled'}
Shortcut: Alt+H to toggle
Menu: Use "Toggle Hide Watched Videos" command to toggle

This script works with "Mark Watched YouTube Videos" to hide videos that have been marked as watched.

Features:
• Toggle hiding with Alt+H
• Persistent settings
• Works with dynamic content
• Automatic cleanup of empty sections
• Indicator in masthead when active
        `.trim();

        alert(infoMessage);
    }

    // Handle YouTube's navigation (SPA)
    function setupNavigationHandler() {
        let currentUrl = location.href;

        const checkNavigation = () => {
            if (location.href !== currentUrl) {
                currentUrl = location.href;
                // Small delay to let the page settle
                setTimeout(() => {
                    if (isEnabled) {
                        processWatchedVideos();
                    }
                    // Re-setup masthead observer after navigation
                    setupMastheadObserver();
                    updateVisibilityState();
                }, 500);
            }
        };

        // Check for URL changes
        setInterval(checkNavigation, 1000);
    }

    // Initialize when page is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Setup navigation handler for SPA
    setupNavigationHandler();

})();
