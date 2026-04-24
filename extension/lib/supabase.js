// Lightweight Supabase REST client — no npm dependencies.
// Loaded via importScripts() in background.js.
// Also included via <script> tag in options.html / popup.html.

'use strict';

/* global chrome */

// ---------------------------------------------------------------------------
// Chrome storage helpers (work in both content scripts and service workers)
// ---------------------------------------------------------------------------
function chromeGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}
function chromeSet(data) {
  return new Promise(resolve => chrome.storage.local.set(data, resolve));
}

// ---------------------------------------------------------------------------
// Supabase REST client
// ---------------------------------------------------------------------------
class SupabaseClient {
  constructor(url, anonKey) {
    this.url = url.replace(/\/$/, '');
    this.anonKey = anonKey;
    this.accessToken = null;
    this.refreshToken = null;
    this.userId = null;
  }

  async init() {
    const stored = await chromeGet(['sbAccess', 'sbRefresh', 'sbUserId']);
    if (stored.sbAccess) {
      this.accessToken = stored.sbAccess;
      this.refreshToken = stored.sbRefresh;
      this.userId = stored.sbUserId;
      try {
        await this._refreshSession();
      } catch {
        await this._signInAnon();
      }
    } else {
      await this._signInAnon();
    }
  }

  async _signInAnon() {
    const res = await fetch(`${this.url}/auth/v1/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: this.anonKey },
      body: JSON.stringify({})
    });
    if (!res.ok) throw new Error(`Supabase anon auth failed: ${res.status}`);
    const data = await res.json();
    await this._saveSession(data);
  }

  async _refreshSession() {
    const res = await fetch(`${this.url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: this.anonKey },
      body: JSON.stringify({ refresh_token: this.refreshToken })
    });
    if (!res.ok) throw new Error('Token refresh failed');
    const data = await res.json();
    await this._saveSession(data);
  }

  async _saveSession(data) {
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token;
    this.userId = data.user?.id || this.userId;
    await chromeSet({ sbAccess: this.accessToken, sbRefresh: this.refreshToken, sbUserId: this.userId });
  }

  _headers(extra = {}) {
    return {
      'Content-Type': 'application/json',
      apikey: this.anonKey,
      Authorization: `Bearer ${this.accessToken}`,
      ...extra
    };
  }

  async _req(method, path, { body, query, prefer } = {}) {
    let url = `${this.url}/rest/v1/${path}`;
    if (query && Object.keys(query).length) {
      url += '?' + new URLSearchParams(query).toString();
    }
    const headers = this._headers(prefer ? { Prefer: prefer } : {});
    const opts = { method, headers };
    if (body !== undefined) opts.body = JSON.stringify(body);

    let res = await fetch(url, opts);

    // Auto-refresh on 401
    if (res.status === 401) {
      await this._refreshSession();
      headers.Authorization = `Bearer ${this.accessToken}`;
      res = await fetch(url, opts);
    }

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Supabase ${res.status}: ${txt}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  // Select with PostgREST filter params, e.g. { 'id': 'eq.abc', order: 'created_at.asc' }
  select(table, params = {}) {
    return this._req('GET', table, { query: { select: '*', ...params } });
  }

  insert(table, data) {
    return this._req('POST', table, {
      body: Array.isArray(data) ? data : [data],
      prefer: 'return=representation'
    });
  }

  update(table, match, data) {
    const q = this._matchToQuery(match);
    return this._req('PATCH', table, { body: data, query: q, prefer: 'return=representation' });
  }

  delete(table, match) {
    return this._req('DELETE', table, { query: this._matchToQuery(match) });
  }

  // Upsert using Supabase's resolution preference
  upsert(table, data) {
    return this._req('POST', table, {
      body: Array.isArray(data) ? data : [data],
      prefer: 'resolution=merge-duplicates,return=representation'
    });
  }

  _matchToQuery(match) {
    return Object.fromEntries(Object.entries(match).map(([k, v]) => [k, `eq.${v}`]));
  }
}

// ---------------------------------------------------------------------------
// Singleton factory — call getSupabase() anywhere
// ---------------------------------------------------------------------------
let _client = null;

async function getSupabase() {
  if (_client) return _client;
  const cfg = await chromeGet(['supabaseUrl', 'supabaseAnonKey']);
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    throw new Error('Supabase not configured');
  }
  _client = new SupabaseClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  await _client.init();
  return _client;
}

function resetSupabaseClient() {
  _client = null;
}
