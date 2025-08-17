# Music Simu‑Listening over LAN — Concise Design Doc

Drafted by GPT-5.  

## Goal

Multi‑user co‑listening on the same LAN with synchronized
**clock‑based** starts using an NTP‑style session clock. Server hosts files and state;
clients on Android phones download full files, cache locally, and play in lockstep by
arming a future start time. Anyone can control; race conditions prevented via
**eventCount**.

Prioritize simplicity of the implementation.  

------------------------------------------------------------------------

## Architecture

-   **Server (express js):**
    -   HTTP only.
    -   Serves static audio files from a fixed directory.
    -   REST for control commands.
    -   **SSE** (Server‑Sent Events) for state change broadcasts.
    -   Persists global state to JSON on every accepted event
        (context‑managed write).
    -   Detects disconnect via **SSE close + heartbeat timeout**.
    -   Exposes time endpoint `POST /time` for client clock sync.
-   **Client (HTML+JS, mobile‑first):**
    -   Single‑page app with **three tabs**: *Current Song*, *Queue*, *Sharing*.
    -   `<audio>` element playback from **Blob URLs**.
    -   Uses **IndexedDB** for whole‑file caching.
    -   Discovers server via QR (URL) + short random code (pairing).
    -   Maintains a **session clock** (server time estimate) using NTP‑style pings; uses a tiny **PLL** to keep playback locked.

------------------------------------------------------------------------

## Concepts & Invariants

-   **Playlist:** static scan of server directory. Not shown in UI.
-   **Queue:** ordering of playlist; current item highlighted. It is a circular queue. When a
    song finishes, it's appended to the end. 
-   **Event Topology:** all mutating actions increment `eventCount`.
    Clients must include `eventCount` with every command; server rejects
    mismatches. eventCount is mod 2^14.
-   **Session Clock:**
    -   Server time `nowSec = Date.now()/1000`.
    -   Client estimates offset via repeated `POST /time` round‑trips: `offset = serverNow - (t0+t1)/2`.
    -   Filters jitter by picking the minimum RTT sample over a small batch; periodically re‑syncs.
    -   Snapshots/SSE include `serverNowSec` as a hint.
-   **States:**
    -   `playing` with `wallTimeAtSongStart` (WTASS). Position = `sessionNow - WTASS`.
    -   `paused` with `pausedPositionSec`.
    -   `onBarrier` (waiting until all active cached).
    -   `armed` with future `wallTimeAtSongStart` (start at WTASS).
-   **Barriers:**
    -   **Track start barrier:** new track starts only when all
        active clients have fully cached the track. When barrier is satisfied, the server sets mode `armed` and WTASS in the near future (e.g., +1.2 s).
    -   **Late joiners:** excluded from the already‑armed/started song; included for the **next** barrier.

------------------------------------------------------------------------

## Server Details

### Configuration

-   `AUDIO_DIR`: absolute path (constant).
-   `STATE_FILE`: JSON path (constant).

### Persistent State (JSON)
Map: room code → room state. Keep only what we truly need.

``` json
{
    "rb9ro3": {
        "eventCount": 42,
        "queue": ["<trackId>", "..."] ,
        "playState": { 
            "mode": "playing|paused|onBarrier|armed",
            "wallTimeAtSongStart": 1723320000.25,
            "pausedPositionSec": 0
        },
        "clients": {
            "Alice": { "lastPingSec": 1723320000, "cachedHeadTrackId": "t123", "sse": true },
            "Bob": { "lastPingSec": 1723320012, "cachedHeadTrackId": null, "sse": false }
        }
    }
}
```

Runtime derived (not persisted or cheaply recomputed): active set = clients where `sse == true && now - lastPingSec <= 6`.

### HTTP Endpoints

-   **UI**
    -   `GET /landing` → webpage of: two input fields (room_code, name). Room code is auto-filled if in URL params. Name is autofilled according to browser persistent storage.
    -   `GET /` → webpage of: the main UI. 
-   **Discovery & Pairing**
    -   `GET /qr` `{room_code}` → png file of qr code of host url with room code param
-   **Index & Metadata**
    -   `GET /index` → queue index `[ {trackId, fileName, size, mime, duration}, ... ]`
    -   `GET /cover/:trackId` → image (if embedded art found)
-   **Files**
    -   `GET /file/:trackId` → full file.
-   **State & SSE**
    -   `POST /snapshot` → full snapshot of state described above plus `{serverNowSec}`
    -   `GET /events` (SSE) → pushes on **state change only**:
        `{event, payload, eventCount, serverNowSec}`
    -   `POST /ping` `{clientName}` → updates `lastPingSec`
    -   `POST /time` → `{ nowSec }` (server wall time; for NTP‑style sync)
-   **Control (all require `If-Match-Event: <eventCount>` header)**
    -   `POST /play` `{positionSec}` → arms a start in the near future: sets mode `armed` and `wallTimeAtSongStart = now + lead - positionSec`
    -   `POST /pause` → sets mode `paused`, captures `pausedPositionSec`
    -   `POST /seek` `{positionSec}` → re‑arm with new target position (`armed` + future WTASS)
    -   `POST /next` `{}`
    -   `POST /prev` `{}`
    -   `POST /nudge` `{trackId}` → move `trackId` to **next-up** position in the queue
    -   `POST /cache-head` `{trackId}` → client asserts: "I have cached this track" (idempotent; rejected if `trackId` != head)

**Responses:** - `200` on accept → `{eventCount, snapshot}` - `409` on
`eventCount` mismatch → `{expectedEventCount, snapshot}`

### Barrier & Activity Logic
Each client publishes its *latest cached queue-head track id* via `POST /cache-head` and the server stores it as `clients[clientName].cachedHeadTrackId`.

Simplify: barrier considers only *active* clients.

- **Active set:** clients with open SSE (`sse == true`) AND fresh ping (`now - lastPingSec <= 6`).
- **Primary signal:** SSE close → immediately mark client inactive; re‑evaluate barrier.
- **Barrier condition:** all active have `cachedHeadTrackId == queue[0]`.
- **Release:** When barrier becomes satisfied and mode is `onBarrier`, set mode `armed` and `wallTimeAtSongStart = now + leadSec` (e.g., 1.2 s). Clients start at WTASS.
- **Late joiners:** if a track is already `armed` or `playing`, they don't affect it; they participate from the next head.

### Persistence

-   Every accepted control event:
    1)  mutate in‑memory state,
    2)  **atomic write** to `STATE_FILE`,
    3)  emit SSE with updated `eventCount` and `serverNowSec`.
-   On startup: load state; if corrupt, fatal error. Then, rotate queue against playlist head if possible; null all cachedHeadTrackId. Then, increment `eventCount`.  

### Client PLL and Playback

-   The client keeps a session clock: `sessionNow = Date.now()/1000 + offsetSec`.
-   Desired position: 
    -   If `armed`/`playing`: `desired = sessionNow - wallTimeAtSongStart`.
    -   If `paused`: `desired = pausedPositionSec`.
-   Control loop (every ~250 ms):
    -   If `armed` and desired < 0 → pause.
    -   If `armed` and desired >= 0 → ensure playing.
    -   Error `e = desired - audio.currentTime`.
    -   If `|e| > 0.30` → hard seek to `desired`, set `playbackRate=1.0`.
    -   Else → `playbackRate = clamp(1 + Kp * e, 0.97, 1.03)` with small `Kp` (e.g., 0.02).

### misc
- Prints the landing page URL (192.168...) on startup.  
- A song reaching its end is a client-initiated event.
- Manage deps with npm.
  - express
  - music-metadata
  - mime
  - nanoid
  - qrcode

------------------------------------------------------------------------

## Client Details

### UI (3 Tabs)

- The song player widget is always present. On top, three tabs: current song, queue, and sharing.
- **song player**
    -   Title/artist.
    -   Buttons: **Play/Pause**, **Seek bar**, **Next**.
    -   warning bubbles for rejected commands.
- **Current Song**
    -   Cover.
    -   Status line:
        -   "downloading X%"
        -   "waiting for others to download (a/b ready)"
- **sharing**
    -   A URL to "/" (not landing!) with room code as param, its QR code image, and the room code itself.  
- **Queue**
    -   Simple list in play order; current highlighted, next-up pinned.
    -   Each row: title/artist · duration · **Nudge to next-up**.
    -   Pull‑to‑refresh (optional).
- Use plain js.  

### Networking

-   **SSE** connect on load; apply diffs on messages.
-   On user command:
    -   Send POST with `If-Match-Event`,
    -   On `409`, show bubble "operation ignored because we are out-of-sync; refreshing...", then apply
        server `snapshot`. Do not auto re-send the ignored request.

### Song caching

-   **Policy:** pin **current + next + last 3 played** (5 total).
-   **Budget:** use `navigator.storage.estimate()`; on overflow, evict
    LRU (never evict current/next). For insecure HTTP, skip this.
-   **Flow per track:**
    1)  `GET /file/:trackId` (full) → put into IndexedDB.  
    2)  create Blob URL for `<audio>` source,
    3)  on `ended`, rotate queue; prefetch next.
-   **Nudge effect:** immediately trigger (re)prefetch of new next‑up.

### Metadata

-   Prefer server‑extracted tags; fallback to file name.
-   Duration: read once via `<audio preload='metadata'>` if not
    provided; store in IndexedDB.

### Error Handling (client)

-   Unsupported format: bubble "Format not supported. Skipping...";
    **Next** remains available.
-   Network errors: bubble + console.log; auto‑retry index/snapshot; do
    **not** auto‑retry file fetches aggressively.
-   QuotaExceeded: evict LRU then retry once.

------------------------------------------------------------------------

## Security & Pairing

-   **Room code** six characters.
-   The browser persistently stores clientName. If these entries are not found when loading "/", go to "/landing".
-   No PII.

------------------------------------------------------------------------

## Testing Hooks

-   `GET /debug/state` (dev‑only) to view JSON.
-   Synthetic client script (optional) to simulate N clients: join,
    download ack, next, seek.

------------------------------------------------------------------------

## Notes / Tradeoffs

-   **HTTP‑only:** SSE for broadcast avoids WebSocket complexity; widely
    supported.
-   **Minimal recovery:** restart tolerated; JSON state reload ensures
    continuity.
 -   Heartbeat is intentionally coarse (6 s) to stay battery‑friendly.

------------------------------------------------------------------------
