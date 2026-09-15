# MarkTV

MarkTV is a private, local programming manager for linear television channels. It catalogs local media metadata, builds deterministic daily schedules, previews an EPG, exports stable JSON artifacts, and can safely plan a Tunarr lineup sync. Tunarr—not MarkTV—owns playback, FFmpeg processing, transcoding, HLS, tuner emulation, and client guide delivery.

## Quick start

MarkTV requires Node.js 22 or newer.

```sh
npm install
npm run dev
```

Development starts the Fastify API at `http://127.0.0.1:4177` and the Vite UI at `http://127.0.0.1:5173`; Vite proxies `/api` to Fastify. Both processes stop together with Ctrl-C.

For the single-process production build:

```sh
npm run build
npm start
```

Open `http://127.0.0.1:4177`. A fresh data directory seeds fictional **MarkTV Laughs**, channel 7. Its placeholder media works for preview but is not eligible for Tunarr sync.

## Verification

```sh
npm test
npm run lint
npm run typecheck
npm run build
npm run test:browser
```

Runtime configuration uses `MARKTV_DATA_DIR` (default `./data`), `MARKTV_HOST` (default `127.0.0.1`), and `MARKTV_PORT` (default `4177`). Keep the host on loopback: the MVP has no authentication and is not designed for internet exposure.

See [installation](docs/INSTALL.md), [channel and media configuration](docs/CONFIGURATION.md), and [safe Tunarr integration](docs/TUNARR.md).

## Acquisition: Wanted list and provider integrations

The Wanted page tracks episodes MarkTV should acquire. The Integrations page
connects Real-Debrid or TorBox. Acquisition is local-only and manual: MarkTV
never searches for torrents by itself, picks sources for you, submits magnets,
scrapes Stremio, or deletes remote files.

### Local-only loopback rule

MarkTV has no login screen, so it only listens on a loopback address. Keep
`MARKTV_HOST` set to `127.0.0.1` (or `::1` / `localhost`) and open the UI on
that same computer. Do not bind it to `0.0.0.0`, a LAN address, or a public
address, and do not expose it to the internet. Server routes that handle
credentials and files require a loopback bind and refuse to start otherwise.

### Provider tokens stay in the Keychain

Enter provider tokens only in the Integrations page in the MarkTV UI. Tokens
are stored in the operating-system Keychain (macOS `/usr/bin/security`) and
are never shown again after saving: the UI shows only connected or not
connected plus a safe account label. Never paste a token into chat, a config
file, an environment variable, a command line, or the SQLite database, and
never share logs containing token values. Token input travels over standard
input, never as a command argument, and error messages are redacted so they
never carry credential-bearing URLs.

### Managed Inbox and library paths

Acquisition uses two managed folders under your data directory
(`MARKTV_DATA_DIR`, default `./data`):

- Inbox: `<MARKTV_DATA_DIR>/inbox` holds downloads while they are in flight.
- Library: `<MARKTV_DATA_DIR>/library` holds finished, verified files and is
  registered as the managed library root.

MarkTV creates both folders with owner-only permissions when they are
missing, resolves their real paths, and rejects replacements that are
symlinks or plain files. Point your media scanning at the library folder, not
the inbox.

### Finding an episode with Stremio (manual exact search)

MarkTV does not search for you. To match an episode:

1. Add the episode on the Wanted page with its series title, season, and
   episode number.
2. Click the "Open in Stremio" link for that episode. It opens an exact
   Stremio search for that series, season, and episode.
3. In Stremio, pick the source you want and add it to Real-Debrid or TorBox
   yourself.
4. Return to MarkTV and use polling below to check the provider for the
   finished file. MarkTV matches only exact season/episode results and the
   quality rules you configured; anything ambiguous goes to Needs review
   instead of guessing.

### Polling, retry, cancel, and retained partials

The Wanted page polls each provider for finished files, and each attempt is
bounded: temporary failures are retried at most three times with bounded
backoff, and provider links are refreshed when they expire. Each acquisition
job offers Retry job and Cancel job buttons. Retry queues the job again;
cancel stops local work and marks cancellation.

While downloading, data streams to a retained `<job-id>.part` file in the
inbox, using a non-video temporary name. Progress is persisted as it arrives.
Cancel keeps the partial file so a later retry can resume it. Resume only
happens when the server answers with a valid resume response; otherwise the
partial restarts safely instead of appending corrupt bytes. Free disk space is
checked immediately before starting a download.

### Season packs: revalidation, free space, and no clobber

A provider sometimes offers a whole season as one pack. The Wanted page lists
these under "Season packs" with a preview of the recognized episodes and the
total bytes required. Import season rechecks two things right before doing
anything: that enough free space exists, and that none of the files is a
duplicate of something already imported. It imports only the recognized
episode files, never changes the remote pack, and never overwrites a finished
file: publishing uses an atomic no-clobber step, and any conflicting final
file sends the entry to Needs review instead of overwriting. A completed
import is recorded in a ledger so it can never be imported twice.

### Live verification gate and manual steps after entering tokens

Entering a token does not verify anything by itself. After you enter a token
directly in MarkTV on the Integrations page, complete these live checks
manually before relying on acquisition:

1. Click "Save token" for the provider, then click "Test connection" and
   confirm it reports connected.
2. Add one wanted episode, use its Stremio link to place the source with the
   provider yourself, then poll and confirm the entry leaves the waiting
   state.
3. Confirm the finished file lands in `<MARKTV_DATA_DIR>/library`, passes
   verification, and appears in the Library view.
4. Confirm a cancelled job keeps its `.part` file and a retried job resumes
   or restarts cleanly.

Until all four steps pass against the real provider you configured, treat
acquisition as unverified: entries may sit in waiting, retry-wait, or Needs
review, which is the safe behavior, not a failure.
