# Liked Songs Sync: how it works

A single Cloudflare Worker (`worker.js`) that keeps a Spotify playlist in sync with your Liked Songs.
It does three jobs: it serves a small web page, it handles the Spotify login, and on a schedule it copies
new likes into the playlist.

## The pieces

| Piece | What it does |
|---|---|
| `fetch()` handler | Answers web requests: the page, the login flow, and the JSON API the page calls. |
| `scheduled()` handler | Runs on the Cron Trigger (every 10 minutes) and syncs every connected account. |
| `syncUser()` | The sync itself. Both handlers call it. |
| KV namespace `STORE` | The only storage. Holds the account, its settings, and the list of synced songs. |
| `HTML` constant | The whole front end (page, styles, script), served at `/`. |

## Login flow

1. `/login` creates a random `state`, stores a signed copy in a short-lived cookie, and redirects to Spotify.
2. Spotify sends the browser back to `/callback` with a `code`.
3. The Worker checks that `state` matches the cookie, then swaps the `code` for tokens.
4. It reads your Spotify profile, saves the account in KV, sets a signed session cookie, and starts the first sync.

The redirect URI is built from the address the page was opened on, so no base URL setting is needed.

## What is stored

KV holds two keys per account:

- `u:<spotifyId>`: name, playlist ID, playlist name, auto-sync on or off, progress markers, last error, and the
  Spotify refresh token. The refresh token is encrypted (AES-GCM, key derived from `SESSION_SECRET`).
- `s:<spotifyId>`: a list of the song URIs already put in the playlist.

The session cookie holds only your Spotify ID plus an HMAC signature, so it can't be forged without `SESSION_SECRET`.

## How a sync works

Spotify returns liked songs newest first, in pages of 50. The sync has two modes:

**Copy everything (first run, or "Re-check my whole library")**
Reads the library page by page from the start, skips songs already in the stored list, and adds the rest to the end
of the playlist. That keeps the playlist in the same order as Liked Songs. When it reaches the last page it
remembers the timestamp of your newest like (`cursorAt`) and switches to the next mode.

**Only new likes (every run after that)**
Reads pages from the newest like and stops as soon as it sees a song liked before `cursorAt`. Anything not in the
stored list is new. New songs are inserted at the top of the playlist, in chunks of 100, in reverse chunk order so
the final order still matches Liked Songs. When nothing changed this costs one request.

Other rules:

- **Request budget.** Cloudflare's free plan allows 50 outgoing requests per run, so each run stops at 30
  (`SUBREQUEST_BUDGET` raises it). A big library is copied over several runs; progress is saved after each one,
  and the page keeps calling `/api/sync` while it is open to finish faster.
- **Lock.** A run sets a 90-second lock on the account so the cron and a button press don't run at the same time.
- **Playlist deleted.** If adding songs returns 404, the playlist ID and stored list are cleared and a new playlist
  is created on the next run.
- **Tokens.** The short-lived access token is cached in memory and refreshed from the stored refresh token. If
  Spotify rejects the refresh token, the account is marked as needing a reconnect and the cron skips it.
- **No removals.** The sync only adds songs. Unliking a song doesn't remove it from the playlist.

## Routes

| Route | Purpose |
|---|---|
| `GET /` | The page. |
| `GET /api/status` | Current state for the page, or which settings are missing. |
| `GET /login`, `GET /callback` | Spotify login. |
| `POST /api/sync` | Run a sync now. |
| `POST /api/rescan` | Restart the full library check, then sync. |
| `POST /api/settings` | Change auto-sync or the playlist name. |
| `POST /api/disconnect` | Delete the account and its stored data. |

POST routes require a JSON content type and a valid session cookie.

## Spotify API notes

- Uses `GET /me/tracks`, `POST /me/playlists`, and `POST/PUT /playlists/{id}/items`. Since February 2026 Spotify
  renamed the older `/tracks` playlist endpoints to `/items`.
- Song objects are read with `track ?? item` so either field name works.
- Apps in Development Mode need the app owner to have Premium and allow 5 users.

## Required settings

| Name | Where | What it is |
|---|---|---|
| `STORE` | KV binding | The storage namespace. |
| `SPOTIFY_CLIENT_ID` | Variable | From your Spotify app. |
| `SPOTIFY_CLIENT_SECRET` | Secret | From your Spotify app. |
| `SESSION_SECRET` | Secret | Any long random string. Used for cookies and encryption. |
| `SUBREQUEST_BUDGET` | Variable, optional | Spotify calls per run. Default 30. |
