# Music Simu‑Listening over LAN --- Concise Design Doc

Drafted by GPT-5.  

## Goal

Multi‑user co‑listening on the same LAN with synchronized
**event‑based** starts (no clocks). Server hosts files and state;
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
-   **Client (HTML+JS, mobile‑first):**
    -   Single‑page app with **two tabs**: *Current Song*, *Queue*.
    -   `<audio>` element playback from **Blob URLs**.
    -   Uses **Cache Storage API** for whole‑file caching; **IndexedDB**
        for light metadata.
    -   Discovers server via QR (URL) + short random code (pairing).

------------------------------------------------------------------------

## Concepts & Invariants

-   **Playlist:** static scan of server directory. Not shown in UI.
-   **Queue:** ordering of playlist; current item highlighted. When a
    song finishes, it's appended to the end (circulation).
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
-   TLS optional (self‑signed feasible but expects browser warnings).

### Persistent State (JSON)
A map from room code to room state.

``` json
{
    "rb9ro3": {
        "eventCount": 42,
        "queue": [ "<trackId>", ... ],
        "playState": { "mode": "playing|paused|onBarrier", "anchorPositionSec": 0 },
        "barrier": [["c1", "ok"], ["c2", "downloading"]],
        "clients": { "c1": {"name":"Alice", "addr":["192.168.1.21", 25835]}, "c2": ... }
    }
}
```

### HTTP Endpoints

-   **UI**
    -   `GET /landing` → webpage of: two input fields (room_code, name). Room code is auto-filled if in URL params. Name is autofilled according to persistent storage.
    -   `GET /` → webpage of: the main UI. 
-   **Discovery & Pairing**
    -   `POST /pair` `{room_code, clientName}` →
        `{clientId, eventCount, snapshot}`
-   **Index & Metadata**
    -   `GET /index` → playlist index
        `[ {trackId, fileName, size, mime, duration?, tags?, coverUrl?}, ... ]`
    -   `GET /cover/:trackId` → image (if embedded art found)
-   **Files**
    -   `GET /file/:trackId` → full file.
-   **State & SSE**
    -   `GET /snapshot` → full snapshot of state described above
    -   `GET /events` (SSE) → pushes on **state change only**:
        `{event, payload, eventCount}`
-   **Control (all require `If-Match-Event: <eventCount>` header)**
    -   `POST /play` `{positionSec}` → start/resume
    -   `POST /pause` `{positionSec}`
    -   `POST /seek` `{positionSec}` (no barrier; sets new anchor)
    -   `POST /next` `{}`
    -   `POST /prev` `{}`
    -   `POST /nudge` `{trackId}` → move `trackId` to **next-up**
        position in the queue
    -   `POST /ack-download` `{trackId}` → mark client ready for current
        barrier

**Responses:** - `200` on accept → `{eventCount, snapshot}` - `409` on
`eventCount` mismatch → `{expectedEventCount, snapshot}` (client shows
warning and refreshes)

### Barrier Logic

-   **Active set:** all currently paired clients that haven't
    disconnected (server updates membership on SSE disconnect).
-   **Ready set:** subset of active set that reported full download via
    `/ack-download`.
-   **Release:** when `ready == active`, server emits event
    `barrier.release {trackId}` with new `eventCount`.
-   **Disconnect handling:** if a client disconnects during a barrier,
    server **shrinks active set** and re‑evaluates. 

### Persistence

-   Every accepted control event:
    1)  mutate in‑memory state,
    2)  **atomic write** to `STATE_FILE` (write temp + fsync + rename),
    3)  emit SSE with updated `eventCount`.
-   On startup: load state; if corrupt → return 500 on control; log
    "SCREAM" and require manual fix.
-   Client disconnection is detected via TODO

### misc
- Prints the landing page URL (192.168...) on startup.  
- A song reaching its end is a server-initiated event. This is an exception to the "no live clock" principle. 

------------------------------------------------------------------------

## Client Details

### UI (2 Tabs)

- The song player widget is always present. On top, three possible tabs: current song, queue, and sharing.
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
    -   Capture current `<audio>.currentTime` as `positionSec`,
    -   Send POST with `If-Match-Event`,
    -   On `409`, show bubble "operation ignored becuase we are out-of-sync; refreshing...", then apply
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

-   **No clocks:** start alignment is "event‑receipt synchronous";
    real‑time skew accepted. Audio decoding speed on phone may result in skew when the song is long.  
-   **HTTP‑only:** SSE for broadcast avoids WebSocket complexity; widely
    supported.
-   **Minimal recovery:** restart tolerated; JSON state reload ensures
    continuity.
-   **TLS:** optional; expect warnings with self‑signed on phones.

------------------------------------------------------------------------
