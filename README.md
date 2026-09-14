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
