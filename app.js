import { createVault, unlockWithPassphrase, unlockWithRecoveryKey, encryptEntry, decryptEntry, WrongSecretError } from './crypto.js';
import { Drive, VAULT_FILE, entryFileName, uidFromFileName } from './drive.js';
import { GOOGLE_CLIENT_ID } from './config.js';

const DEMO = new URLSearchParams(location.search).has('demo');
const MOODS = { 1: ['😞', 'Awful'], 2: ['😕', 'Bad'], 3: ['😐', 'Okay'], 4: ['🙂', 'Good'], 5: ['😄', 'Great'] };
const AUTOLOCK_MS = 15 * 60 * 1000;
const SAVE_DELAY = 1500;

const app = document.getElementById('app');
if (DEMO) document.getElementById('demo-banner').hidden = false;

// ---- state (memory only) ----
let drive = null;
let vault = null;
let vaultFileId = null;
let dek = null;
let entries = new Map(); // uid -> entry (live, non-deleted)
let meta = new Map(); // uid -> { fileId, updatedAt } for every entry file seen, incl. tombstones
let search = '';
let cur = null; // editor state
let lockTimer = null;

// ---- helpers ----
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k);
  return el;
}
function show(...nodes) { app.replaceChildren(...nodes.filter((n) => n != null && n !== false)); window.scrollTo(0, 0); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const fmtShort = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const errMsg = (e) => (e && e.message ? e.message : String(e));

// ---- demo drive ----
class DemoDrive {
  constructor() { this.files = new Map(); this.n = 0; }
  async list() { await sleep(80); return [...this.files].map(([id, f]) => ({ id, name: f.name, appProperties: { ...f.appProperties } })); }
  async download(id) { await sleep(40); const f = this.files.get(id); if (!f) throw new Error('Not found'); return f.content; }
  async put(name, content, appProperties = {}, fileId = null) {
    await sleep(120);
    const id = fileId || 'demo-' + ++this.n;
    this.files.set(id, { name: fileId ? this.files.get(id).name : name, content, appProperties: { ...appProperties } });
    return id;
  }
}

// ---- Google auth ----
let gisPromise = null;
function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  gisPromise ??= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = res;
    s.onerror = () => { gisPromise = null; rej(new Error('Could not load Google sign-in. Check your connection.')); };
    document.head.append(s);
  });
  return gisPromise;
}
let tokenClient = null, token = null, tokenExpiry = 0;
function getToken(force) {
  if (!force && token && Date.now() < tokenExpiry - 60000) return Promise.resolve(token);
  return new Promise((resolve, reject) => {
    tokenClient.callback = (r) => {
      if (r.error) return reject(new Error(r.error_description || r.error));
      token = r.access_token;
      tokenExpiry = Date.now() + Number(r.expires_in || 3600) * 1000;
      resolve(token);
    };
    tokenClient.error_callback = (e) => reject(new Error(e?.type === 'popup_closed' ? 'Sign-in was cancelled.' : 'Sign-in failed (' + (e?.type || 'unknown') + ').'));
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

// ---- screens ----
function signInScreen() {
  stopAutoLock();
  const box = h('div', { class: 'card center' }, h('h1', {}, 'Inkwell'),
    h('p', { class: 'muted' }, 'A private, end-to-end encrypted journal that syncs through your own Google Drive.'));
  if (DEMO) {
    drive = new DemoDrive();
    afterSignIn();
    return;
  }
  if (GOOGLE_CLIENT_ID.includes('PASTE_')) {
    box.append(h('div', { class: 'warn' }, h('strong', {}, 'Setup needed. '),
      'Create a Google OAuth "Web application" client ID, add this site\'s address as an authorized JavaScript origin, and paste the ID into docs/config.js.'));
  } else {
    const err = h('p', { class: 'error', role: 'alert' });
    const btn = h('button', { class: 'primary', onclick: async () => {
      btn.disabled = true; err.textContent = '';
      try {
        await loadGis();
        tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID, scope: 'https://www.googleapis.com/auth/drive.appdata', callback: () => {},
        });
        await getToken(true);
        drive = new Drive(getToken);
        afterSignIn();
      } catch (e) { err.textContent = errMsg(e); btn.disabled = false; }
    } }, 'Sign in with Google');
    box.append(btn, err);
  }
  show(box);
}

async function signOut() {
  lockMemory();
  try { if (token && window.google) google.accounts.oauth2.revoke(token, () => {}); } catch { /* ignore */ }
  token = null; tokenExpiry = 0; drive = null; vault = null; vaultFileId = null; meta = new Map();
  signInScreen();
}

function busy(text) { show(h('div', { class: 'card center' }, h('p', { role: 'status' }, text))); }

async function afterSignIn() {
  busy('Loading…');
  try {
    const files = await drive.list();
    const vf = files.find((f) => f.name === VAULT_FILE);
    if (!vf) { vault = null; vaultFileId = null; return setupScreen(); }
    vaultFileId = vf.id;
    vault = JSON.parse(await drive.download(vf.id));
    unlockScreen();
  } catch (e) { fatal(e, afterSignIn); }
}

function fatal(e, retry) {
  show(h('div', { class: 'card center' }, h('h2', {}, 'Something went wrong'), h('p', { class: 'error' }, errMsg(e)),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: retry }, 'Try again'), h('button', { onclick: signOut }, 'Sign out'))));
}

function setupScreen() {
  const p1 = h('input', { type: 'password', id: 'p1', autocomplete: 'new-password' });
  const p2 = h('input', { type: 'password', id: 'p2', autocomplete: 'new-password' });
  const err = h('p', { class: 'error', role: 'alert' });
  const go = h('button', { class: 'primary', type: 'submit' }, 'Create encrypted journal');
  const form = h('form', { class: 'card center', onsubmit: async (ev) => {
    ev.preventDefault(); err.textContent = '';
    if (p1.value.length < 8) { err.textContent = 'Use at least 8 characters.'; return; }
    if (p1.value !== p2.value) { err.textContent = 'The passphrases do not match.'; return; }
    go.disabled = true; go.textContent = 'Creating…';
    try {
      const r = await createVault(p1.value);
      vaultFileId = await drive.put(VAULT_FILE, JSON.stringify(r.vault), {}, null);
      vault = r.vault; dek = r.dek;
      recoveryScreen(r.recoveryKey);
    } catch (e) { err.textContent = errMsg(e); go.disabled = false; go.textContent = 'Create encrypted journal'; }
  } },
  h('h2', {}, 'Set up encryption'),
  h('p', { class: 'muted' }, 'Choose a passphrase. Your entries are encrypted on this device before they reach Google Drive.'),
  h('div', { class: 'warn' }, h('strong', {}, 'If you forget this passphrase, your entries cannot be recovered. '),
    'Nobody, including us and Google, can reset it. Keep the recovery key you get next in a safe place.'),
  h('label', { for: 'p1' }, 'Passphrase (8+ characters)'), p1,
  h('label', { for: 'p2' }, 'Confirm passphrase'), p2, err,
  h('div', { class: 'row', style: 'margin-top:16px' }, go, h('button', { type: 'button', onclick: signOut }, 'Sign out')));
  show(form);
  p1.focus();
}

function recoveryScreen(key) {
  const cont = h('button', { class: 'primary', disabled: true, onclick: () => startJournal() }, 'Continue');
  const chk = h('input', { type: 'checkbox', id: 'saved', onchange: () => { cont.disabled = !chk.checked; } });
  const copy = h('button', { onclick: async () => {
    try { await navigator.clipboard.writeText(key); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select and copy manually'; }
  } }, 'Copy');
  show(h('div', { class: 'card center' }, h('h2', {}, 'Your recovery key'),
    h('p', { class: 'muted' }, 'This is the only other way to unlock your journal if you forget your passphrase. It is shown once. Write it down or store it in a password manager.'),
    h('div', { class: 'recovery' }, key), h('div', { class: 'row' }, copy),
    h('label', { class: 'checkrow', for: 'saved' }, chk, "I've saved my recovery key"), cont));
}

function unlockScreen(useRecovery = false) {
  stopAutoLock();
  const input = h('input', { type: 'password', id: 'secret', autocomplete: useRecovery ? 'off' : 'current-password', spellcheck: 'false' });
  const err = h('p', { class: 'error', role: 'alert' });
  const go = h('button', { class: 'primary', type: 'submit' }, 'Unlock');
  const form = h('form', { class: 'card center', onsubmit: async (ev) => {
    ev.preventDefault(); err.textContent = '';
    if (!input.value) return;
    go.disabled = true; go.textContent = 'Unlocking…';
    try {
      dek = useRecovery ? await unlockWithRecoveryKey(vault, input.value) : await unlockWithPassphrase(vault, input.value);
      input.value = '';
      startJournal();
    } catch (e) {
      err.textContent = e instanceof WrongSecretError || /length/.test(errMsg(e)) ? errMsg(e) : 'Could not unlock: ' + errMsg(e);
      go.disabled = false; go.textContent = 'Unlock'; input.focus();
    }
  } },
  h('h2', {}, 'Unlock your journal'),
  h('label', { for: 'secret' }, useRecovery ? 'Recovery key' : 'Passphrase'), input, err,
  h('div', { class: 'row', style: 'margin-top:16px' }, go, h('button', { type: 'button', onclick: signOut }, 'Sign out')),
  h('p', { style: 'margin-top:16px' }, h('button', { type: 'button', class: 'link', onclick: () => unlockScreen(!useRecovery) },
    useRecovery ? 'Use passphrase instead' : 'Use recovery key instead')));
  show(form);
  input.focus();
}

// ---- journal ----
async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/** Pulls new/changed entries. onProgress(done,total). Returns count of failures. */
async function pull(onProgress) {
  const files = await drive.list();
  const todo = [];
  const seen = new Set();
  for (const f of files) {
    const uid = uidFromFileName(f.name);
    if (!uid) continue;
    seen.add(uid);
    const remote = Number(f.appProperties?.updatedAt) || 0;
    const known = meta.get(uid);
    const tomb = f.appProperties?.deleted === '1';
    if (known && known.updatedAt >= remote && known.fileId === f.id) continue;
    if (tomb && remote) { meta.set(uid, { fileId: f.id, updatedAt: remote }); entries.delete(uid); continue; }
    todo.push({ uid, f, remote });
  }
  let done = 0, failed = 0;
  onProgress?.(0, todo.length);
  await pool(todo, 6, async ({ uid, f, remote }) => {
    try {
      const e = await decryptEntry(dek, uid, await drive.download(f.id));
      const upd = Number(e.updatedAt) || remote;
      meta.set(uid, { fileId: f.id, updatedAt: Math.max(upd, remote) });
      if (e.deleted) entries.delete(uid); else entries.set(uid, e);
    } catch { failed++; }
    onProgress?.(++done, todo.length);
  });
  return failed;
}

async function startJournal() {
  const p = h('p', { role: 'status' }, 'Loading entries…');
  show(h('div', { class: 'card center' }, p));
  startAutoLock();
  try {
    entries = new Map(); meta = new Map();
    const failed = await pull((d, t) => { p.textContent = `Decrypting entries… ${d} / ${t}`; });
    if (failed) listScreen(`${failed} entr${failed === 1 ? 'y' : 'ies'} could not be read.`);
    else editorScreen(null); // like the phone app: open straight to a new entry; Back shows the list

  } catch (e) { fatal(e, startJournal); }
}

function snippetOf(e) {
  const lines = (e.body || '').split('\n').map((s) => s.trim()).filter(Boolean);
  return { title: e.title?.trim() || lines[0] || 'Untitled', snip: (e.title?.trim() ? lines : lines.slice(1)).join(' ').slice(0, 240) };
}

function listScreen(note = '') {
  cur = null;
  const q = search.trim().toLowerCase();
  const items = [...entries.values()]
    .filter((e) => !q || (e.title || '').toLowerCase().includes(q) || (e.body || '').toLowerCase().includes(q))
    .sort((a, b) => b.createdAt - a.createdAt);
  const status = h('span', { class: 'status', role: 'status' }, note);
  const searchIn = h('input', { type: 'search', id: 'q', value: search, placeholder: 'Search entries', 'aria-label': 'Search entries',
    oninput: () => { search = searchIn.value; renderList(); } });
  const listBox = h('div', {});
  function renderList() {
    const qq = search.trim().toLowerCase();
    const its = [...entries.values()]
      .filter((e) => !qq || (e.title || '').toLowerCase().includes(qq) || (e.body || '').toLowerCase().includes(qq))
      .sort((a, b) => b.createdAt - a.createdAt);
    listBox.replaceChildren();
    if (!its.length) {
      listBox.append(h('div', { class: 'empty' }, entries.size ? 'No entries match your search.' : 'No entries yet. Write your first one.'));
      return;
    }
    let month = '';
    for (const e of its) {
      const m = new Date(e.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      if (m !== month) { month = m; listBox.append(h('div', { class: 'month', role: 'heading', 'aria-level': '2' }, m)); }
      const { title, snip } = snippetOf(e);
      const mood = MOODS[e.mood];
      listBox.append(h('button', { class: 'entry', onclick: () => editorScreen(e.uid) },
        h('div', { class: 'meta' }, fmtShort(e.createdAt), mood ? ` · ${mood[0]} ${mood[1]}` : ''),
        h('div', { class: 't' }, title), snip ? h('div', { class: 'snip' }, snip) : null));
    }
  }
  const refresh = h('button', { onclick: async () => {
    refresh.disabled = true; status.textContent = 'Refreshing…';
    try {
      const failed = await pull();
      status.textContent = failed ? `${failed} entries could not be read.` : 'Up to date.';
      renderList();
    } catch (e) { status.textContent = 'Refresh failed: ' + errMsg(e); }
    refresh.disabled = false;
  } }, 'Refresh');
  show(
    h('header', { class: 'bar' }, h('h1', {}, 'Inkwell'),
      h('button', { class: 'primary', onclick: () => editorScreen(null) }, 'New entry'),
      refresh, h('button', { onclick: lock }, 'Lock'), h('button', { onclick: signOut }, 'Sign out')),
    searchIn, h('div', { style: 'margin-top:8px' }, status), listBox);
  renderList();
}

// ---- editor ----
function editorScreen(uid) {
  const existing = uid ? entries.get(uid) : null;
  const now = Date.now();
  const e0 = existing || { uid: crypto.randomUUID(), title: '', body: '', mood: null, prompt: null, reflection: null, createdAt: now, updatedAt: now, deleted: false };
  cur = { e: { ...e0 }, fileId: meta.get(e0.uid)?.fileId || null, dirty: false, timer: null, queue: Promise.resolve(), failed: false };
  const c = cur;

  const status = h('span', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const retry = h('button', { class: 'link', hidden: true, onclick: () => save() }, 'Retry');
  const setStatus = (t, showRetry = false) => { status.textContent = t; retry.hidden = !showRetry; };

  const title = h('input', { type: 'text', class: 'title-in', 'aria-label': 'Title', placeholder: 'Title', value: c.e.title, maxlength: '300' });
  const body = h('textarea', { class: 'body', 'aria-label': 'Entry', placeholder: 'Start writing…' });
  body.value = c.e.body;
  const fit = () => { body.style.height = 'auto'; body.style.height = Math.max(body.scrollHeight, window.innerHeight * 0.5) + 'px'; };

  const moodBtns = Object.entries(MOODS).map(([n, [emo, label]]) => h('button', {
    type: 'button', 'aria-label': label, title: label, 'aria-pressed': String(c.e.mood === Number(n)),
    onclick: () => { c.e.mood = c.e.mood === Number(n) ? null : Number(n); moodBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(c.e.mood === i + 1))); touch(); },
  }, emo));

  function touch() {
    c.dirty = true; setStatus('Unsaved changes');
    clearTimeout(c.timer); c.timer = setTimeout(save, SAVE_DELAY);
  }
  title.addEventListener('input', touch);
  body.addEventListener('input', () => { fit(); touch(); });

  function save() {
    clearTimeout(c.timer);
    c.queue = c.queue.then(async () => {
      if (!c.dirty) return;
      c.e.title = title.value; c.e.body = body.value;
      if (!c.fileId && !c.e.title.trim() && !c.e.body.trim()) { c.dirty = false; setStatus(''); return; }
      c.dirty = false; setStatus('Saving…');
      try {
        const snapshot = { ...c.e, updatedAt: Date.now() };
        const text = await encryptEntry(dek, snapshot);
        c.fileId = await drive.put(entryFileName(snapshot.uid), text, { updatedAt: String(snapshot.updatedAt), deleted: '0' }, c.fileId);
        c.e.updatedAt = snapshot.updatedAt;
        entries.set(snapshot.uid, snapshot);
        meta.set(snapshot.uid, { fileId: c.fileId, updatedAt: snapshot.updatedAt });
        c.failed = false;
        if (!c.dirty) setStatus('Saved');
      } catch (err) { c.dirty = true; c.failed = true; setStatus('Couldn’t save — ', true); }
    });
    return c.queue;
  }
  c.save = save;

  const back = async () => {
    await save();
    if (c.failed && !confirm('This entry could not be saved. Leave anyway and lose the unsaved changes?')) return;
    cur = null; listScreen();
  };

  const dlg = h('dialog', { 'aria-labelledby': 'dh' }, h('h2', { id: 'dh' }, 'Delete this entry?'),
    h('p', {}, 'This removes it from all your devices and cannot be undone.'),
    h('div', { class: 'row end' }, h('button', { onclick: () => dlg.close() }, 'Cancel'),
      h('button', { class: 'danger', onclick: async () => {
        dlg.close(); clearTimeout(c.timer); c.dirty = false;
        try {
          await c.queue;
          if (c.fileId) {
            const t = { uid: c.e.uid, title: '', body: '', mood: null, prompt: null, reflection: null, createdAt: c.e.createdAt, updatedAt: Date.now(), deleted: true };
            await drive.put(entryFileName(t.uid), await encryptEntry(dek, t), { updatedAt: String(t.updatedAt), deleted: '1' }, c.fileId);
            meta.set(t.uid, { fileId: c.fileId, updatedAt: t.updatedAt });
          }
          entries.delete(c.e.uid);
          cur = null; listScreen();
        } catch (err) { setStatus('Couldn’t delete: ' + errMsg(err)); }
      } }, 'Delete')));

  show(
    h('header', { class: 'bar' }, h('button', { onclick: back }, '← Back'), h('span', { class: 'spacer' }), status, retry,
      existing || c.fileId ? h('button', { class: 'danger', onclick: () => dlg.showModal() }, 'Delete') : null),
    h('h2', {}, fmtDate(c.e.createdAt)),
    h('div', { class: 'moods', role: 'group', 'aria-label': 'Mood' }, moodBtns),
    title,
    c.e.prompt ? h('p', { class: 'prompt' }, c.e.prompt) : null,
    body,
    c.e.reflection ? h('div', { class: 'reflection' }, h('strong', {}, 'Reflection'), h('div', {}, c.e.reflection)) : null,
    dlg);
  fit();
  body.focus();
  body.setSelectionRange(body.value.length, body.value.length);
}

// ---- lock / auto-lock ----
function lockMemory() { dek = null; entries = new Map(); meta = new Map(); cur = null; search = ''; }

async function lock() {
  if (cur?.dirty) { try { await cur.save(); } catch { /* ignore */ } }
  stopAutoLock();
  lockMemory();
  if (vault) unlockScreen(); else signInScreen();
}

function startAutoLock() {
  stopAutoLock();
  const reset = () => { clearTimeout(lockTimer); lockTimer = setTimeout(lock, AUTOLOCK_MS); };
  startAutoLock.reset = reset;
  for (const ev of ['pointerdown', 'keydown', 'scroll', 'touchstart']) window.addEventListener(ev, reset, { passive: true });
  reset();
}
function stopAutoLock() {
  clearTimeout(lockTimer);
  if (startAutoLock.reset) for (const ev of ['pointerdown', 'keydown', 'scroll', 'touchstart']) window.removeEventListener(ev, startAutoLock.reset);
  startAutoLock.reset = null;
}

window.addEventListener('beforeunload', (ev) => { if (cur?.dirty) { ev.preventDefault(); ev.returnValue = ''; } });

signInScreen();
