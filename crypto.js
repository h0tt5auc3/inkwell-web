// Inkwell end-to-end encryption. Must stay byte-compatible with
// app/src/main/java/com/inkwell/journal/sync/VaultCrypto.kt — see SYNC_FORMAT.md.
//
// - A random 256-bit data key (DEK) encrypts every entry with AES-256-GCM.
// - The DEK is stored in Drive only in wrapped form: once under a key derived from
//   your passphrase (PBKDF2-SHA256, 600k rounds) and once under your recovery key.
// - Drive never sees the passphrase, the recovery key, the DEK, or any entry text.

const te = new TextEncoder();
const td = new TextDecoder();

export const KDF_ITERATIONS = 600000;
const AAD_PASS = 'inkwell-vault-pass';
const AAD_RECOVERY = 'inkwell-vault-recovery';
const entryAad = (uid) => 'inkwell-entry:' + uid;

export function b64encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const random = (n) => crypto.getRandomValues(new Uint8Array(n));

async function aesKey(raw, extractable = false) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt']);
}

async function passphraseKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey(
    'raw', te.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256,
  );
  return aesKey(new Uint8Array(bits));
}

async function seal(key, plaintext, aad) {
  const iv = random(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, plaintext,
  ));
  return { iv: b64encode(iv), ct: b64encode(ct) };
}

async function open(key, box, aad) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64decode(box.iv), additionalData: te.encode(aad) },
    key, b64decode(box.ct),
  );
  return new Uint8Array(pt);
}

// ---- Recovery key: 32 random bytes shown as base32 in groups of four ----

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function formatRecoveryKey(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g).join('-');
}

export function parseRecoveryKey(text) {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  if (out.length !== 32) throw new Error('That recovery key is not the right length.');
  return new Uint8Array(out);
}

// ---- Vault ----

/** Creates a new vault. Returns { vault, dek, recoveryKey } — show recoveryKey to the user once. */
export async function createVault(passphrase) {
  const dekRaw = random(32);
  const recoveryRaw = random(32);
  const salt = random(16);
  const passKey = await passphraseKey(passphrase, salt, KDF_ITERATIONS);
  const vault = {
    v: 1,
    kdf: { alg: 'PBKDF2-SHA256', iter: KDF_ITERATIONS, salt: b64encode(salt) },
    pass: await seal(passKey, dekRaw, AAD_PASS),
    recovery: await seal(await aesKey(recoveryRaw), dekRaw, AAD_RECOVERY),
  };
  return { vault, dek: await aesKey(dekRaw), recoveryKey: formatRecoveryKey(recoveryRaw) };
}

/** Unlocks with the passphrase. Throws WrongSecretError if it doesn't match. */
export async function unlockWithPassphrase(vault, passphrase) {
  const key = await passphraseKey(passphrase, b64decode(vault.kdf.salt), vault.kdf.iter);
  try {
    return await aesKey(await open(key, vault.pass, AAD_PASS));
  } catch {
    throw new WrongSecretError('That passphrase is not right.');
  }
}

export async function unlockWithRecoveryKey(vault, recoveryKey) {
  const key = await aesKey(parseRecoveryKey(recoveryKey));
  try {
    return await aesKey(await open(key, vault.recovery, AAD_RECOVERY));
  } catch {
    throw new WrongSecretError('That recovery key is not right.');
  }
}

export class WrongSecretError extends Error {}

// ---- Entries ----
// Plaintext shape: { uid, title, body, mood (1-5|null), prompt (string|null),
//   reflection (string|null), createdAt (ms), updatedAt (ms), deleted (bool) }

export async function encryptEntry(dek, entry) {
  const box = await seal(dek, te.encode(JSON.stringify(entry)), entryAad(entry.uid));
  return JSON.stringify({ v: 1, ...box });
}

export async function decryptEntry(dek, uid, fileText) {
  const box = JSON.parse(fileText);
  return JSON.parse(td.decode(await open(dek, box, entryAad(uid))));
}
