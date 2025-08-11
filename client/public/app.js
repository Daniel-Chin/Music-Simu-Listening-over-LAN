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
  playState: { mode: 'paused', anchorPositionSec: 0, wallTime: 0 },
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
      console.log(`SSE event [${eventCount}]`);
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
    const r = await api('/pause', { room }, true);
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
    const coverUrl = '/cover/' + headId;
    els.cover.src = coverUrl;

    // Inject cover art into currentInfo
    let embedded = els.currentInfo.querySelector('.embedded-cover');
    if (!embedded) {
      embedded = document.createElement('img');
      embedded.className = 'embedded-cover';
      embedded.style.maxWidth = '100%';
      embedded.style.display = 'block';
      embedded.style.marginBottom = '0.5rem';
      els.currentInfo.prepend(embedded);
    }
    if (embedded.src !== location.origin + coverUrl) embedded.src = coverUrl;
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

const formatTime = (t) => {
  const n_secs = Math.round(t);
  const hours = Math.floor(n_secs / 3600);
  const minutes = Math.floor((n_secs % 3600) / 60);
  const seconds = n_secs % 60;
  return `${hours > 0 ? hours + ':' : ''}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

const renderStatus = () => {
  const activeCount = Object.values(state.snapshot.clients || {}).filter(c => c.sse && (Date.now()/1000 - (c.lastPingSec||0) <= 6)).length;
  const head = state.queue[0];
  const readyCount = Object.values(state.snapshot.clients || {}).filter(c => c.sse && c.cachedHeadTrackId === head && (Date.now()/1000 - (c.lastPingSec||0) <= 6)).length;
  if (state.playState.mode === 'onBarrier') {
    const haveHead = head && state.cachedSet.has(head) && !!state.headBlobURL;
    if (haveHead) {
      els.statusLine.textContent = `waiting for others to download... (${readyCount}/${activeCount} ready)`;
    } else {
      els.statusLine.textContent = 'downloading...';
    }
  } else if (state.playState.mode === 'playing') {
    els.statusLine.textContent = `Playing at ${formatTime(els.audio.currentTime)}`;
  } else {
    els.statusLine.textContent = `Paused at ${formatTime(state.playState.anchorPositionSec)}`;
  }
  switch (state.playState.mode) {
    case 'playing':
      playPauseBtn.textContent = '⏸️';
      break;
    case 'paused':
      playPauseBtn.textContent = '▶️';
      break;
    case 'onBarrier':
      playPauseBtn.textContent = '...';
      break;
  }
};

// Audio & caching (IndexedDB instead of Cache Storage)
// DB schema: db 'audio', objectStore 'tracks' (key = trackId, value = Blob)
// We keep LRU-ish set via state.recentLRU plus protect current head & next.
const pinPolicyMax = 5; // current + next + last 3

const fatalIDB = (err) => {
  console.error('FATAL IndexedDB error – cannot proceed with caching', err);
  showBubble('Fatal cache error; reload page.');
  throw err instanceof Error ? err : new Error(String(err));
};

const getDB = (() => {
  let p;
  const open = () => new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open('audio', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('tracks')) db.createObjectStore('tracks');
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          try { db.close(); } catch {}
          p = undefined; // force reopen on next access
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => console.warn('IndexedDB open blocked.');
    } catch (e) {
      reject(e);
    }
  });
  return async (force=false) => {
    if (force) p = undefined;
    if (!p) p = open();
    return p;
  };
})();

const idbGet = async (trackId) => {
  const db = await getDB().catch(fatalIDB);
  return await new Promise((res, rej) => {
    const tx = db.transaction('tracks', 'readonly');
    const store = tx.objectStore('tracks');
    const rq = store.get(trackId);
    rq.onsuccess = () => res(rq.result || null);
    rq.onerror = () => rej(rq.error);
  });
};

const idbPut = async (trackId, blob) => {
  const attempt = async (reopen=false) => {
    const db = await getDB(reopen).catch(fatalIDB);
    return await new Promise((res, rej) => {
      let failedSync = false;
      try {
        const tx = db.transaction('tracks', 'readwrite');
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
        try { tx.objectStore('tracks').put(blob, trackId); }
        catch (e) { failedSync = true; rej(e); }
      } catch (e) {
        if (!failedSync) rej(e);
      }
    });
  };
  try {
    await attempt(false);
  } catch (e) {
    const msg = (e && e.message) || '';
    if (e && (e.name === 'InvalidStateError' || /not allow(ed)? mutations/i.test(msg))) {
      // Retry once after forced reopen
      try {
        await attempt(true);
        return;
      } catch (e2) {
        fatalIDB(e2);
      }
    }
    fatalIDB(e);
  }
};

const idbDelete = async (trackId) => {
  const attempt = async (reopen=false) => {
    const db = await getDB(reopen).catch(fatalIDB);
    return await new Promise((res, rej) => {
      try {
        const tx = db.transaction('tracks', 'readwrite');
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
        try { tx.objectStore('tracks').delete(trackId); }
        catch (e) { rej(e); }
      } catch (e) { rej(e); }
    });
  };
  try {
    await attempt(false);
  } catch (e) {
    const msg = (e && e.message) || '';
    if (e && (e.name === 'InvalidStateError' || /not allow(ed)? mutations/i.test(msg))) {
      try { await attempt(true); return; }
      catch (e2) { fatalIDB(e2); }
    }
    fatalIDB(e);
  }
};

const idbListKeys = async () => {
  const db = await getDB().catch(fatalIDB);
  return await new Promise((res, rej) => {
    const keys = [];
    try {
      const tx = db.transaction('tracks', 'readonly');
      const store = tx.objectStore('tracks');
      const cursorReq = store.openKeyCursor();
      cursorReq.onsuccess = (e) => {
        const c = e.target.result;
        if (c) { keys.push(c.key); c.continue(); } else res(keys);
      };
      cursorReq.onerror = () => rej(cursorReq.error);
    } catch (e) { rej(e); }
  }).catch(fatalIDB);
};

const fetchAndStoreTrack = async (trackId) => {
  const url = `/file/${trackId}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('fetch failed');
  const blob = await resp.blob();
  await idbPut(trackId, blob);
  state.cachedSet.add(trackId);
  return blob;
};

const buildBlobURLForTrack = async (trackId) => {
  let blob = await idbGet(trackId);
  if (!blob) {
    try {
      blob = await fetchAndStoreTrack(trackId);
    } catch (e) {
      showBubble('Network error while fetching audio.');
      throw e;
    }
  } else {
    state.cachedSet.add(trackId);
  }
  return URL.createObjectURL(blob);
};

const evictIfNeeded = async () => {
  try {
    // Skip eviction entirely if unsupported
    if (!(navigator.storage && navigator.storage.estimate)) return;
    const est = await safeStorageEstimate();
    const used = est.usage || 0;
    const quota = est.quota || 0;
    if (quota && used / quota < 0.9) return; // within budget
    const protect = new Set([state.queue[0], state.queue[1], ...state.recentLRU].filter(Boolean));
    const keys = await idbListKeys();
    for (const k of keys) {
      if (!protect.has(k)) {
        await idbDelete(k);
        state.cachedSet.delete(k);
        const est2 = await safeStorageEstimate();
        if ((est2.usage || 0) / (est2.quota || 1) < 0.9) break;
      }
    }
  } catch (e) {
    console.warn('Eviction failed', e);
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

// Safe storage estimate helper (handles browsers without navigator.storage)
const safeStorageEstimate = async () => {
  if (navigator.storage && typeof navigator.storage.estimate === 'function') {
    try {
      return await navigator.storage.estimate();
    } catch {}
  }
  return { usage: 0, quota: 0 };
};
