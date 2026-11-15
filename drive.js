// Minimal Google Drive v3 client for Inkwell's hidden app folder (drive.appdata scope).
// File layout (shared with the Android app — see SYNC_FORMAT.md):
//   vault.json            the wrapped data key
//   entry-<uid>.json      one encrypted entry each; appProperties { updatedAt, deleted }

const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

export const VAULT_FILE = 'vault.json';
export const entryFileName = (uid) => `entry-${uid}.json`;
export const uidFromFileName = (name) => name.match(/^entry-(.+)\.json$/)?.[1] ?? null;

export class Drive {
  /** getToken(forceRefresh) must resolve to an OAuth access token with the drive.appdata scope. */
  constructor(getToken) {
    this.getToken = getToken;
  }

  async request(url, init = {}, retried = false) {
    const token = await this.getToken(retried);
    const res = await fetch(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 && !retried) return this.request(url, init, true);
    if (!res.ok) throw new Error(`Google Drive error ${res.status}: ${await res.text()}`);
    return res;
  }

  /** Every file in the app folder: [{ id, name, appProperties }]. */
  async list() {
    const files = [];
    let pageToken = '';
    do {
      const q = new URLSearchParams({
        spaces: 'appDataFolder',
        fields: 'nextPageToken,files(id,name,appProperties)',
        pageSize: '1000',
      });
      if (pageToken) q.set('pageToken', pageToken);
      const data = await (await this.request(`${API}?${q}`)).json();
      files.push(...(data.files || []));
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return files;
  }

  /** The signed-in Google account's opaque Drive ID (not the email address). */
  async accountId() {
    const data = await (await this.request('https://www.googleapis.com/drive/v3/about?fields=user(permissionId)')).json();
    return data.user?.permissionId || '';
  }

  async download(id) {
    return (await this.request(`${API}/${id}?alt=media`)).text();
  }

  /** Creates a file, or replaces its content if fileId is given. Returns the file id. */
  async put(name, content, appProperties = {}, fileId = null) {
    const metadata = fileId ? { appProperties } : { name, parents: ['appDataFolder'], appProperties };
    const boundary = 'inkwell' + Math.random().toString(36).slice(2);
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(metadata) +
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
      content +
      `\r\n--${boundary}--`;
    const url = fileId
      ? `${UPLOAD}/${fileId}?uploadType=multipart&fields=id`
      : `${UPLOAD}?uploadType=multipart&fields=id`;
    const res = await this.request(url, {
      method: fileId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    return (await res.json()).id;
  }
}
