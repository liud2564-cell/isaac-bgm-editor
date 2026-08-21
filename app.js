// Isaac BGM Editor - Web Version (fully client-side)
// Audio: ffmpeg.wasm (44100Hz vorbis) | Pack: JSZip | XML: vanilla template patch

let TRACKS = [];        // track metadata from tracks.json
let BOSS_IDS = [];      // boss track ids (follow track 9)
const changes = {};     // trackId -> {file: File, url: blobURL, name: string}
let MUSIC_TEMPLATE = ''; // vanilla music.xml text (fetched)

const GROUPS = {
  floors: '楼层 BGM',
  boss: 'Boss 战',
  rooms: '特殊房间',
  misc: '界面/过场/其他',
};

// ---------- init ----------
async function init() {
  const [tracksRes, tplRes] = await Promise.all([
    fetch('tracks.json'),
    fetch('music_template.xml'),
  ]);
  const data = await tracksRes.json();
  TRACKS = data.tracks;
  BOSS_IDS = data.bossIds;
  MUSIC_TEMPLATE = await tplRes.text();
  render();
  document.getElementById('status').textContent =
    `${TRACKS.length} 个场景 · 改完点右上角生成`;
}

// ---------- ffmpeg.wasm (lazy load, files hosted locally) ----------
let ffmpeg = null;
let ffmpegLoading = null;

async function loadFFmpeg() {
  if (ffmpeg) return ffmpeg;
  if (ffmpegLoading) return ffmpegLoading;
  const st = document.getElementById('ffStatus');
  st.textContent = '转码引擎：加载中（约32MB，仅首次）…';
  ffmpegLoading = (async () => {
    const { FFmpeg } = FFmpegWASM;
    const { toBlobURL } = FFmpegUtil;
    const ff = new FFmpeg();
    const baseURL = 'ffmpeg/';
    await ff.load({
      coreURL: await toBlobURL(`${baseURL}ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}ffmpeg-core.wasm`, 'application/wasm'),
    });
    ffmpeg = ff;
    st.textContent = '转码引擎：就绪';
    return ff;
  })();
  return ffmpegLoading;
}

// convert any audio file to game-compatible ogg (44100Hz vorbis)
async function convertToOgg(file) {
  const ff = await loadFFmpeg();
  const inName = 'in_' + file.name.replace(/[^\w.-]/g, '_');
  const outName = 'out.ogg';
  await ff.writeFile(inName, await FFmpegUtil.fetchFile(file));
  await ff.exec(['-y', '-i', inName, '-vn', '-c:a', 'libvorbis',
                 '-ar', '44100', '-q:a', '6', outName]);
  const data = await ff.readFile(outName);
  await ff.deleteFile(inName);
  await ff.deleteFile(outName);
  const blob = new Blob([data.buffer], { type: 'audio/ogg' });
  if (blob.size < 1000) throw new Error('convert failed');
  return blob;
}

// ---------- UI ----------
function fmtDur(s) {
  if (!s) return '';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function render() {
  const main = document.getElementById('main');
  main.innerHTML = '';
  const q = document.getElementById('search').value.toLowerCase();
  for (const [gkey, gname] of Object.entries(GROUPS)) {
    const items = TRACKS.filter(t => t.group === gkey &&
      (!q || (t.name + ' ' + t.cn + ' ' + t.id).toLowerCase().includes(q)));
    if (!items.length) continue;
    const sec = document.createElement('div');
    sec.className = 'section';
    sec.innerHTML = `<h2>${gname} (${items.length})</h2>`;
    const cards = document.createElement('div');
    cards.className = 'cards';
    for (const t of items) {
      const ch = changes[t.id];
      const card = document.createElement('div');
      card.className = 'card' + (ch ? ' modified' : '');
      const isBossLinked = BOSS_IDS.includes(t.id);
      card.innerHTML = `
        <div class="head">
          <span class="name">${t.cn || t.name}${t.cn ? ` <span class="badge">${t.name}</span>` : ''}</span>
          <span class="dur">${ch ? fmtDur(ch.dur || 0) : (t.dur ? fmtDur(t.dur) : '')}</span>
        </div>
        <div class="cur">🎵 ${ch ? ch.name : (t.path || '无')}${isBossLinked && !ch ? ' <span class="badge">Boss联动</span>' : ''}</div>
        ${ch ? `<audio controls preload="metadata" src="${ch.url}"></audio>` : ''}
        <div class="row">
          <button class="btn orange" onclick="pickFile('${t.id}')">📁 导入音乐</button>
          <input type="file" id="file_${t.id}" accept="audio/*" style="display:none"
                 onchange="uploadTo('${t.id}', this.files[0], this)">
          ${ch ? `<button class="btn" onclick="resetOne('${t.id}')">↩ 还原</button>` : ''}
        </div>`;
      cards.appendChild(card);
    }
    sec.appendChild(cards);
    main.appendChild(sec);
  }
  const n = Object.keys(changes).length;
  document.getElementById('genBtn').disabled = n === 0;
  document.getElementById('genBtn').textContent = n ? `生成 Mod 下载 (${n})` : '生成 Mod 下载';
}

function pickFile(id) {
  document.getElementById('file_' + id).click();
}

function resetOne(id) {
  const ch = changes[id];
  if (ch && ch.url) URL.revokeObjectURL(ch.url);
  delete changes[id];
  render();
}

async function uploadTo(id, file, input) {
  if (!file) return;
  input.value = '';
  const busy = document.getElementById('busy');
  const bt = document.getElementById('busyText');
  busy.style.display = 'flex';
  try {
    bt.textContent = `转码中：${file.name}\n(首次需加载引擎约30MB)`;
    const blob = await convertToOgg(file);
    const url = URL.createObjectURL(blob);
    if (changes[id] && changes[id].url) URL.revokeObjectURL(changes[id].url);
    changes[id] = { blob, url, name: file.name, dur: await probeDuration(url) };
    toast('已导入：' + file.name);
  } catch (e) {
    toast('导入失败：' + e.message);
  }
  busy.style.display = 'none';
  render();
}

function probeDuration(url) {
  return new Promise(resolve => {
    const a = new Audio();
    a.preload = 'metadata';
    a.onloadedmetadata = () => resolve(a.duration || 0);
    a.onerror = () => resolve(0);
    a.src = url;
  });
}

// ---------- music.xml patch (proven vanilla-template approach) ----------
function findTrackElement(text, tid) {
  const start = text.indexOf(`<track id="${tid}"`);
  if (start < 0) return null;
  let i = start, depth = 0;
  while (i < text.length) {
    if (text.startsWith('<track ', i)) {
      depth++;
      const j = text.indexOf('>', i);
      if (j < 0) return null;
      if (text[j - 1] === '/') {
        depth--;
        if (depth === 0) return [start, j + 1];
      }
      i = j + 1;
      continue;
    }
    if (text.startsWith('</track>', i)) {
      depth--;
      if (depth === 0) return [start, i + 8];
      i += 8;
      continue;
    }
    i++;
  }
  return null;
}

function buildMusicXml() {
  let s = MUSIC_TEMPLATE;
  const edits = [];
  for (const [tid, ch] of Object.entries(changes)) {
    const rng = findTrackElement(s, tid);
    if (!rng) continue;
    const el = s.slice(rng[0], rng[1]);
    const name = (el.match(/name="([^"]*)"/) || [])[1] || '';
    edits.push([rng[0], rng[1],
      `<track id="${tid}" name="${name}" path="track_${tid}.ogg" loop="true" />`]);
  }
  // boss follow: if track 9 changed, all boss ids point to track_9.ogg
  if (changes['9']) {
    for (const bid of BOSS_IDS) {
      if (changes[bid]) continue;
      const rng = findTrackElement(s, bid);
      if (!rng) continue;
      const el = s.slice(rng[0], rng[1]);
      const name = (el.match(/name="([^"]*)"/) || [])[1] || '';
      edits.push([rng[0], rng[1],
        `<track id="${bid}" name="${name}" path="track_9.ogg" loop="true" />`]);
    }
  }
  for (const [st, en, newEl] of edits.sort((a, b) => b[0] - a[0])) {
    s = s.slice(0, st) + newEl + s.slice(en);
  }
  return s;
}

// ---------- mod generation (zip download) ----------
async function generateMod() {
  const n = Object.keys(changes).length;
  if (!n) return;
  const btn = document.getElementById('genBtn');
  btn.disabled = true;
  btn.textContent = '打包中…';
  try {
    const zip = new JSZip();
    // metadata.xml (LF endings, fixed id)
    const meta = `<?xml version="1.0" encoding="UTF-8"?>\n<metadata>\n    <name>Isaac BGM Editor</name>\n    <directory>Isaac BGM Editor</directory>\n    <id>1999000002</id>\n    <description>Custom BGM made with Isaac BGM Web Editor</description>\n    <version>1.0</version>\n    <visibility>Public</visibility>\n    <tag id="Lua"/>\n    <tag id="Music"/>\n</metadata>\n`;
    zip.file('metadata.xml', meta);
    zip.file('resources/music.xml', buildMusicXml());
    // track files
    const used = {};
    for (const [tid, ch] of Object.entries(changes)) {
      const fn = `track_${tid}.ogg`;
      zip.file('resources/music/' + fn, ch.blob);
      used[fn] = 1;
    }
    if (changes['9']) zip.file('resources/music/track_9.ogg', changes['9'].blob);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    // download
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'Isaac BGM Editor.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    toast('✅ 已生成！解压 zip 到游戏 mods 文件夹，游戏里启用');
  } catch (e) {
    toast('生成失败：' + e.message);
  }
  btn.disabled = false;
  btn.textContent = `生成 Mod 下载 (${n})`;
}

// ---------- misc ----------
document.getElementById('search').addEventListener('input', render);

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  setTimeout(() => (t.style.display = 'none'), 4000);
}

init();
