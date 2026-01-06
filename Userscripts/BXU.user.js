// ==UserScript==
// @name         Bookmark X Users (Discrete Follow-Mod)
// @namespace    https://github.com/Xenfernal
// @match        https://x.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @version      1.0
// @icon         https://www.google.com/s2/favicons?sz=64&domain=x.com
// @author       Xen
// @description  Bookmark X profiles with notes if wanted. Based on the userscript by minnieo on GreasyFork. This script is improved and better compatible with Tampermonkey.
// @run-at       document-end
// @homepageURL  https://github.com/Xenfernal/Personal-QoL-Stuff/tree/main/Userscripts
// @downloadURL  https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/BXU.user.js
// @updateURL    https://github.com/Xenfernal/Personal-QoL-Stuff/raw/refs/heads/main/Userscripts/BXU.user.js
// @license      MIT
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  /******************************************************************
   * Configuration / constants
   ******************************************************************/
  const STORAGE_KEY = 'User_bookmarks';

  const UI = {
    sidebarBtnId: 'tm-discretefollow-sidebar-btn',
    profileBtnId: 'tm-discretefollow-profile-btn',

    listModalId: 'tm-discretefollow-modal',
    listModalContentId: 'tm-discretefollow-modal-content',

    addModalId: 'tm-discretefollow-add-modal',
    addModalContentId: 'tm-discretefollow-add-modal-content',
    addNotesId: 'tm-discretefollow-add-notes',
    addOkId: 'tm-discretefollow-add-ok',
    addCancelId: 'tm-discretefollow-add-cancel',
  };

  // Inline SVG icons (static)
  const ICONS = {
    // X-like bookmark icon (no explicit width/height; X CSS classes control sizing)
    bookmark: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <g>
          <path d="M4 4.5C4 3.12 5.119 2 6.5 2h11C18.881 2 20 3.12 20 4.5v18.44l-8-5.71-8 5.71V4.5zM6.5 4c-.276 0-.5.22-.5.5v14.56l6-4.29 6 4.29V4.5c0-.28-.224-.5-.5-.5h-11z" fill="currentColor"></path>
        </g>
      </svg>
    `,
    pencil: `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25Z" fill="currentColor"/>
        <path d="M20.71 7.04a1 1 0 0 0 0-1.41L18.37 3.29a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z" fill="currentColor"/>
      </svg>
    `,
    trash: `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M6 7h12l-1 14H7L6 7Z" fill="currentColor"/>
        <path d="M9 4h6l1 2H8l1-2Z" fill="currentColor"/>
      </svg>
    `,
    close: `
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
    `,
  };

  /******************************************************************
   * GM storage helpers (Tampermonkey-first; also supports GM.*)
   ******************************************************************/
  async function gmGet(key, defaultValue) {
    try {
      if (typeof GM !== 'undefined' && typeof GM.getValue === 'function') {
        return await GM.getValue(key, defaultValue);
      }
      if (typeof GM_getValue === 'function') {
        const v = GM_getValue(key, defaultValue);
        return await Promise.resolve(v);
      }
    } catch (e) {
      console.warn('[DiscreteFollow] gmGet failed:', e);
    }
    return defaultValue;
  }

  async function gmSet(key, value) {
    try {
      if (typeof GM !== 'undefined' && typeof GM.setValue === 'function') {
        await GM.setValue(key, value);
        return;
      }
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, value);
        return;
      }
    } catch (e) {
      console.warn('[DiscreteFollow] gmSet failed:', e);
    }
  }

  /******************************************************************
   * Helpers
   ******************************************************************/
  function isVisible(el) {
    return !!(el && (el.offsetParent || el.getClientRects().length));
  }

  function elementFromHtml(html) {
    const t = document.createElement('template');
    t.innerHTML = String(html || '').trim();
    return t.content.firstElementChild;
  }

  /******************************************************************
   * URL canonicalisation (prevents duplicates across params/paths)
   ******************************************************************/
  const RESERVED_FIRST_SEG = new Set([
    'home', 'explore', 'notifications', 'messages', 'i', 'search', 'settings',
    'compose', 'logout', 'login', 'signup', 'account', 'privacy', 'tos', 'terms',
    'help', 'intent'
  ]);

  function isHandleCandidate(seg) {
    if (!seg) return false;
    const s = String(seg);
    if (!/^[a-z0-9_]{1,15}$/i.test(s)) return false;
    if (RESERVED_FIRST_SEG.has(s.toLowerCase())) return false;
    return true;
  }

  function getHandleFromPathname(pathname) {
    const segs = String(pathname || '').split('/').filter(Boolean);
    if (!segs.length) return '';
    const first = segs[0];

    if (!isHandleCandidate(first)) return '';

    // Not a profile if it is /<handle>/status/<id>
    if (segs.length >= 2 && String(segs[1]).toLowerCase() === 'status') return '';

    return String(first).toLowerCase();
  }

  function isLikelyProfilePage() {
    return !!getHandleFromPathname(location.pathname);
  }

  function canonicaliseProfileUrl(url) {
    try {
      const u = new URL(url);

      const host = u.hostname.toLowerCase();
      if (host === 'twitter.com' || host.endsWith('.twitter.com')) u.hostname = 'x.com';
      if (host.endsWith('.x.com')) u.hostname = 'x.com';

      u.search = '';
      u.hash = '';

      const handle = getHandleFromPathname(u.pathname);
      if (handle) u.pathname = `/${handle}`;
      else u.pathname = (u.pathname || '/').replace(/\/+$/, '') || '/';

      return u.toString();
    } catch {
      return String(url || '');
    }
  }

  function canonicalProfileUrlFromLocation() {
    const handle = getHandleFromPathname(location.pathname);
    if (!handle) return '';
    try {
      const u = new URL(location.href);
      u.search = '';
      u.hash = '';
      u.hostname = 'x.com';
      u.pathname = `/${handle}`;
      return u.toString();
    } catch {
      return '';
    }
  }

  /******************************************************************
   * Bookmark normalisation + de-duplication (by canonical link)
   ******************************************************************/
  function sanitiseBookmark(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const linkRaw = (typeof raw.link === 'string' ? raw.link : '').trim();
    const userName = (typeof raw.userName === 'string' ? raw.userName : '').trim();
    const notes = typeof raw.notes === 'string' ? raw.notes : '';
    const addedAt = Number.isFinite(raw.addedAt) ? raw.addedAt : undefined;

    if (!linkRaw || !userName) return null;

    const link = canonicaliseProfileUrl(linkRaw);
    if (!link) return null;

    const cleaned = { link, userName, notes };
    if (addedAt !== undefined) cleaned.addedAt = addedAt;
    return cleaned;
  }

  // De-dupe by canonical link, keeping the last occurrence.
  function dedupeByLink(bookmarks) {
    const m = new Map();
    for (const b of bookmarks) {
      if (!b || !b.link) continue;
      if (m.has(b.link)) m.delete(b.link);
      m.set(b.link, b);
    }
    return Array.from(m.values());
  }

  async function loadBookmarks() {
    const raw = await gmGet(STORAGE_KEY, '[]');

    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = []; }
    if (!Array.isArray(parsed)) parsed = [];

    const cleaned = [];
    let changed = false;

    for (const item of parsed) {
      const c = sanitiseBookmark(item);
      if (!c) { changed = true; continue; }
      cleaned.push(c);

      const itemLink = (item && typeof item.link === 'string') ? item.link : '';
      const itemUser = (item && typeof item.userName === 'string') ? item.userName : '';
      const itemNotes = (item && typeof item.notes === 'string') ? item.notes : '';

      if (canonicaliseProfileUrl(itemLink) !== c.link || itemUser.trim() !== c.userName || itemNotes !== c.notes) {
        changed = true;
      }
    }

    const deduped = dedupeByLink(cleaned);
    if (deduped.length !== cleaned.length) changed = true;

    if (changed) await gmSet(STORAGE_KEY, JSON.stringify(deduped));
    return deduped;
  }

  async function saveBookmarks(bookmarks) {
    const cleaned = Array.isArray(bookmarks)
      ? bookmarks.map(sanitiseBookmark).filter(Boolean)
      : [];
    const deduped = dedupeByLink(cleaned);
    await gmSet(STORAGE_KEY, JSON.stringify(deduped));
  }

  /******************************************************************
   * Styles
   ******************************************************************/
  function addStyles() {
    const css = `
      /* ===== List modal ===== */
      #${UI.listModalId} {
        position: fixed;
        inset: 0;
        display: none;
        justify-content: center;
        align-items: center;
        background: rgba(0,0,0,0.55);
        z-index: 2147483646; /* below add modal */
        font-family: TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      }
      #${UI.listModalId}[data-open="true"] { display: flex; }

      #${UI.listModalContentId} {
        width: min(720px, 92vw);
        max-height: min(70vh, 720px);
        background: #161616;
        border: 1px solid rgba(255,255,255,0.25);
        border-radius: 14px;
        box-shadow: 0 20px 80px rgba(0,0,0,0.65);
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }

      .tm-df-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 14px 10px 14px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
      }

      .tm-df-modal-title {
        display: flex;
        align-items: center;
        gap: 10px;
        color: rgb(231, 233, 234);
        font-size: 16px;
        font-weight: 700;
        line-height: 1.2;
      }
      .tm-df-modal-title svg { display: block; }

      .tm-df-close-btn {
        appearance: none;
        border: 1px solid rgba(255,255,255,0.18);
        background: rgba(0,0,0,0.0);
        color: rgb(231, 233, 234);
        border-radius: 10px;
        padding: 6px 8px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .tm-df-close-btn:hover { border-color: rgba(255,255,255,0.35); }

      .tm-df-list {
        list-style: none;
        padding: 12px 14px 14px 14px;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow: auto;
      }

      .tm-df-item {
        background: #212121;
        border-radius: 12px;
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .tm-df-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }

      .tm-df-link {
        color: rgb(231, 233, 234);
        text-decoration: none;
        font-weight: 700;
        word-break: break-word;
      }
      .tm-df-link:hover { text-decoration: underline; }

      .tm-df-notes {
        color: rgba(231, 233, 234, 0.78);
        font-size: 13px;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .tm-df-actions {
        display: inline-flex;
        gap: 8px;
        flex-shrink: 0;
      }

      .tm-df-action-btn {
        appearance: none;
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(0,0,0,0.0);
        color: rgba(231, 233, 234, 0.92);
        border-radius: 10px;
        padding: 6px 8px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
      }
      .tm-df-action-btn:hover { border-color: rgba(255,255,255,0.30); }
      .tm-df-action-btn[data-variant="edit"] { color: #CF9851; }
      .tm-df-action-btn[data-variant="delete"] { color: #CF5170; }

      .tm-df-empty {
        color: rgba(231, 233, 234, 0.75);
        padding: 18px 14px;
        font-size: 13px;
        background: transparent;
      }

      /* ===== Add modal ===== */
      #${UI.addModalId} {
        position: fixed;
        inset: 0;
        display: none;
        justify-content: center;
        align-items: center;
        background: rgba(0,0,0,0.55);
        z-index: 2147483647; /* above list modal */
        font-family: TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      }
      #${UI.addModalId}[data-open="true"] { display: flex; }

      #${UI.addModalContentId} {
        width: min(520px, 92vw);
        background: #161616;
        border: 1px solid rgba(255,255,255,0.25);
        border-radius: 14px;
        box-shadow: 0 20px 80px rgba(0,0,0,0.65);
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }

      .tm-df-add-body {
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .tm-df-add-meta {
        color: rgba(231, 233, 234, 0.88);
        font-size: 13px;
        line-height: 1.35;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .tm-df-add-notes {
        width: 100%;
        min-height: 110px;
        resize: vertical;
        border-radius: 12px;
        border: 1px solid rgba(255,255,255,0.18);
        background: #0f0f0f;
        color: rgb(231, 233, 234);
        padding: 10px 12px;
        font-size: 13px;
        outline: none;
      }
      .tm-df-add-notes:focus { border-color: rgba(255,255,255,0.35); }

      .tm-df-add-footer {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        padding: 12px 14px 14px 14px;
        border-top: 1px solid rgba(255,255,255,0.08);
      }

      .tm-df-btn {
        appearance: none;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.18);
        background: rgba(0,0,0,0.0);
        color: rgb(231, 233, 234);
        padding: 8px 14px;
        cursor: pointer;
        font-weight: 700;
        font-size: 13px;
      }
      .tm-df-btn:hover { border-color: rgba(255,255,255,0.35); }

      .tm-df-btn-primary {
        background: rgb(239, 243, 244);
        color: rgb(15, 20, 25);
        border-color: rgba(0,0,0,0.0);
      }

      .tm-df-btn[disabled] {
        opacity: 0.7;
        cursor: not-allowed;
      }

      /* ===== Profile button: make whole circle clickable & prevent overlap stealing clicks ===== */
      #${UI.profileBtnId} {
        margin-right: 8px;
        flex: 0 0 auto;
        flex-shrink: 0;
        position: relative;
        z-index: 5;
        pointer-events: auto !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        line-height: 0 !important;
      }

      /* Critical: children must NOT intercept pointer events; click should land on the button */
      #${UI.profileBtnId} * {
        pointer-events: none !important;
      }

      #${UI.profileBtnId} svg { display: block !important; }
    `;

    try {
      if (typeof GM_addStyle === 'function') {
        GM_addStyle(css);
        return;
      }
    } catch (_) {}

    const style = document.createElement('style');
    style.textContent = css;
    document.documentElement.appendChild(style);
  }

  /******************************************************************
   * List Modal UI (safe DOM rendering)
   ******************************************************************/
  function ensureListModal() {
    if (document.getElementById(UI.listModalId)) return;

    const modal = document.createElement('div');
    modal.id = UI.listModalId;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'User Bookmarks');

    const content = document.createElement('div');
    content.id = UI.listModalContentId;

    const header = document.createElement('div');
    header.className = 'tm-df-modal-header';

    const title = document.createElement('div');
    title.className = 'tm-df-modal-title';

    const titleIcon = document.createElement('span');
    titleIcon.innerHTML = ICONS.bookmark;

    const titleText = document.createElement('span');
    titleText.textContent = 'User Bookmarks';

    title.appendChild(titleIcon);
    title.appendChild(titleText);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tm-df-close-btn';
    closeBtn.type = 'button';
    closeBtn.title = 'Close';
    closeBtn.innerHTML = ICONS.close;

    header.appendChild(title);
    header.appendChild(closeBtn);

    const list = document.createElement('ul');
    list.className = 'tm-df-list';
    list.dataset.tmDfList = 'true';

    content.appendChild(header);
    content.appendChild(list);
    modal.appendChild(content);

    closeBtn.addEventListener('click', () => closeListModal());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeListModal();
    });
    content.addEventListener('click', (e) => e.stopPropagation());

    window.addEventListener('keydown', (e) => {
      const isOpen = modal.getAttribute('data-open') === 'true';
      if (isOpen && e.key === 'Escape') closeListModal();
    });

    list.addEventListener('click', async (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('button[data-action]') : null;
      if (!btn) return;

      const action = btn.getAttribute('data-action');
      const index = Number(btn.getAttribute('data-index'));
      if (!Number.isFinite(index)) return;

      if (action === 'edit') await editNotes(index);
      else if (action === 'delete') await deleteBookmark(index);
    });

    document.body.appendChild(modal);
  }

  async function renderListModal() {
    ensureListModal();
    const modal = document.getElementById(UI.listModalId);
    const list = modal.querySelector('ul[data-tm-df-list="true"]');

    while (list.firstChild) list.removeChild(list.firstChild);

    const bookmarks = await loadBookmarks();

    if (!bookmarks.length) {
      const emptyLi = document.createElement('li');
      emptyLi.className = 'tm-df-empty';
      emptyLi.textContent = 'No bookmarks yet. Open a profile and use the bookmark button to add one.';
      list.appendChild(emptyLi);
      return;
    }

    bookmarks.forEach((b, index) => {
      const li = document.createElement('li');
      li.className = 'tm-df-item';

      const row = document.createElement('div');
      row.className = 'tm-df-row';

      const a = document.createElement('a');
      a.className = 'tm-df-link';
      a.href = b.link;
      a.target = '_self';
      a.rel = 'noopener';
      a.textContent = b.userName;

      const actions = document.createElement('div');
      actions.className = 'tm-df-actions';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'tm-df-action-btn';
      editBtn.setAttribute('data-variant', 'edit');
      editBtn.setAttribute('data-action', 'edit');
      editBtn.setAttribute('data-index', String(index));
      editBtn.innerHTML = `${ICONS.pencil}<span>Edit</span>`;

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'tm-df-action-btn';
      delBtn.setAttribute('data-variant', 'delete');
      delBtn.setAttribute('data-action', 'delete');
      delBtn.setAttribute('data-index', String(index));
      delBtn.innerHTML = `${ICONS.trash}<span>Delete</span>`;

      actions.appendChild(editBtn);
      actions.appendChild(delBtn);

      row.appendChild(a);
      row.appendChild(actions);

      li.appendChild(row);

      const notesText = (b.notes || '').trim();
      if (notesText) {
        const notes = document.createElement('div');
        notes.className = 'tm-df-notes';
        notes.textContent = notesText;
        li.appendChild(notes);
      }

      list.appendChild(li);
    });
  }

  function openListModal() {
    ensureListModal();
    const modal = document.getElementById(UI.listModalId);
    modal.setAttribute('data-open', 'true');
    renderListModal().catch(err => console.warn('[DiscreteFollow] renderListModal failed:', err));
  }

  function closeListModal() {
    const modal = document.getElementById(UI.listModalId);
    if (!modal) return;
    modal.setAttribute('data-open', 'false');
  }

  /******************************************************************
   * Add/Update Dialog (OK writes, Cancel does not)
   ******************************************************************/
  function ensureAddModal() {
    if (document.getElementById(UI.addModalId)) return;

    const modal = document.createElement('div');
    modal.id = UI.addModalId;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Add bookmark');

    const content = document.createElement('div');
    content.id = UI.addModalContentId;

    const header = document.createElement('div');
    header.className = 'tm-df-modal-header';

    const title = document.createElement('div');
    title.className = 'tm-df-modal-title';

    const titleIcon = document.createElement('span');
    titleIcon.innerHTML = ICONS.bookmark;

    const titleText = document.createElement('span');
    titleText.textContent = 'Add bookmark';

    title.appendChild(titleIcon);
    title.appendChild(titleText);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tm-df-close-btn';
    closeBtn.type = 'button';
    closeBtn.title = 'Close';
    closeBtn.innerHTML = ICONS.close;

    header.appendChild(title);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'tm-df-add-body';

    const meta = document.createElement('div');
    meta.className = 'tm-df-add-meta';
    meta.dataset.tmDfAddMeta = 'true';

    const textarea = document.createElement('textarea');
    textarea.className = 'tm-df-add-notes';
    textarea.id = UI.addNotesId;
    textarea.placeholder = 'Notes (optional)…';

    body.appendChild(meta);
    body.appendChild(textarea);

    const footer = document.createElement('div');
    footer.className = 'tm-df-add-footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'tm-df-btn';
    cancelBtn.type = 'button';
    cancelBtn.id = UI.addCancelId;
    cancelBtn.textContent = 'Cancel';

    const okBtn = document.createElement('button');
    okBtn.className = 'tm-df-btn tm-df-btn-primary';
    okBtn.type = 'button';
    okBtn.id = UI.addOkId;
    okBtn.textContent = 'OK';

    footer.appendChild(cancelBtn);
    footer.appendChild(okBtn);

    content.appendChild(header);
    content.appendChild(body);
    content.appendChild(footer);
    modal.appendChild(content);

    // Close behaviours (Cancel/Close/X/outside/Esc) — none of these write storage.
    const closeAll = () => closeAddModal();
    closeBtn.addEventListener('click', closeAll);
    cancelBtn.addEventListener('click', closeAll);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeAll();
    });
    content.addEventListener('click', (e) => e.stopPropagation());

    window.addEventListener('keydown', (e) => {
      const isOpen = modal.getAttribute('data-open') === 'true';
      if (isOpen && e.key === 'Escape') closeAll();
    });

    document.body.appendChild(modal);
  }

  function closeAddModal() {
    const modal = document.getElementById(UI.addModalId);
    if (!modal) return;
    modal.setAttribute('data-open', 'false');

    // Clear transient state so a later open is always clean.
    modal.dataset.tmDfLink = '';
    modal.dataset.tmDfUser = '';
    modal.dataset.tmDfMode = '';

    const notes = document.getElementById(UI.addNotesId);
    if (notes) notes.value = '';

    const okBtn = document.getElementById(UI.addOkId);
    if (okBtn) {
      okBtn.disabled = false;
      okBtn.dataset.tmDfSaving = '';
      okBtn.removeAttribute('aria-busy');
    }
  }

  function getProfileDisplayNamePreferUi() {
    const root = document.querySelector('div[data-testid="UserName"]');
    if (!root) return '';

    const text = (root.innerText || '').trim();
    if (!text) return '';

    const firstLine = text.split('\n').map(s => s.trim()).filter(Boolean)[0];
    return firstLine || text;
  }

  function getProfileDisplayNameOrHandleFallback() {
    const uiName = getProfileDisplayNamePreferUi();
    if (uiName) return uiName;

    const handle = getHandleFromPathname(location.pathname);
    if (handle) return `@${handle}`;

    return '';
  }

  async function openAddDialog({ link, userName, existingNotes }) {
    ensureAddModal();

    const modal = document.getElementById(UI.addModalId);
    const meta = modal.querySelector('[data-tm-df-add-meta="true"]');
    const notes = document.getElementById(UI.addNotesId);
    const okBtn = document.getElementById(UI.addOkId);

    const isUpdate = typeof existingNotes === 'string';

    // Store transient state (NOT saved unless OK is pressed).
    modal.dataset.tmDfLink = link;
    modal.dataset.tmDfUser = userName;
    modal.dataset.tmDfMode = isUpdate ? 'update' : 'add';

    // Populate UI
    const titleSpan = modal.querySelector('.tm-df-modal-title span:last-child');
    if (titleSpan) titleSpan.textContent = isUpdate ? 'Update bookmark' : 'Add bookmark';

    meta.textContent = `${userName}\n${link}`;
    notes.value = isUpdate ? existingNotes : '';

    okBtn.disabled = false;
    okBtn.dataset.tmDfSaving = '';
    okBtn.removeAttribute('aria-busy');

    // OK handler: write storage only here.
    okBtn.onclick = async () => {
      if (okBtn.dataset.tmDfSaving === '1') return;
      okBtn.dataset.tmDfSaving = '1';
      okBtn.disabled = true;
      okBtn.setAttribute('aria-busy', 'true');

      try {
        const currentLink = modal.dataset.tmDfLink || '';
        const currentUser = modal.dataset.tmDfUser || '';
        const noteText = notes.value ?? '';

        if (!currentLink || !currentUser) {
          closeAddModal();
          return;
        }

        const bookmarks = await loadBookmarks();
        const idx = bookmarks.findIndex(b => b && b.link === currentLink);

        if (idx !== -1) {
          // Update existing (still "no duplicates")
          bookmarks[idx].userName = currentUser;
          bookmarks[idx].notes = String(noteText);
          if (!Number.isFinite(bookmarks[idx].addedAt)) bookmarks[idx].addedAt = Date.now();
        } else {
          // Add new
          bookmarks.push(sanitiseBookmark({
            link: currentLink,
            userName: currentUser,
            notes: String(noteText),
            addedAt: Date.now(),
          }));
        }

        await saveBookmarks(bookmarks);
        closeAddModal();

        // If list modal is open, refresh it.
        const listModal = document.getElementById(UI.listModalId);
        if (listModal && listModal.getAttribute('data-open') === 'true') {
          await renderListModal();
        }
      } catch (e) {
        console.warn('[DiscreteFollow] save failed:', e);
        okBtn.disabled = false;
        okBtn.dataset.tmDfSaving = '';
        okBtn.removeAttribute('aria-busy');
      }
    };

    // Open & focus textarea
    modal.setAttribute('data-open', 'true');
    setTimeout(() => {
      try { notes.focus(); } catch (_) {}
    }, 0);
  }

  /******************************************************************
   * Bookmark operations used by list modal
   ******************************************************************/
  async function editNotes(index) {
    const bookmarks = await loadBookmarks();
    if (!bookmarks[index]) return;

    const currentNotes = bookmarks[index].notes || '';
    const newNotes = prompt('Edit notes:', currentNotes);
    if (newNotes === null) return;

    bookmarks[index].notes = String(newNotes);
    await saveBookmarks(bookmarks);
    await renderListModal();
  }

  async function deleteBookmark(index) {
    const bookmarks = await loadBookmarks();
    if (!bookmarks[index]) return;

    const ok = confirm(`Delete bookmark for "${bookmarks[index].userName}"?`);
    if (!ok) return;

    bookmarks.splice(index, 1);
    await saveBookmarks(bookmarks);
    await renderListModal();
  }

  /******************************************************************
   * Sidebar injection: insert "User Bookmarks" directly below X Bookmarks
   ******************************************************************/
  function getPrimaryNav() {
    return document.querySelector('nav[aria-label="Primary"]');
  }

  function findXBookmarksNavItem(nav) {
    if (!nav) return null;

    // Primary (your provided element)
    const a1 = nav.querySelector('a[href="/i/bookmarks"][aria-label="Bookmarks"]');
    if (a1) return a1;

    // Fallbacks
    const a2 = nav.querySelector('a[aria-label="Bookmarks"][href*="bookmarks"]');
    if (a2) return a2;

    const visible = Array.from(nav.querySelectorAll('a[aria-label="Bookmarks"]')).find(isVisible);
    return visible || null;
  }

  function setNavItemLabel(anchorEl, labelText) {
    const spans = Array.from(anchorEl.querySelectorAll('span')).filter(s => (s.textContent || '').trim().length);
    if (spans.length) {
      spans[spans.length - 1].textContent = labelText;
      for (const s of anchorEl.querySelectorAll('span')) {
        if ((s.textContent || '') === ' ') s.textContent = '';
      }
      return;
    }
    const ltr = anchorEl.querySelector('[dir="ltr"]');
    if (ltr) ltr.textContent = labelText;
  }

  function ensureSidebarButton() {
    if (document.getElementById(UI.sidebarBtnId)) return;

    const nav = getPrimaryNav();
    if (!nav) return;

    const xBookmarks = findXBookmarksNavItem(nav);

    let item;
    if (xBookmarks) {
      item = xBookmarks.cloneNode(true);
    } else {
      item = document.createElement('a');
      item.className = 'css-175oi2r r-6koalj r-eqz5dr r-16y2uox r-1habvwh r-cnw61z r-13qz1uu r-1ny4l3l r-1loqt21';
      item.innerHTML = `
        <div class="css-175oi2r r-sdzlij r-dnmrzs r-1awozwy r-18u37iz r-1777fci r-xyw6el r-o7ynqc r-6416eg">
          <div class="css-175oi2r">${ICONS.bookmark}</div>
          <div dir="ltr" class="css-146c3p1 r-dnmrzs r-1udh08x r-1udbk01 r-3s2u2q r-bcqeeo r-1ttztb7 r-qvutc0 r-1qd0xha r-adyw6z r-135wba7 r-16dba41 r-dlybji r-nazi8o" style="color: rgb(231, 233, 234);">
            <span class="css-1jxf684 r-bcqeeo r-1ttztb7 r-qvutc0 r-poiln3">User Bookmarks</span>
          </div>
        </div>
      `;
    }

    item.id = UI.sidebarBtnId;
    item.setAttribute('aria-label', 'User Bookmarks');
    item.setAttribute('role', 'link');
    item.href = '#';

    setNavItemLabel(item, 'User Bookmarks');

    item.addEventListener('click', (e) => {
      e.preventDefault();
      openListModal();
    });

    if (xBookmarks && xBookmarks.parentElement) xBookmarks.insertAdjacentElement('afterend', item);
    else nav.appendChild(item);
  }

  /******************************************************************
   * Profile action button insertion: sibling left of "..." More button
   ******************************************************************/
  function findProfileMoreButton() {
    // Prefer: the exact button you supplied
    const byTestId = Array.from(document.querySelectorAll('button[data-testid="userActions"]')).filter(isVisible);
    const bestByTestId = byTestId.find(b => {
      const a = (b.getAttribute('aria-label') || '').toLowerCase();
      const haspopup = (b.getAttribute('aria-haspopup') || '').toLowerCase() === 'menu';
      return a.includes('more') && haspopup;
    });
    if (bestByTestId) return bestByTestId;
    if (byTestId.length) return byTestId[0];

    // Fallback: aria-label/haspopup without testid
    const byAria = Array.from(document.querySelectorAll('button[aria-haspopup="menu"][aria-label]'))
      .filter(isVisible)
      .filter(b => ((b.getAttribute('aria-label') || '').toLowerCase().includes('more')));
    if (byAria.length) return byAria[0];

    // Last resort: role=button
    const byRole = Array.from(document.querySelectorAll('button[role="button"][aria-haspopup="menu"]')).filter(isVisible);
    return byRole[0] || null;
  }

  function syncProfileButtonInner(btn, moreBtn) {
    const inner = moreBtn.firstElementChild;
    if (!inner) {
      btn.innerHTML = ICONS.bookmark;
      return;
    }

    const clone = inner.cloneNode(true);

    const oldSvg = clone.querySelector('svg');
    const newSvg = elementFromHtml(ICONS.bookmark);

    if (newSvg) {
      if (oldSvg) {
        const cls = oldSvg.getAttribute('class');
        const st = oldSvg.getAttribute('style');
        if (cls) newSvg.setAttribute('class', cls);
        if (st) newSvg.setAttribute('style', st);
        oldSvg.replaceWith(newSvg);
      } else {
        clone.insertBefore(newSvg, clone.firstChild);
      }
    }

    // Clear any label spans
    clone.querySelectorAll('span').forEach(s => { s.textContent = ''; });

    while (btn.firstChild) btn.removeChild(btn.firstChild);
    btn.appendChild(clone);
  }

  function ensureProfileButton() {
    if (!isLikelyProfilePage()) return;

    const moreBtn = findProfileMoreButton();
    if (!moreBtn) return;

    const parent = moreBtn.parentElement;
    if (!parent) return;

    let btn = document.getElementById(UI.profileBtnId);

    if (!btn) {
      btn = document.createElement('button');
      btn.id = UI.profileBtnId;
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Bookmark user');
      btn.title = 'Bookmark this user';

      // IMPORTANT: clicking opens dialog only; does not store until OK
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const link = canonicalProfileUrlFromLocation();
        const userName = getProfileDisplayNameOrHandleFallback();

        if (!link || !userName) return;

        const bookmarks = await loadBookmarks();
        const existing = bookmarks.find(b => b && b.link === link);

        await openAddDialog({
          link,
          userName,
          existingNotes: existing ? (existing.notes || '') : undefined
        });
      });
    }

    // Match X’s "More" button styling (classes + inline style)
    btn.className = moreBtn.className || '';
    const moreStyle = moreBtn.getAttribute('style');
    if (moreStyle) btn.setAttribute('style', moreStyle);

    // Inner wrapper structure (helps alignment)
    syncProfileButtonInner(btn, moreBtn);

    // Place immediately left of the "..." button
    const needsMove = btn.parentElement !== parent || btn.nextElementSibling !== moreBtn;
    if (needsMove) parent.insertBefore(btn, moreBtn);
  }

  /******************************************************************
   * SPA resilience: MutationObserver + History hooks
   ******************************************************************/
  let historyPatched = false;

  function installSpaGuards() {
    const schedule = throttleRAF(() => {
      ensureSidebarButton();
      ensureProfileButton();
    });

    const mo = new MutationObserver(() => schedule());
    mo.observe(document.documentElement, { childList: true, subtree: true });

    const onNav = () => {
      // Robustness: close add modal on navigation to satisfy "navigate away => no action"
      closeAddModal();

      setTimeout(() => {
        ensureSidebarButton();
        ensureProfileButton();
      }, 50);
    };

    patchHistory(onNav);
    window.addEventListener('popstate', onNav);
  }

  function patchHistory(onNav) {
    if (historyPatched) return;
    historyPatched = true;

    const wrap = (obj, key) => {
      const original = obj[key];
      if (typeof original !== 'function') return;
      obj[key] = function (...args) {
        const ret = original.apply(this, args);
        try { onNav(); } catch (_) {}
        return ret;
      };
    };
    wrap(history, 'pushState');
    wrap(history, 'replaceState');
  }

  function throttleRAF(fn) {
    let scheduled = false;
    return () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        try { fn(); } catch (e) { console.warn('[DiscreteFollow] throttled fn failed:', e); }
      });
    };
  }

  /******************************************************************
   * Init
   ******************************************************************/
  async function init() {
    addStyles();
    ensureListModal();
    ensureAddModal();

    ensureSidebarButton();
    ensureProfileButton();

    installSpaGuards();
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init().catch(e => console.warn('[DiscreteFollow] init failed:', e));
  } else {
    window.addEventListener('DOMContentLoaded', () => {
      init().catch(e => console.warn('[DiscreteFollow] init failed:', e));
    }, { once: true });
  }
})();
