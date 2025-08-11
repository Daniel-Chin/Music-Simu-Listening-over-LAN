# Music Simu‑Listening over LAN — Concise Design Doc

Drafted by GPT-5.  

## Goal

Multi‑user co‑listening on the same LAN with synchronized
**event‑based** starts (avoid using clocks). Server hosts files and state;
clients on Android phones download full files, cache locally, and play in lockstep at
barrier releases. Anyone can control; race conditions prevented via
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
-   **Client (HTML+JS, mobile‑first):**
    -   Single‑page app with **three tabs**: *Current Song*, *Queue*, *Sharing*.
    -   `<audio>` element playback from **Blob URLs**.
    -   Uses **Cache Storage API** for whole‑file caching; **IndexedDB**
        for light metadata.
    -   Discovers server via QR (URL) + short random code (pairing).

------------------------------------------------------------------------

## Concepts & Invariants

-   **Playlist:** static scan of server directory. Not shown in UI.
-   **Queue:** ordering of playlist; current item highlighted. It is a circular queue. When a
    song finishes, it's appended to the end. 
-   **Event Topology:** all mutating actions increment `eventCount`.
    Clients must include `eventCount` with every command; server rejects
    mismatches.
-   **States:**
    -   `playing from Xsec` (anchorPositionSec set when the event was
        emitted; no live clock kept).
    -   `paused at Ysec`.
    -   More.
-   **Barriers:**
    -   **Track start barrier:** new track starts **only when all
        members of the active set have fully cached the track**.
    -   **Late joiners:** excluded from the already‑released barrier;
        included from the **next** barrier (i.e. next song).

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
        "playState": { "mode": "playing|paused|onBarrier", "anchorPositionSec": 0 },
        "clients": {
            "c1": { "name": "Alice", "lastPingSec": 1723320000, "sse": true, "cachedHeadTrackId": "t123" },
            "c2": { "name": "Bob",   "lastPingSec": 1723320012, "sse": true, "cachedHeadTrackId": null }
        }
    }
}
```

Runtime derived (not persisted or cheaply recomputed): active set = clients where `sse == true` AND `now - lastPingSec <= 6`.

### HTTP Endpoints

-   **UI**
    -   `GET /landing` → webpage of: two input fields (room_code, name). Room code is auto-filled if in URL params. Name is autofilled according to persistent storage.
    -   `GET /` → webpage of: the main UI. 
-   **Discovery & Pairing**
    -   `GET /qr` `{room_code}` → png file of qr code of host url with room code param
    -   `POST /pair` `{room_code, clientName}` →
        `{clientId, eventCount, snapshot}`
-   **Index & Metadata**
    -   `GET /index` → queue index
        `[ {trackId, fileName, size, mime, duration}, ... ]`
    -   `GET /cover/:trackId` → image (if embedded art found)
-   **Files**
    -   `GET /file/:trackId` → full file.
-   **State & SSE**
    -   `GET /snapshot` → full snapshot of state described above
    -   `GET /events` (SSE) → pushes on **state change only**:
        `{event, payload, eventCount}`
    -   `POST /ping` `{clientId}` → updates `lastPingSec`; idempotent, no eventCount header, no SSE broadcast.
-   **Control (all require `If-Match-Event: <eventCount>` header)**
    -   `POST /play` `{positionSec}` → start/resume
    -   `POST /pause` `{positionSec}`
    -   `POST /seek` `{positionSec}` (no barrier; sets new anchor)
    -   `POST /next` `{}`
    -   `POST /prev` `{}`
    -   `POST /nudge` `{trackId}` → move `trackId` to **next-up** position in the queue
    -   `POST /cache-head` `{trackId}` → client asserts: "I have cached this track" This updates only that client's `cachedHeadTrackId`. (Idempotent; rejected if `trackId` != current queue head.)

**Responses:** - `200` on accept → `{eventCount, snapshot}` - `409` on
`eventCount` mismatch → `{expectedEventCount, snapshot}` (client shows
warning and refreshes)

### Barrier & Activity Logic
Each client publishes its *latest cached queue-head track id* via `POST /cache-head` and the server stores it as `clients[clientId].cachedHeadTrackId`.

Simplify: barrier considers only *active* clients.

- **Active set:** clients with open SSE (`sse == true`) AND fresh ping (`now - lastPingSec <= 6`).
- **Primary signal:** SSE close → immediately mark client inactive; re‑evaluate barrier.
- **Heartbeat:** clients `POST /ping` about every ~3 s. If stale (>6 s) treat as inactive.
- **Per‑client cached marker:** a scalar `cachedHeadTrackId` (may be `null` initially). Client sends this only for the **current queue head** (never anticipating the next track) when it finishes fully caching that file.
- **Barrier condition:** Let `H = queue[0]`. If for every active client `cachedHeadTrackId == H`, the barrier is considered satisfied and playback may (a) start that track if in `onBarrier` mode or (b) continue uninterrupted if already started. When the barrier is satisfied, the server changes the playState mode from "onBarrier" to "playing".
- **State changes:** A client updating `cachedHeadTrackId` for the current head triggers evaluation. 
- **Late joiners:** New active clients that haven't reported the current head naturally hold back the release if it hasn't fired yet. If the track is already playing (release already emitted), their `cachedHeadTrackId` is irrelevant for that already-started track; they just attempt to catch up (may hear mid‑track). They begin participating in the *next* head's barrier once that head becomes queue[0].
- **Reconnect flow:** Client reopens SSE, pings, fetches snapshot, and (re)issues `cache-head` for the current head once cached (or after re-downloading). Until then, it's excluded only if release already happened; otherwise it can still delay release.

Rationale: This model removes explicit barrier bookkeeping and racey list mutations; state per client becomes an *idempotent declaration* of the last head they fully possess. The server derives readiness by comparison, enabling simpler recovery and fewer write patterns.

### Persistence

-   Every accepted control event:
    1)  mutate in‑memory state,
    2)  **atomic write** to `STATE_FILE` (write temp + fsync + rename),
    3)  emit SSE with updated `eventCount`.
-   On startup: load state; if corrupt → return 500 on control; log
    "SCREAM" and require manual fix.
-   Client disconnection is detected via **SSE close** OR **heartbeat timeout (no /ping within 6 s)**.

### misc
- Prints the landing page URL (192.168...) on startup.  
- A song reaching its end is a server-initiated event. This is an exception to the "no live clock" principle. 

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
    -   A URL with room code as param, its QR code image, and the room code itself.  
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

### Caching

-   **Policy:** pin **current + next + last 3 played** (5 total).
-   **Budget:** use `navigator.storage.estimate()`; on overflow, evict
    LRU (never evict current/next).
-   **Flow per track:**
    1)  `GET /file/:trackId` (full) → put into `caches.open('audio')`,
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
-   **Auth:** `POST /pair` validates code → issues hard-to-guess `clientId` (opaque
    token in header) (instead of c1, c2).
-   Code rotates on server restart (simple, face‑to‑face assumption).
-   No PII.

------------------------------------------------------------------------

## Testing Hooks

-   `GET /debug/state` (dev‑only) to view JSON.
-   Synthetic client script (optional) to simulate N clients: join,
    download ack, next, seek.

------------------------------------------------------------------------

## Notes / Tradeoffs

-   **Almost no clocks:** start alignment is "event‑receipt synchronous";
    real‑time skew accepted. Audio decoding speed on phone may result in skew when the song is long.  
-   **HTTP‑only:** SSE for broadcast avoids WebSocket complexity; widely
    supported.
-   **Minimal recovery:** restart tolerated; JSON state reload ensures
    continuity.
 -   Heartbeat is intentionally coarse (6 s) to stay battery‑friendly.

------------------------------------------------------------------------
