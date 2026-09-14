# Installing and running MarkTV

## Requirements

- macOS or another environment capable of running Node.js 22 or newer.
- npm, supplied with Node.
- Optional: `ffprobe` for automatic duration inspection. On macOS, install it with `brew install ffmpeg`. MarkTV invokes `ffprobe` only to read duration; it never transcodes or plays media.

Confirm the runtime with `node --version`, then install dependencies with `npm install`.

## Development

Run `npm run dev`. This launches the API on `127.0.0.1:4177` and Vite on `127.0.0.1:5173`. Open `http://127.0.0.1:5173`. Ctrl-C shuts down both child processes. Set `MARKTV_VITE_PORT` only when the development UI port must change.

## Production-style local run

Run `npm run build`, then `npm start`, and open `http://127.0.0.1:4177`. One Fastify process serves both the built UI and `/api/v1` routes.

Supported environment variables:

- `MARKTV_DATA_DIR`: database and export directory; defaults to `./data`.
- `MARKTV_HOST`: listening interface; defaults to `127.0.0.1`. Do not expose this unauthenticated MVP to a LAN or the internet.
- `MARKTV_PORT`: API and production UI port; defaults to `4177`.
- `MARKTV_VITE_PORT`: development UI port; defaults to `5173`.

## Data and backups

Stop MarkTV before copying its data directory. Back up the complete directory, including `marktv.sqlite` and `exports/`. Restore by placing the backup at the same path and starting with `MARKTV_DATA_DIR` pointed there. Generated `data/`, build output, test results, and Playwright artifacts are ignored by Git.

If startup fails, check that the selected ports are unused, the data directory is writable, Node is version 22+, and `npm run typecheck` plus `npm run build` pass. A missing `ffprobe` is not a startup failure; affected media is reported as missing duration and remains unavailable for scheduling until repaired.
