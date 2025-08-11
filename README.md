# Music Simu‑Listening over LAN

Multi-user co-listening app over a local network with event-based sync and barrier release.
This repo contains:
- `server/` Express HTTP server (SSE, REST, static audio, JSON persistence).
- `client/` Mobile-first single-page app (HTML + JS + Cache Storage + IndexedDB).

## Quick start

1. Put some audio files (mp3/m4a/flac/ogg) into a folder on this machine.
2. Set environment vars or edit `server/config.js`:
   - `AUDIO_DIR` absolute path to your audio folder
   - `STATE_FILE` persistent JSON path (default `./state.json` under server/)
3. Install and start:

```bash
npm install
npm run dev
```

4. On startup the server prints a LAN URL like `http://192.168.1.42:3000/landing?room=xxxxxx`.
   Open it on your phone(s), enter a name, and pair.
5. The client caches audio and waits at barriers until all *active* listeners are ready.

## Notes
- Barrier considers only *active* clients: SSE open and ping within 6 seconds.
- `eventCount` is checked via `If-Match-Event` header on mutating endpoints.
- Server writes state atomically (temp+fsync+rename) on accepted events.
- Server is HTTP-only; broadcast via SSE on state changes.
- Covers are extracted if embedded art exists.
- Dev-only endpoint: `/debug/state` dumps JSON.
