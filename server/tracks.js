import fs from 'fs';
import path from 'path';
// music-metadata v10+ may drop default export & / or parseFile from core; use namespace import
import * as mm from 'music-metadata';
import mime from 'mime';

const SUPPORTED = new Set(['.mp3','.m4a','.aac','.flac','.ogg','.wav','.opus','.mp4','.m4b']);

export const buildPlaylistIndex = async (audioDir) => {
  const files = fs.readdirSync(audioDir)
    .filter(f => SUPPORTED.has(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const items = [];
  for (const fileName of files) {
    const fpath = path.join(audioDir, fileName);
    const stat = fs.statSync(fpath);
    let meta = {};
    try {
      const buf = fs.readFileSync(fpath);
      meta = await mm.parseBuffer(buf, { mimeType: mime.getType(fpath) || undefined }, { duration: true });
    } catch { /* ignore metadata errors */ }
    const common = meta.common || {};
    const format = meta.format || {};
    items.push({
      trackId: hashId(fileName), // stable id by filename only (simple)
      fileName,
      size: stat.size,
      mime: mime.getType(fpath) || 'application/octet-stream',
      duration: Math.round((format.duration || 0) * 1000) / 1000,
      title: common.title || baseNameNoExt(fileName),
      artist: (common.artist || 'Unknown').toString(),
      album: (common.album || '').toString(),
      hasCover: Array.isArray(common.picture) && common.picture.length > 0,
    });
  }
  return items;
};

const baseNameNoExt = (f) => f.replace(/\.[^.]+$/, '');

// Simple string hash → base36 id (not cryptographic; stable within directory)
export const hashId = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return 't' + h.toString(36);
};
