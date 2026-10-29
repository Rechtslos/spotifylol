# Liked Songs Sync (Cloudflare Worker)

One file: `worker.js`. It serves the web page, handles the Spotify login, and a Cron Trigger keeps the playlist updated.

## Setup in the Cloudflare dashboard

1. **Workers & Pages → Create → Hello World**, deploy it, then **Edit code**.
2. Replace everything with the contents of `worker.js` and **Deploy**.
3. **Storage & Databases → KV**: create a namespace (any name).
4. Worker **Settings → Bindings → Add → KV namespace**: variable name must be exactly `STORE`.
5. Worker **Settings → Variables and Secrets**: add
   - `SPOTIFY_CLIENT_ID` (text)
   - `SPOTIFY_CLIENT_SECRET` (secret)
   - `SESSION_SECRET` (secret, any long random string)
6. Worker **Settings → Triggers → Cron Triggers**: add `*/10 * * * *` (every 10 minutes).
7. Open your worker URL. The page shows the exact Redirect URI. Add it in the Spotify dashboard
   (developer.spotify.com/dashboard → your app → Settings), and add your Spotify email under **User Management**.
8. Click **Connect Spotify**.

## Notes

- **Free plan:** each run makes at most 30 Spotify calls (Cloudflare allows 50). A big library is copied in batches:
  keep the page open and it finishes on its own, or the cron continues every 10 minutes.
  On the paid plan, add a variable `SUBREQUEST_BUDGET` (for example `500`) to copy everything in one go.
- **Spotify:** Development Mode apps need the app owner to have Premium and allow 5 users.
- This version only adds songs. Songs you unlike stay in the playlist.
- Delete the playlist in Spotify and it is recreated on the next sync.
