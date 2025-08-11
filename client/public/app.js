// SPA client: tabs, SSE, caching, queue, controls
const qs = new URLSearchParams(location.search);
const room = qs.get('room') || localStorage.getItem('room') || '';
const clientId = localStorage.getItem('clientId') || '';
const clientName = localStorage.getItem('clientName') || '';
if (!room || !clientId) location.href = '/landing?room=' + encodeURIComponent(room || '');

const state = {
  eventCount: 0,
  snapshot: null,
  index: [],
  queue: [],
  playState: { mode: 'paused', anchorPositionSec: 0 },
  headBlobURL: null,
  nextBlobURL: null,
  currentTrackId: null,
  cachedSet: new Set(),  // trackIds we hold (in Cache Storage)
  recentLRU: [],         // last 3 played
};

const els = {
  roomLabel: document.getElementById('room-label'),
  cover: document.getElementById('cover'),
  title: document.getElementById('title'),
  artist: document.getElementById('artist'),
  audio: document.getElementById('audio'),
  playPauseBtn: document.getElementById('playPauseBtn'),
  nextBtn: document.getElementById('nextBtn'),
  prevBtn: document.getElementById('prevBtn'),
  seek: document.getElementById('seek'),
  statusLine: document.getElementById('statusLine'),
  queueList: document.getElementById('queue-list'),
  bubble: document.getElementById('bubble'),
  currentInfo: document.getElementById('current-info'),
  shareUrl: document.getElementById('share-url'),
  qrImg: document.getElementById('qr-img'),
  roomCode: document.getElementById('room-code'),
};

els.roomLabel.textContent = room;
els.shareUrl.textContent = location.origin + '/?room=' + room;
els.qrImg.src = '/qr?room_code=' + encodeURIComponent(room);
els.roomCode.textContent = 'Code: ' + room;

// Tabs
document.querySelectorAll('.tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// UI helpers
const showBubble = (msg) => {
  els.bubble.textContent = msg;
  els.bubble.classList.remove('hidden');
  setTimeout(() => els.bubble.classList.add('hidden'), 2500);
};
const findIndexItem = (trackId) => state.index.find(x => x.trackId === trackId) || null;

// Networking primitives
const api = async (path, body, requireEventHeader=false) => {
  const headers = { 'Content-Type': 'application/json' };
  if (requireEventHeader) headers['If-Match-Event'] = String(state.eventCount);
  const r = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  if (r.status === 409) {
    const data = await r.json();
    state.eventCount = data.expectedEventCount;
    applySnapshot(data.snapshot);
    showBubble('Out-of-sync; refreshed.');
    return null;
  }
  return await r.json();
};

// Snapshot + events
const applySnapshot = (snap) => {
  if (!snap) return;
  state.snapshot = snap;
  state.eventCount = snap.eventCount;
  state.queue = snap.queue.slice();
  state.index = snap.index.slice();
  state.playState = snap.playState;
  render();
  maybePrefetchHeadAndNext().catch(console.error);
};

const connectSSE = () => {
  const url = new URL('/events', location.origin);
  url.searchParams.set('room', room);
  url.searchParams.set('clientId', clientId);
  const es = new EventSource(url.toString());
  es.onmessage = (e) => {
    try {
      const { event, payload, eventCount } = JSON.parse(e.data);
      if (event === 'state' && payload) {
        applySnapshot(payload);
      }
    } catch {}
  };
  es.onerror = () => {
    // Auto reconnect by EventSource; nothing else
  };
};

// Ping heartbeat
setInterval(() => {
  fetch('/ping', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, room }),
  }).catch(()=>{});
}, 3000);

// Initial snapshot
fetch('/snapshot?room=' + encodeURIComponent(room))
  .then(r => r.json())
  .then(applySnapshot)
  .then(connectSSE);

// Controls
els.playPauseBtn.addEventListener('click', async () => {
  const pos = els.audio.currentTime || 0;
  if (state.playState.mode === 'playing') {
    const r = await api('/pause', { room, positionSec: pos }, true);
    if (r) applySnapshot(r.snapshot);
  } else {
    const r = await api('/play', { room, positionSec: pos }, true);
    if (r) applySnapshot(r.snapshot);
  }
});
els.nextBtn.addEventListener('click', async () => {
  const r = await api('/next', { room }, true);
  if (r) applySnapshot(r.snapshot);
});
els.prevBtn.addEventListener('click', async () => {
  const r = await api('/prev', { room }, true);
  if (r) applySnapshot(r.snapshot);
});
els.seek.addEventListener('input', (e) => {
  const dur = Math.max(1, els.audio.duration || 1);
  const newPos = dur * (Number(e.target.value) / 100);
  els.audio.currentTime = newPos;
});
els.seek.addEventListener('change', async () => {
  const pos = els.audio.currentTime || 0;
  const r = await api('/seek', { room, positionSec: pos }, true);
  if (r) applySnapshot(r.snapshot);
});

// Rendering
const render = () => {
  const headId = state.queue[0];
  const item = findIndexItem(headId);
  if (item) {
    els.title.textContent = item.title || item.fileName;
    els.artist.textContent = item.artist || 'Unknown';
    els.cover.src = '/cover/' + headId;
  }
  renderQueue();
  renderStatus();
};

const renderQueue = () => {
  els.queueList.innerHTML = '';
  state.queue.forEach((trackId, i) => {
    const it = findIndexItem(trackId);
    const li = document.createElement('li');
    const left = document.createElement('div');
    left.textContent = `${i===0?'▶ ':'  '}${(it?.title)||'Unknown'} · ${(it?.artist)||''} · ${(it?.duration||0).toFixed(0)}s`;
    li.appendChild(left);
    const btn = document.createElement('button');
    btn.textContent = 'Nudge next-up';
    btn.disabled = i === 0;
    btn.addEventListener('click', async () => {
      const r = await api('/nudge', { room, trackId }, true);
      if (r) applySnapshot(r.snapshot);
    });
    li.appendChild(btn);
    els.queueList.appendChild(li);
  });
};

const renderStatus = () => {
  const activeCount = Object.values(state.snapshot.clients || {}).filter(c => c.sse && (Date.now()/1000 - (c.lastPingSec||0) <= 6)).length;
  const head = state.queue[0];
  const readyCount = Object.values(state.snapshot.clients || {}).filter(c => c.sse && c.cachedHeadTrackId === head && (Date.now()/1000 - (c.lastPingSec||0) <= 6)).length;
  if (state.playState.mode === 'onBarrier') {
    els.statusLine.textContent = `waiting for others to download (${readyCount}/${activeCount} ready)`;
  } else if (state.playState.mode === 'playing') {
    const pct = els.audio.duration ? Math.round(els.audio.currentTime / els.audio.duration * 100) : 0;
    els.statusLine.textContent = `playing… ${pct}%`;
  } else {
    els.statusLine.textContent = `paused at ${Math.round(state.playState.anchorPositionSec)}s`;
  }
};

// Audio & caching
const cacheName = 'audio';
const pinPolicyMax = 5; // current + next + last 3

const ensureCache = async () => await caches.open(cacheName);

const fetchAndCacheTrack = async (trackId) => {
  const cache = await ensureCache();
  const url = `/file/${trackId}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('fetch failed');
  await cache.put(url, resp.clone());
  state.cachedSet.add(trackId);
  return await resp.blob();
};

const buildBlobURLForTrack = async (trackId) => {
  const cache = await ensureCache();
  const url = `/file/${trackId}`;
  let resp = await cache.match(url);
  if (!resp) {
    try {
      resp = await fetch(url);
      if (!resp.ok) throw 0;
      await cache.put(url, resp.clone());
      state.cachedSet.add(trackId);
    } catch (e) {
      showBubble('Network error while fetching audio.');
      throw e;
    }
  }
  const blob = await resp.blob();
  return URL.createObjectURL(blob);
};

const evictIfNeeded = async () => {
  const est = await navigator.storage.estimate();
  const used = est.usage || 0;
  const quota = est.quota || 0;
  if (used / quota < 0.9) return; // ok
  const protect = new Set([state.queue[0], state.queue[1]].filter(Boolean));
  const victims = state.recentLRU.filter(x => !protect.has(x));
  const cache = await ensureCache();
  for (const tid of victims) {
    await cache.delete(`/file/${tid}`);
    state.cachedSet.delete(tid);
    if ((await navigator.storage.estimate()).usage / (await navigator.storage.estimate()).quota < 0.9) break;
  }
};

const maybePrefetchHeadAndNext = async () => {
  try {
    const head = state.queue[0];
    const next = state.queue[1];
    if (!head) return;
    // Build blob URL for head
    const headURL = await buildBlobURLForTrack(head);
    if (state.headBlobURL) URL.revokeObjectURL(state.headBlobURL);
    state.headBlobURL = headURL;
    els.audio.src = headURL;

    // Preload metadata if duration missing
    if (!findIndexItem(head)?.duration) {
      const tmp = document.createElement('audio');
      tmp.preload = 'metadata';
      tmp.src = headURL;
      tmp.onloadedmetadata = () => { /* metadata learned implicitly */ };
    }

    // When finished caching head, assert cache-head
    await fetch('/cache-head', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room, clientId, trackId: head }),
    });

    // Pre-fetch next
    if (next) {
      await buildBlobURLForTrack(next);
    }
    await evictIfNeeded();

    // Apply play/paused state anchor
    if (state.playState.mode === 'playing') {
      els.audio.currentTime = state.playState.anchorPositionSec || 0;
      els.audio.play().catch(()=>{});
    } else if (state.playState.mode === 'paused') {
      els.audio.currentTime = state.playState.anchorPositionSec || 0;
      els.audio.pause();
    } else if (state.playState.mode === 'onBarrier') {
      els.audio.pause();
    }
  } catch (e) {
    console.error(e);
  }
};

// On track end: rotate queue locally and request /next (server-initiated event is the source of truth)
els.audio.addEventListener('ended', async () => {
  // Optimistic UI: request next
  const r = await api('/next', { room }, true);
  if (r) applySnapshot(r.snapshot);
  // Record LRU
  if (state.queue.length) {
    const finished = state.queue[0];
    state.recentLRU.unshift(finished);
    state.recentLRU = Array.from(new Set(state.recentLRU)).slice(0, 3);
  }
});

// Keep seek bar in sync
setInterval(() => {
  const dur = els.audio.duration || 0;
  const cur = els.audio.currentTime || 0;
  if (dur > 0) els.seek.value = String(Math.round(cur / dur * 100));
  renderStatus();
}, 500);
