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

Every user brings their own Spotify app, so there is no shared client ID in the Worker.

1. On the page, the user pastes their app's Client ID and Client secret into the login box. The page shows the
   redirect URI to add to that Spotify app.
2. `POST /api/connect` checks the format, encrypts the secret, and saves both in KV for 15 minutes under a random
   ID. That ID is used as the OAuth `state`, with a signed copy in a short-lived cookie. The browser is sent to Spotify.
3. Spotify sends the browser back to `/callback` with a `code`.
4. The Worker checks that `state` matches the cookie, loads the saved credentials, deletes that temporary record,
   and swaps the `code` for tokens.
5. It reads the Spotify profile, saves the account (with its credentials) in KV, sets a signed session cookie, and
   starts the first sync.

The redirect URI is built from the address the page was opened on, so no base URL setting is needed. Because each
user has their own Spotify app, the 5-user limit of Development Mode applies per person, not to the whole site.

## What is stored

KV holds two keys per account:

- `u:<spotifyId>`: name, playlist ID, playlist name, auto-sync on or off, progress markers, last error, the user's
  Client ID, and two encrypted values: their Client secret and the Spotify refresh token (AES-GCM, key derived
  from `SESSION_SECRET`).
- `s:<spotifyId>`: a list of the song URIs already put in the playlist.

A third, temporary key `p:<id>` holds the credentials for a login in progress and expires after 15 minutes.

Whoever controls the Worker's `SESSION_SECRET` can decrypt these, so only let people use a site whose owner they trust.

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
- **Tokens.** The short-lived access token is cached in memory and refreshed from the stored refresh token, using
  that user's own Client ID and secret. If Spotify rejects the refresh token, the account is marked as needing a
  reconnect and the cron skips it. Reconnecting (`/login`) reuses the saved credentials.
- **No removals.** The sync only adds songs. Unliking a song doesn't remove it from the playlist.

## Routes

| Route | Purpose |
|---|---|
| `GET /` | The page. |
| `GET /api/status` | Current state for the page, or which settings are missing. |
| `POST /api/connect` | Starts a login with the Client ID and secret from the login box. |
| `GET /login` | Reconnects a signed-in user with their saved credentials. |
| `GET /callback` | Where Spotify sends the browser back after login. |
| `POST /api/sync` | Run a sync now. |
| `POST /api/rescan` | Restart the full library check, then sync. |
| `POST /api/settings` | Change auto-sync or the playlist name. |
| `POST /api/disconnect` | Delete the account and its stored data. |

POST routes require a JSON content type. All except `/api/connect` also need a valid session cookie.

## Spotify API notes

- Uses `GET /me/tracks`, `POST /me/playlists`, and `POST/PUT /playlists/{id}/items`. Since February 2026 Spotify
  renamed the older `/tracks` playlist endpoints to `/items`.
- Song objects are read with `track ?? item` so either field name works.
- Apps in Development Mode need the app owner to have Premium and allow 5 users. Each user's own app counts separately.

## Required settings

| Name | Where | What it is |
|---|---|---|
| `STORE` | KV binding | The storage namespace. |
| `SESSION_SECRET` | Secret | Any long random string. Used for cookies and to encrypt stored credentials and tokens. |
| `SUBREQUEST_BUDGET` | Variable, optional | Spotify calls per run. Default 30. |
