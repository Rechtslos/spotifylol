// Liked Songs Sync: single-file Cloudflare Worker.
// Needs: KV binding "STORE", secret SESSION_SECRET, and a Cron Trigger (for example every 10 minutes).
// Every user enters their own Spotify app's Client ID and secret in the login box on the page.

const API = 'https://api.spotify.com/v1';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SCOPES = 'user-library-read playlist-read-private playlist-modify-private playlist-modify-public';
const DEFAULT_BUDGET = 30; // Spotify calls per run. The free plan allows 50 subrequests, so stay below it.

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ---------- crypto (Web Crypto) ---------- */
const b64 = (buf) => { let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let keyCache = null;
async function keys(env) {
  if (!keyCache) {
    const raw = await crypto.subtle.digest('SHA-256', enc.encode(env.SESSION_SECRET));
    keyCache = {
      aes: await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']),
      hmac: await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    };
  }
  return keyCache;
}
async function seal(env, text) {
  const { aes } = await keys(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, enc.encode(text)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return b64(out);
}
async function unseal(env, str) {
  const { aes } = await keys(env);
  const buf = unb64(str);
  return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, aes, buf.slice(12)));
}
async function sign(env, v) {
  const { hmac } = await keys(env);
  return v + '.' + b64url(await crypto.subtle.sign('HMAC', hmac, enc.encode(v)));
}
async function unsign(env, s) {
  if (!s) return null;
  const i = s.lastIndexOf('.');
  if (i < 0) return null;
  const v = s.slice(0, i);
  const expected = await sign(env, v);
  if (expected.length !== s.length) return null;
  let diff = 0;
  for (let k = 0; k < s.length; k++) diff |= s.charCodeAt(k) ^ expected.charCodeAt(k);
  return diff === 0 ? v : null;
}

/* ---------- budget: keeps each run under Cloudflare's subrequest limit ---------- */
class BudgetError extends Error {}
class Budget {
  constructor(max) { this.max = max; this.used = 0; }
  left() { return this.max - this.used; }
  spend() { if (++this.used > this.max) throw new BudgetError('budget'); }
}
const newBudget = (env) => new Budget(Number(env.SUBREQUEST_BUDGET) || DEFAULT_BUDGET);

/* ---------- Spotify ---------- */
const tokenCache = new Map();
const basicAuth = (id, secret) => 'Basic ' + btoa(id + ':' + secret);

async function accessToken(env, uid, u, B) {
  const c = tokenCache.get(uid);
  if (c && c.exp > Date.now() + 30000) return c.token;
  const secret = await unseal(env, u.csec);
  B.spend();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth(u.cid, secret) },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: await unseal(env, u.refresh) }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (j.error === 'invalid_grant') u.needsReauth = true;
    throw new Error('Token refresh failed: ' + (j.error_description || j.error || res.status));
  }
  if (j.refresh_token) u.refresh = await seal(env, j.refresh_token);
  tokenCache.set(uid, { token: j.access_token, exp: Date.now() + j.expires_in * 1000 });
  return j.access_token;
}

async function spotifyCall(env, uid, u, B, path, { method = 'GET', body } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = await accessToken(env, uid, u, B);
    B.spend();
    const res = await fetch(API + path, {
      method,
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after')) || 1;
      if (wait > 8) throw new Error('Spotify is rate limiting requests. It will try again on the next check.');
      await new Promise((r) => setTimeout(r, wait * 1000 + 250));
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      const err = new Error('Spotify ' + res.status + ' on ' + method + ' ' + path.split('?')[0] + ': ' + text.slice(0, 300));
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  }
  throw new Error('Spotify rate limit: gave up after several retries.');
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const trackUri = (it) => {
  const uri = (it.track ?? it.item)?.uri;
  return uri && !uri.startsWith('spotify:local:') ? uri : null;
};

/* ---------- sync ----------
   KV keys:  u:<spotifyId>  profile, settings, progress
             s:<spotifyId>  array of song URIs already in the playlist
   First run copies the whole library in batches (resumes on the next run if it is big).
   After that, each run only looks at likes newer than the last one it saw. */
async function syncUser(env, uid, B) {
  const u = await env.STORE.get('u:' + uid, 'json');
  if (!u) return null;
  if (u.lockUntil && u.lockUntil > Date.now()) return u; // another run is active
  u.lockUntil = Date.now() + 90000;
  await env.STORE.put('u:' + uid, JSON.stringify(u));

  const sp = (path, opts) => spotifyCall(env, uid, u, B, path, opts);
  let synced = new Set((await env.STORE.get('s:' + uid, 'json')) || []);
  let changed = false;
  let added = 0;
  let total = null;

  const addItems = async (uris, atTop) => {
    const parts = chunk(uris, 100);
    if (atTop) parts.reverse(); // newest chunk ends up on top
    for (const part of parts) {
      try {
        await sp('/playlists/' + u.playlistId + '/items', {
          method: 'POST',
          body: atTop ? { uris: part, position: 0 } : { uris: part },
        });
      } catch (e) {
        if (e.status === 404) {
          u.playlistId = null;
          synced = new Set();
          changed = true;
          throw new Error('The playlist no longer exists in Spotify. A new one is created on the next sync.');
        }
        throw e;
      }
      part.forEach((x) => synced.add(x));
      added += part.length;
      changed = true;
    }
  };

  try {
    if (!u.playlistId) {
      const p = await sp('/me/playlists', {
        method: 'POST',
        body: { name: u.playlistName, description: 'Mirror of my Liked Songs. Updated automatically.', public: false },
      });
      u.playlistId = p.id;
      u.backfill = { offset: 0, total: null, topAt: null };
      u.cursorAt = null;
      synced = new Set();
      changed = true;
    }

    if (u.backfill) {
      // Copy the whole library, newest first, appending to the playlist.
      const bf = u.backfill;
      while (B.left() >= 4) {
        const page = await sp('/me/tracks?limit=50&offset=' + bf.offset);
        if (bf.offset === 0) bf.topAt = page.items[0]?.added_at ?? null;
        bf.total = total = page.total;
        const seen = new Set();
        const fresh = [];
        for (const it of page.items) {
          const uri = trackUri(it);
          if (uri && !synced.has(uri) && !seen.has(uri)) { seen.add(uri); fresh.push(uri); }
        }
        if (fresh.length) await addItems(fresh, false);
        bf.offset += page.items.length;
        if (!page.next || page.items.length === 0) {
          u.cursorAt = bf.topAt || '1970-01-01T00:00:00Z';
          u.backfill = null;
          break;
        }
      }
    } else {
      // Incremental: only likes newer than the last one seen.
      const cursor = u.cursorAt || '1970-01-01T00:00:00Z';
      const seen = new Set();
      const fresh = [];
      let offset = 0;
      let topAt = null;
      let complete = false;
      while (B.left() >= 4) {
        const page = await sp('/me/tracks?limit=50&offset=' + offset);
        total = page.total;
        if (offset === 0) topAt = page.items[0]?.added_at ?? null;
        for (const it of page.items) {
          if (it.added_at < cursor) { complete = true; break; }
          const uri = trackUri(it);
          if (uri && !synced.has(uri) && !seen.has(uri)) { seen.add(uri); fresh.push(uri); }
        }
        offset += page.items.length;
        if (complete || !page.next || page.items.length === 0) { complete = true; break; }
      }
      if (fresh.length) await addItems(fresh, true);
      if (complete && topAt && topAt > cursor) u.cursorAt = topAt;
    }

    u.lastError = null;
    if (total !== null) u.lastResult = { liked: total, playlist: synced.size };
    if (added > 0) u.lastAdded = { count: added, at: Date.now() };
  } catch (e) {
    if (!(e instanceof BudgetError)) {
      console.error('Sync failed for ' + uid + ': ' + e.message);
      u.lastError = e.message;
    }
  } finally {
    u.lockUntil = 0;
    u.lastCheck = Date.now();
    if (changed) await env.STORE.put('s:' + uid, JSON.stringify([...synced]));
    await env.STORE.put('u:' + uid, JSON.stringify(u));
  }
  return u;
}

/* ---------- web helpers ---------- */
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });

function readCookies(request) {
  const out = {};
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const cookie = (name, value, secure, maxAge) =>
  name + '=' + encodeURIComponent(value) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (secure ? '; Secure' : '');

async function currentUser(env, request) {
  const id = await unsign(env, readCookies(request).sid);
  if (!id) return null;
  const u = await env.STORE.get('u:' + id, 'json');
  return u ? { id, u } : null;
}

const view = (u) => ({
  connected: true,
  name: u.name,
  playlistName: u.playlistName,
  playlistUrl: u.playlistId ? 'https://open.spotify.com/playlist/' + u.playlistId : null,
  auto: u.auto,
  needsReauth: !!u.needsReauth,
  running: !!(u.lockUntil && u.lockUntil > Date.now()),
  lastCheck: u.lastCheck || null,
  lastResult: u.lastResult || null,
  lastAdded: u.lastAdded || null,
  lastError: u.lastError || null,
  backfill: u.backfill ? { offset: u.backfill.offset, total: u.backfill.total } : null,
});

const redirect = (location, extra = []) => {
  const h = new Headers({ Location: location });
  extra.forEach((c) => h.append('Set-Cookie', c));
  return new Response(null, { status: 302, headers: h });
};

/* ---------- worker entry ---------- */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const method = request.method;
    const secure = url.protocol === 'https:';
    const redirectUri = url.origin + '/callback';

    if (method === 'GET' && p === '/') {
      return new Response(HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    const missing = [];
    if (!env.SESSION_SECRET) missing.push('SESSION_SECRET');
    if (!env.STORE) missing.push('STORE (KV binding)');

    if (p === '/api/status') {
      if (missing.length) return json({ connected: false, missing, redirectUri });
      const cur = await currentUser(env, request);
      return json(cur ? view(cur.u) : { connected: false, missing: [], redirectUri });
    }
    if (missing.length) return json({ error: 'Not configured: ' + missing.join(', ') }, 503);

    // Starts the Spotify login using the user's own app credentials (kept encrypted for 15 minutes).
    const startLogin = async (cid, csecSealed) => {
      const pid = crypto.randomUUID();
      await env.STORE.put('p:' + pid, JSON.stringify({ cid, csec: csecSealed }), { expirationTtl: 900 });
      const q = new URLSearchParams({
        client_id: cid,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: SCOPES,
        state: pid,
      });
      return {
        url: 'https://accounts.spotify.com/authorize?' + q,
        cookie: cookie('oauth_state', await sign(env, pid), secure, 900),
      };
    };

    if (method === 'POST' && p === '/api/connect') {
      if (!(request.headers.get('Content-Type') || '').includes('application/json')) {
        return json({ error: 'JSON only' }, 415);
      }
      const body = await request.json().catch(() => ({}));
      const cid = String(body.clientId || '').trim();
      const secret = String(body.clientSecret || '').trim();
      if (!/^[A-Za-z0-9]{20,64}$/.test(cid)) return json({ error: 'That Client ID does not look right. Copy it from your Spotify app.' }, 400);
      if (!/^[A-Za-z0-9]{20,64}$/.test(secret)) return json({ error: 'That Client secret does not look right. Copy it from your Spotify app.' }, 400);
      const login = await startLogin(cid, await seal(env, secret));
      return json({ url: login.url }, 200, { 'Set-Cookie': login.cookie });
    }

    if (method === 'GET' && p === '/login') {
      // Reconnect with the credentials already saved for this user.
      const cur = await currentUser(env, request);
      if (!cur || !cur.u.cid || !cur.u.csec) return redirect('/');
      const login = await startLogin(cur.u.cid, cur.u.csec);
      return redirect(login.url, [login.cookie]);
    }

    if (method === 'GET' && p === '/callback') {
      if (url.searchParams.get('error')) return redirect('/?error=denied');
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const expected = await unsign(env, readCookies(request).oauth_state);
      if (!expected || expected !== state || !code) return redirect('/?error=state');
      const pend = await env.STORE.get('p:' + state, 'json');
      if (!pend) return redirect('/?error=state');
      await env.STORE.delete('p:' + state);

      const tr = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth(pend.cid, await unseal(env, pend.csec)) },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
      });
      const t = await tr.json().catch(() => ({}));
      if (!tr.ok) return redirect('/?error=token');

      const meRes = await fetch(API + '/me', { headers: { Authorization: 'Bearer ' + t.access_token } });
      const me = await meRes.json().catch(() => ({}));
      if (!meRes.ok || !me.id) return redirect('/?error=profile');

      const prev = (await env.STORE.get('u:' + me.id, 'json')) || {};
      const u = {
        auto: true,
        playlistName: 'Liked Songs (synced)',
        ...prev,
        name: me.display_name || me.id,
        cid: pend.cid,
        csec: pend.csec,
        refresh: await seal(env, t.refresh_token),
        needsReauth: false,
        lastError: null,
        lockUntil: 0,
      };
      await env.STORE.put('u:' + me.id, JSON.stringify(u));
      tokenCache.set(me.id, { token: t.access_token, exp: Date.now() + t.expires_in * 1000 });

      ctx.waitUntil(syncUser(env, me.id, newBudget(env))); // first batch starts right away
      return redirect('/', [
        cookie('sid', await sign(env, me.id), secure, 60 * 60 * 24 * 90),
        cookie('oauth_state', '', secure, 0),
      ]);
    }

    if (method === 'POST' && p.startsWith('/api/')) {
      if (!(request.headers.get('Content-Type') || '').includes('application/json')) {
        return json({ error: 'JSON only' }, 415);
      }
      const cur = await currentUser(env, request);
      if (!cur) return json({ error: 'Not connected' }, 401);
      const { id, u } = cur;

      try {
        if (p === '/api/sync') {
          return json(view(await syncUser(env, id, newBudget(env))));
        }
        if (p === '/api/rescan') {
          // Re-check the whole library for songs missing from the playlist (never removes anything).
          u.backfill = { offset: 0, total: null, topAt: null };
          await env.STORE.put('u:' + id, JSON.stringify(u));
          return json(view(await syncUser(env, id, newBudget(env))));
        }
        if (p === '/api/settings') {
          const body = await request.json().catch(() => ({}));
          if (typeof body.auto === 'boolean') u.auto = body.auto;
          if (typeof body.playlistName === 'string') {
            const name = body.playlistName.trim().slice(0, 100);
            if (name && name !== u.playlistName) {
              u.playlistName = name;
              if (u.playlistId) await spotifyCall(env, id, u, newBudget(env), '/playlists/' + u.playlistId, { method: 'PUT', body: { name } });
            }
          }
          await env.STORE.put('u:' + id, JSON.stringify(u));
          return json(view(u));
        }
        if (p === '/api/disconnect') {
          await env.STORE.delete('u:' + id);
          await env.STORE.delete('s:' + id);
          tokenCache.delete(id);
          return json({ connected: false }, 200, { 'Set-Cookie': cookie('sid', '', secure, 0) });
        }
      } catch (e) {
        console.error(e);
        return json({ error: e.message }, 500);
      }
    }

    return json({ error: 'Not found' }, 404);
  },

  // Cron Trigger: check every connected account for new likes.
  async scheduled(_event, env, ctx) {
    if (!env.STORE || !env.SESSION_SECRET) return;
    const B = newBudget(env);
    const list = await env.STORE.list({ prefix: 'u:' });
    for (const k of list.keys) {
      if (B.left() < 4) break;
      const u = await env.STORE.get(k.name, 'json');
      if (!u || !u.auto || u.needsReauth) continue;
      await syncUser(env, k.name.slice(2), B);
    }
  },
};

/* ---------- the page ---------- */
const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Liked Songs Sync</title>
<style>
  :root {
    --bg: #E8ECF2; --panel: #FFFFFF; --ink: #1B1F3B; --muted: #5A6180; --line: #CBD2E0;
    --green: #0F7B45; --green-dark: #0A5E34; --red: #B3261E;
    --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #14172B; --panel: #1E2340; --ink: #EDEFF8; --muted: #9AA2C4; --line: #353C63; --green: #3DD68C; --green-dark: #66E4A6; --red: #FF8A80; }
  }
  * { box-sizing: border-box; }
  html { padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.55 var(--sans); }
  main { max-width: 560px; margin: 0 auto; padding: 56px 20px 80px; }
  h1 { font: 600 clamp(2rem, 7vw, 2.9rem)/1.1 var(--serif); letter-spacing: -0.01em; margin: 0 0 16px; }
  p { margin: 0 0 24px; color: var(--muted); max-width: 46ch; }
  a { color: var(--green); }
  button, .btn { font: 600 1rem var(--sans); cursor: pointer; border-radius: 999px; padding: 12px 22px; border: 2px solid var(--green); background: var(--green); color: #fff; text-decoration: none; display: inline-block; }
  @media (prefers-color-scheme: dark) { button, .btn { color: #06210F; } }
  button:hover, .btn:hover { background: var(--green-dark); border-color: var(--green-dark); }
  button.ghost, .btn.ghost { background: transparent; color: var(--green); }
  button.ghost:hover, .btn.ghost:hover { background: var(--line); }
  button.link { background: none; border: 0; padding: 0; color: var(--muted); font-weight: 400; text-decoration: underline; border-radius: 0; }
  button.link:hover { background: none; color: var(--ink); }
  button:disabled { opacity: .6; cursor: default; }
  :focus-visible { outline: 3px solid var(--ink); outline-offset: 3px; }
  .who { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 28px; color: var(--muted); font-size: .95rem; }
  .mirror { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 24px; margin-bottom: 20px; }
  .counts { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 0 0 18px; }
  .counts dt { color: var(--muted); font-size: .9rem; overflow-wrap: anywhere; }
  .counts dd { margin: 0; font: 600 2.4rem/1.1 var(--serif); font-variant-numeric: tabular-nums; }
  .bar { height: 10px; border-radius: 999px; background: var(--line); overflow: hidden; }
  .bar span { display: block; height: 100%; width: 0; background: var(--green); }
  @media (prefers-reduced-motion: no-preference) { .bar span { transition: width .6s ease; } }
  .status { margin: 14px 0 0; font-size: .95rem; color: var(--muted); max-width: none; }
  .status.err { color: var(--red); }
  .actions { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 36px; }
  .settings { border-top: 1px solid var(--line); padding-top: 24px; }
  .settings h2 { font: 600 1.15rem var(--serif); margin: 0 0 14px; }
  .row { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 16px; }
  .row input[type=checkbox] { width: 20px; height: 20px; margin-top: 3px; accent-color: var(--green); flex: none; }
  .row small { display: block; color: var(--muted); }
  .name { display: flex; gap: 10px; margin-bottom: 22px; }
  .name input { flex: 1; min-width: 0; font: 1rem var(--sans); padding: 10px 14px; border-radius: 10px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); }
  .name button { padding: 10px 18px; }
  .banner { background: var(--panel); border: 1px solid var(--red); color: var(--red); padding: 12px 16px; border-radius: 10px; margin-bottom: 24px; }
  .setup { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin: 0 0 24px; font-size: .95rem; color: var(--muted); }
  .setup code { overflow-wrap: anywhere; color: var(--ink); }
  .box { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 24px; }
  .box h2 { font: 600 1.15rem var(--serif); margin: 0 0 12px; }
  .box .steps { margin: 0 0 20px; padding-left: 20px; color: var(--muted); font-size: .95rem; }
  .box .steps li { margin-bottom: 6px; }
  .box code { color: var(--ink); overflow-wrap: anywhere; }
  .box label { display: block; font-size: .9rem; color: var(--muted); margin-bottom: 14px; }
  .box input { display: block; width: 100%; margin-top: 4px; font: 1rem var(--sans); padding: 10px 14px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); }
  .box .fine { margin: 14px 0 0; font-size: .85rem; max-width: none; }
  .notice { border: 1px solid var(--red); color: var(--red); border-radius: 10px; padding: 10px 14px; margin-bottom: 18px; font-size: .95rem; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <div id="banner" class="banner" hidden></div>

  <section id="out" hidden>
    <h1>Your liked songs, kept in a playlist.</h1>
    <p>Connect your Spotify once. Your Liked Songs are copied into a playlist, and every new like is added automatically.</p>
    <form class="box" id="connectForm">
      <div class="notice" id="setup" hidden></div>
      <h2>Connect your Spotify</h2>
      <ol class="steps">
        <li>Create an app at <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a>.</li>
        <li>Add this Redirect URI to it: <code id="uri"></code> <button type="button" class="link" id="copyUri">Copy</button></li>
        <li>Under User Management, add your Spotify email.</li>
        <li>Paste the app's Client ID and Client secret below.</li>
      </ol>
      <label>Client ID<input id="cid" autocomplete="off" spellcheck="false" required></label>
      <label>Client secret<input id="csec" type="password" autocomplete="off" spellcheck="false" required></label>
      <button type="submit" id="connectBtn">Connect Spotify</button>
      <p class="fine">Your credentials are stored encrypted so syncing can keep running. Disconnect deletes them.</p>
    </form>
  </section>

  <section id="in" hidden>
    <div class="who">
      <span>Connected as <strong id="who"></strong></span>
      <button class="link" id="disconnect" type="button">Disconnect</button>
    </div>

    <h1 id="headline">Syncing your likes</h1>

    <div class="mirror">
      <dl class="counts">
        <div><dt>Liked Songs</dt><dd id="nLiked">–</dd></div>
        <div><dt id="plName">Playlist</dt><dd id="nPlaylist">–</dd></div>
      </dl>
      <div class="bar" role="img" aria-label="Playlist coverage of liked songs"><span id="fill"></span></div>
      <p class="status" id="status"></p>
    </div>

    <div class="actions">
      <button id="syncNow" type="button">Sync now</button>
      <a class="btn ghost" id="open" target="_blank" rel="noopener" hidden>Open playlist</a>
    </div>

    <div class="settings">
      <h2>Settings</h2>
      <form class="name" id="nameForm">
        <input id="nameInput" maxlength="100" aria-label="Playlist name" required>
        <button class="ghost" type="submit">Rename</button>
      </form>
      <label class="row">
        <input type="checkbox" id="auto">
        <span>Add new likes automatically<small>Runs on the schedule set in Cloudflare (Cron Trigger).</small></span>
      </label>
      <p class="status"><button class="link" id="rescan" type="button">Re-check my whole library</button> for songs missing from the playlist. Nothing is ever removed.</p>
    </div>
  </section>
</main>

<script>
var $ = function (s) { return document.querySelector(s); };
var errors = {
  denied: "Spotify access was declined. Connect again to continue.",
  state: "The login could not be verified. Try connecting again.",
  token: "Spotify did not return a token. Check the client ID, secret and redirect URI.",
  profile: "Spotify did not return your profile. In development mode, add your account under User Management in the Spotify dashboard."
};
var poll = null;

async function api(path, body) {
  var r = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  var j = await r.json().catch(function () { return {}; });
  if (r.status === 401) return { connected: false };
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function ago(ts) {
  var s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  var m = Math.round(s / 60);
  if (m < 60) return m + " min ago";
  var h = Math.round(m / 60);
  return h < 24 ? h + " h ago" : Math.round(h / 24) + " d ago";
}
function n(x) { return Number(x).toLocaleString(); }

function render(s) {
  clearTimeout(poll);
  $("#out").hidden = s.connected;
  $("#in").hidden = !s.connected;

  if (!s.connected) {
    var setup = $("#setup");
    var blocked = !!(s.missing && s.missing.length);
    setup.hidden = !blocked;
    if (blocked) setup.textContent = "Setup needed in Cloudflare: " + s.missing.join(", ") + ". See the README.";
    $("#cid").disabled = blocked;
    $("#csec").disabled = blocked;
    $("#connectBtn").disabled = blocked;
    if (s.redirectUri) $("#uri").textContent = s.redirectUri;
    return;
  }

  $("#who").textContent = s.name;
  $("#plName").textContent = s.playlistName;
  if (document.activeElement !== $("#nameInput")) $("#nameInput").value = s.playlistName;
  $("#auto").checked = s.auto;

  var r = s.lastResult;
  $("#nLiked").textContent = r ? n(r.liked) : "–";
  $("#nPlaylist").textContent = r ? n(r.playlist) : "–";
  $("#fill").style.width = r && r.liked ? Math.min(100, (r.playlist / r.liked) * 100) + "%" : "0%";

  var open = $("#open");
  open.hidden = !s.playlistUrl;
  if (s.playlistUrl) open.href = s.playlistUrl;

  var st = $("#status");
  st.classList.remove("err");
  if (s.needsReauth) {
    st.classList.add("err");
    st.innerHTML = 'Spotify access has expired. <a href="/login">Reconnect</a> to resume syncing.';
    $("#headline").textContent = "Reconnect to keep syncing";
  } else if (s.lastError) {
    st.classList.add("err");
    st.textContent = s.lastError;
    $("#headline").textContent = "Last sync failed";
  } else if (s.backfill) {
    $("#headline").textContent = "Copying your liked songs";
    st.textContent = "Copied " + n(s.backfill.offset) + (s.backfill.total ? " of " + n(s.backfill.total) : "") + " songs. Keep this tab open to finish faster; it also continues on its own.";
    poll = setTimeout(s.running ? refresh : drive, s.running ? 2500 : 600);
  } else if (s.running) {
    st.textContent = "Syncing…";
    $("#headline").textContent = "Syncing your likes";
    poll = setTimeout(refresh, 2500);
  } else if (r) {
    var added = s.lastAdded ? " Last added " + n(s.lastAdded.count) + " song" + (s.lastAdded.count === 1 ? "" : "s") + " " + ago(s.lastAdded.at) + "." : "";
    st.textContent = "Up to date. Checked " + ago(s.lastCheck) + "." + added;
    $("#headline").textContent = "Your playlist is up to date";
  } else {
    st.textContent = "Waiting for the first sync…";
    poll = setTimeout(refresh, 2500);
  }
}

async function refresh() { try { render(await api("/api/status")); } catch (e) { showError(e.message); } }
async function drive() { try { render(await api("/api/sync", {})); } catch (e) { showError(e.message); } }
function showError(msg) { var b = $("#banner"); b.textContent = msg; b.hidden = !msg; }

$("#syncNow").addEventListener("click", async function (e) {
  var btn = e.currentTarget;
  btn.disabled = true; btn.textContent = "Syncing…";
  try { render(await api("/api/sync", {})); } catch (err) { showError(err.message); }
  btn.disabled = false; btn.textContent = "Sync now";
});
$("#auto").addEventListener("change", async function (e) {
  try { render(await api("/api/settings", { auto: e.target.checked })); } catch (err) { showError(err.message); }
});
$("#nameForm").addEventListener("submit", async function (e) {
  e.preventDefault();
  try { render(await api("/api/settings", { playlistName: $("#nameInput").value })); } catch (err) { showError(err.message); }
});
$("#connectForm").addEventListener("submit", async function (e) {
  e.preventDefault();
  var btn = $("#connectBtn");
  btn.disabled = true; btn.textContent = "Opening Spotify…";
  try {
    var r = await api("/api/connect", { clientId: $("#cid").value.trim(), clientSecret: $("#csec").value.trim() });
    location.href = r.url;
  } catch (err) {
    showError(err.message);
    btn.disabled = false; btn.textContent = "Connect Spotify";
  }
});
$("#copyUri").addEventListener("click", function () {
  if (navigator.clipboard) navigator.clipboard.writeText($("#uri").textContent);
  this.textContent = "Copied";
});
$("#rescan").addEventListener("click", async function () {
  try { render(await api("/api/rescan", {})); } catch (err) { showError(err.message); }
});
$("#disconnect").addEventListener("click", async function () {
  if (!confirm("Disconnect Spotify? Automatic syncing stops. The playlist stays in your library.")) return;
  try { render(await api("/api/disconnect", {})); } catch (err) { showError(err.message); }
});

var err = new URLSearchParams(location.search).get("error");
if (err) { showError(errors[err] || "Something went wrong while connecting."); history.replaceState(null, "", "/"); }
refresh();
</script>
</body>
</html>`;
