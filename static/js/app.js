// ── State ──────────────────────────────────────────────────────────
const S = {
  tracks: [], queue: [], qi: -1,
  playing: false, shuffle: false, repeat: "none",
  likedIds: new Set(JSON.parse(localStorage.getItem("liked") || "[]")),
  playlists: [], page: "tracks", currentPlaylist: null, editTargetId: null,
  filters: { artist: "", genre: "" }, allTracks: [],
};

function generateUserId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return [...bytes].map((b, i) => (
      [4, 6, 8, 10].includes(i) ? "-" : "") + b.toString(16).padStart(2, "0")
    ).join("");
  }
  return "uid-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const USER_ID = localStorage.getItem("noxtify_user_id") || generateUserId();
localStorage.setItem("noxtify_user_id", USER_ID);
let currentLang = localStorage.getItem("noxtify_lang") || "ru";
let LANG = {};

const audio = new Audio();
audio.preload = "metadata";

// ── API ────────────────────────────────────────────────────────────
const api = {
  async getTracks(q = "", filters = {}) {
    const params = new URLSearchParams({
      q,
      sort: "created_at",
      order: "desc",
      limit: "500"
    });
    if (filters.artist) params.set("artist", filters.artist);
    if (filters.genre) params.set("genre", filters.genre);
    const r = await fetch(`/api/v1/tracks?${params.toString()}`);
    return r.json();
  },
  async getTrack(id) {
    const r = await fetch(`/api/v1/tracks/${id}`);
    return r.json();
  },
  async upload(fd) {
    const r = await fetch("/api/v1/tracks", { method: "POST", body: fd });
    return r.json();
  },
  async getPlaylists() {
    const r = await fetch("/api/v1/playlists");
    return r.json();
  },
  async createPlaylist(name) {
    const r = await fetch("/api/v1/playlists", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-User-Id": USER_ID },
      body: JSON.stringify({ name })
    });
    return r.json();
  },
  async recordPlay(track_id) {
    return fetch("/api/v1/history", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-User-Id": USER_ID },
      body: JSON.stringify({ track_id })
    });
  },
  async getHistory(limit = 100, offset = 0) {
    const r = await fetch(`/api/v1/history?limit=${limit}&offset=${offset}`, {
      headers: { "X-User-Id": USER_ID }
    });
    return r.json();
  },
  async addToPlaylist(pl_id, track_id) {
    if (!track_id) throw new Error("Track ID is missing");
    const r = await fetch(`/api/v1/playlists/${pl_id}/tracks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-User-Id": USER_ID },
      body: JSON.stringify({ track_id })
    });
    if (!r.ok) {
      const error = await r.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${r.status}`);
    }
    return r.json();
  },
  async del(id) { return fetch(`/api/v1/tracks/${id}`, { method: "DELETE" }); },
  download: id => `/api/v1/download/${id}`,
  stream: id => `/api/v1/stream/${id}`,
  cover:  id => id ? `/api/v1/covers/${id}` : null,
};

// ── Helpers ────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const fmt = s => {
  if (!s || isNaN(s)) return "0:00";
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
};
const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const escAttr = s => esc(s).replace(/"/g, "&quot;");
const displayArtist = artist => String(artist || "Unknown").replace(/\s*\/\s*/g, ", ");
const libraryTracks = () => S.allTracks.length ? S.allTracks : S.tracks;
const findTrackById = id => libraryTracks().find(t => t.id === id);

function t(key, vars = {}) {
  const template = LANG[key] || key;
  return Object.entries(vars).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    template
  );
}
const tt = t;

function trackWord(count) {
  return count === 1 ? t("playlists.single") : t("playlists.many");
}

async function loadLanguage(lang = currentLang) {
  const nextLang = ["ru", "en"].includes(lang) ? lang : "ru";
  try {
    const res = await fetch(`/static/langs/${nextLang}.json`);
    LANG = await res.json();
    currentLang = nextLang;
  } catch (error) {
    if (nextLang !== "ru") return loadLanguage("ru");
    console.warn("Unable to load language file", error);
  }
  localStorage.setItem("noxtify_lang", currentLang);
  document.documentElement.lang = currentLang;
  applyTranslations();
}

function setText(id, key, vars) {
  const el = $(id);
  if (el) el.textContent = t(key, vars);
}

function applyTranslations() {
  document.title = t("app.title");
  const search = $("search-input");
  if (search) search.placeholder = t("search.placeholder");

  const tips = [
    ["nav-home", "nav.home"],
    ["nav-library", "nav.library"],
    ["nav-history", "nav.history"],
    ["nav-upload", "nav.upload"],
  ];
  tips.forEach(([id, key]) => { const el = $(id); if (el) el.dataset.tip = t(key); });
  const settingsBtn = $("nav-settings") || document.querySelector("#sidebar .sidebar-bottom .sidebar-icon:not(#nav-upload)");
  if (settingsBtn) settingsBtn.dataset.tip = t("nav.settings");

  setText("tracks-title", "home.topTracks");
  setText("artist-filter-label", "filters.artist");
  setText("genre-filter-label", "filters.genre");
  setText("settings-modal-title", "settings.title");
  setText("settings-language-label", "settings.language");
  setText("settings-language-hint", "settings.languageHint");
  setText("settings-lang-ru", "settings.ru");
  setText("settings-lang-en", "settings.en");
  setText("upload-modal-title", "upload.title");
  setText("btn-pick-files", "upload.pick");
  setText("metadata-modal-title", S.editTargetId ? "metadata.editTitle" : "metadata.title", {
    title: findTrackById(S.editTargetId)?.title || ""
  });
  setText("btn-metadata-cancel", "metadata.cancel");
  setText("add-playlist-title", "ctx.add");
  if (!S.queue[S.qi]) setText("np-title", "player.emptyTitle");

  const dropZone = $("drop-zone");
  if (dropZone) {
    dropZone.querySelector("p").textContent = t("upload.drop");
    dropZone.querySelector("small").textContent = t("upload.formats");
  }
  const progressLabel = $("upload-progress")?.querySelector(".progress-label");
  if (progressLabel && $("upload-progress").style.display !== "block") progressLabel.textContent = t("upload.progress");

  const metadataLabels = document.querySelectorAll("#metadata-form .modal-field span, #metadata-form .modal-field");
  ["metadata.name", "metadata.artist", "metadata.album", "metadata.genre", "metadata.cover"].forEach((key, index) => {
    const label = metadataLabels[index];
    if (!label) return;
    const textNode = [...label.childNodes].find(node => node.nodeType === Node.TEXT_NODE);
    if (textNode) textNode.textContent = `${t(key)}\n            `;
  });
  document.querySelector("#metadata-form .btn-primary")?.replaceChildren(document.createTextNode(t("metadata.save")));

  ["table.title", "table.liked", "table.duration"].forEach((key, index) => {
    document.querySelectorAll(`.track-header span:nth-child(${index + 2})`).forEach(el => { el.textContent = t(key); });
  });

  const homeSections = document.querySelectorAll("#section-recents, #section-history");
  if (homeSections[0]) {
    homeSections[0].querySelector(".section-title").textContent = t("recents.title");
    homeSections[0].querySelector(".section-sub").textContent = t("recents.subtitle");
  }
  if (homeSections[1]) {
    homeSections[1].querySelector(".section-title").textContent = t("history.title");
    homeSections[1].querySelector(".section-sub").textContent = t("history.subtitle");
  }
  document.querySelector("#section-playlists .section-title") && (document.querySelector("#section-playlists .section-title").textContent = t("playlists.title"));
  setText("btn-new-playlist", "playlists.new");
  setText("btn-back-to-playlists", "playlists.back");

  const ctxKeys = [["cm-play", "ctx.play"], ["cm-edit", "ctx.edit"], ["cm-download", "ctx.download"], ["cm-add", "ctx.add"], ["cm-delete", "ctx.delete"]];
  ctxKeys.forEach(([id, key]) => document.querySelectorAll(`#${id} .ctx-text`).forEach(el => { el.textContent = t(key); }));

  const langSelect = $("language-select");
  if (langSelect) langSelect.value = currentLang;
  renderFilters();
}

function saveLiked() {
  localStorage.setItem("liked", JSON.stringify([...S.likedIds]));
}

// ── Range fill ─────────────────────────────────────────────────────
function updateRangeFill(input) {
  const min = +input.min || 0;
  const max = +input.max || 100;
  const pct = ((+input.value - min) / (max - min)) * 100;
  input.style.background = `linear-gradient(to right, var(--accent) ${pct}%, var(--s4) ${pct}%)`;
}

// ── Toast ──────────────────────────────────────────────────────────
function toast(msg, type = "info") {
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  $("toast-container").appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("show")));
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, 2800);
}

// ── Player ─────────────────────────────────────────────────────────
function playTrack(track) {
  audio.src = api.stream(track.id);
  audio.load();
  audio.play().catch(() => {});
  S.playing = true;
  // FIX: pushRecent теперь вызывается здесь — история обновляется при любом воспроизведении
  pushRecent(track.id);
  renderNowPlaying(track);
  updateMediaSession(track);
  document.querySelectorAll(".track-row").forEach(r => r.classList.remove("active"));
  document.querySelector(`.track-row[data-id="${track.id}"]`)?.classList.add("active");
  renderRecentCards();
}

function setQueue(tracks, idx = 0) {
  S.queue = tracks; S.qi = idx;
  playTrack(tracks[idx]);
}

function playNext() {
  if (!S.queue.length) return;
  if (S.repeat === "one") { audio.currentTime = 0; audio.play(); return; }
  let n = S.shuffle ? Math.floor(Math.random() * S.queue.length) : S.qi + 1;
  if (n >= S.queue.length) { if (S.repeat === "all") n = 0; else { S.playing = false; syncPlayBtn(); return; } }
  S.qi = n; playTrack(S.queue[n]);
}

function playPrev() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  let p = S.qi - 1;
  if (p < 0) p = S.repeat === "all" ? S.queue.length - 1 : 0;
  S.qi = p; playTrack(S.queue[p]);
}

// ── Audio events ───────────────────────────────────────────────────
audio.addEventListener("play",  () => { S.playing = true;  syncPlayBtn(); });
audio.addEventListener("pause", () => { S.playing = false; syncPlayBtn(); });
audio.addEventListener("ended", playNext);
audio.addEventListener("timeupdate", updateProgress);

function syncPlayBtn() {
  const ip = $("icon-play"), ipa = $("icon-pause");
  if (!ip) return;
  ip.style.display  = S.playing ? "none" : "";
  ipa.style.display = S.playing ? "" : "none";
}

function updateProgress() {
  const dur = audio.duration || 0;
  const cur = audio.currentTime || 0;
  const pb = $("progress-bar");
  if (pb) { pb.value = dur ? (cur / dur) * 100 : 0; updateRangeFill(pb); }
  $("time-current").textContent = fmt(cur);
  $("time-duration").textContent = fmt(dur);
}

// ── Now playing ────────────────────────────────────────────────────
function renderNowPlaying(track) {
  $("np-title").textContent = track.title;
  $("np-artist").textContent = displayArtist(track.artist);
  const img = $("np-cover");
  const ph  = $("np-placeholder");
  const url = api.cover(track.cover);
  if (url) { img.src = url; img.style.display = "block"; ph.style.display = "none"; }
  else { img.style.display = "none"; ph.style.display = "flex"; }
  $("player-bar").classList.add("visible");
  $("layout").classList.add("player-visible");
  syncLikeBtn(track.id);
}

function syncLikeBtn(id) {
  $("btn-like")?.classList.toggle("liked", S.likedIds.has(id));
}

function updateMediaSession(track) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title, artist: displayArtist(track.artist), album: track.album,
    artwork: track.cover ? [{ src: api.cover(track.cover), sizes: "512x512" }] : [],
  });
  navigator.mediaSession.setActionHandler("play",          () => audio.play());
  navigator.mediaSession.setActionHandler("pause",         () => audio.pause());
  navigator.mediaSession.setActionHandler("nexttrack",     playNext);
  navigator.mediaSession.setActionHandler("previoustrack", playPrev);
}

// ── Recents grid (last 6 played) ───────────────────────────────────
let recentIds = JSON.parse(localStorage.getItem("recent") || "[]");

function isHomeRoute() {
  const normalized = location.pathname.replace(/\/+$/, "");
  return normalized === "" || normalized === "/";
}

function pushRecent(id) {
  recentIds = [id, ...recentIds.filter(x => x !== id)].slice(0, 6);
  localStorage.setItem("recent", JSON.stringify(recentIds));
  api.recordPlay(id).catch(() => {});
}

async function getRecentTracks() {
  const tracks = [];
  const seen = new Set();
  const add = (track) => {
    if (!track?.id || seen.has(track.id) || tracks.length >= 6) return;
    seen.add(track.id);
    tracks.push(track);
  };

  recentIds.forEach(id => add(findTrackById(id)));

  try {
    const res = await api.getHistory(20, 0);
    (res.history || []).forEach(h => add({
      id: h.track_id,
      title: h.title,
      artist: h.artist,
      album: h.album,
      genre: h.genre,
      cover: h.cover,
      duration: h.duration,
    }));
  } catch (error) {
    console.warn("Unable to load recents from history", error);
  }

  return tracks;
}

async function renderRecentCards() {
  const grid = $("recents-grid");
  const sec  = $("section-recents");
  if (!grid || !sec) return;
  if (!isHomeRoute()) {
    sec.style.display = "none";
    return;
  }
  const recent = await getRecentTracks();
  if (!isHomeRoute()) {
    sec.style.display = "none";
    return;
  }
  sec.style.display = "";
  if (!recent.length) {
    grid.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="currentColor" width="40" height="40"><path d="M12 3v10.55A4 4 0 1014 17V7h4V3h-6z"/></svg>
      <p>${t("recents.emptyTitle")}</p><small>${t("recents.emptySubtitle")}</small>
    </div>`;
    return;
  }
  grid.innerHTML = recent.map(t => {
    const url = api.cover(t.cover);
    return `<div class="recent-card" data-id="${t.id}">
      <div class="recent-cover">${url ? `<img src="${url}" alt="" loading="lazy"/>` : '<svg xmlns="http://www.w3.org/2000/svg" height="96px" viewBox="0 -960 960 960" width="96px" fill="#666666"><path d="M287-167q-47-47-47-113t47-113q47-47 113-47 23 0 42.5 5.5T480-418v-422h240v160H560v400q0 66-47 113t-113 47q-66 0-113-47Z"/></svg>'}</div>
      <div class="recent-info">
        <div class="recent-title">${esc(t.title)}</div>
        <div class="recent-artist">${esc(displayArtist(t.artist))}</div>
      </div>
    </div>`;
  }).join("");
  grid.querySelectorAll(".recent-card").forEach(card => {
    card.addEventListener("click", () => {
      const tracks = libraryTracks();
      const t = tracks.find(x => x.id === card.dataset.id);
      if (t) setQueue([...tracks], tracks.indexOf(t));
    });
  });
}

function toggleDropdown(id) {
  const dropdown = document.getElementById(id);
  const isOpen = dropdown.classList.contains('open');
  
  // Закрываем все другие открытые dropdown
  document.querySelectorAll('.dropdown.open').forEach(d => d.classList.remove('open'));
  
  if (!isOpen) {
    dropdown.classList.add('open');
    
    // Обработчик для закрытия при клике вне
    const closeHandler = (e) => {
      if (!dropdown.contains(e.target)) {
        dropdown.classList.remove('open');
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 1);
  }
}

// ── Track list ─────────────────────────────────────────────────────
async function loadTracks(q = "") {
  const allRes = await api.getTracks("");
  S.allTracks = allRes.tracks || [];
  renderFilters();
  const res = await api.getTracks(q, S.filters);
  S.tracks = res.tracks;
  if (S.page === "playlist" && S.currentPlaylist) {
    renderTracks(getPlaylistTracks(S.currentPlaylist), "playlist-track-list");
  } else {
    renderTracks(S.tracks, "track-list");
  }
  renderRecentCards();
}

function renderTracks(tracks, targetId = "track-list") {
  const list = $(targetId);
  if (!list) return;
  if (!tracks.length) {
    list.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="currentColor" width="40" height="40"><path d="M12 3v10.55A4 4 0 1014 17V7h4V3h-6z"/></svg>
      <p>${t("tracks.emptyTitle")}</p><small>${t("tracks.emptySubtitle")}</small>
    </div>`;
    return;
  }
  list.innerHTML = tracks.map((t, i) => {
    if (!t.id) {
      console.warn("renderTracks: skipping track without id", t);
      return "";
    }
    const url = api.cover(t.cover);
    const liked = S.likedIds.has(t.id);
    return `<div class="track-row" data-id="${t.id}" data-idx="${i}">
      <span class="tr-num">${i + 1}</span>
      <div class="tr-cover-wrap">
        <div class="tr-cover">${url ? `<img src="${url}" alt="" loading="lazy"/>` : '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#666666"><path d="M287-167q-47-47-47-113t47-113q47-47 113-47 23 0 42.5 5.5T480-418v-422h240v160H560v400q0 66-47 113t-113 47q-66 0-113-47Z"/></svg>'}</div>
        <div class="tr-meta">
          <span class="tr-title">${esc(t.title)}</span>
          <span class="tr-artist">${esc(displayArtist(t.artist))}</span>
        </div>
      </div>
      <button class="tr-like${liked ? " liked" : ""}" data-id="${t.id}" aria-label="${tt("track.liked")}">
        <svg viewBox="0 0 24 24" fill="${liked ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.8" width="16" height="16">
          <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
        </svg>
      </button>
      <span class="tr-dur">${fmt(t.duration)}</span>
      <button class="tr-menu" data-id="${t.id}" aria-label="${tt("track.menu")}">⋯</button>
    </div>`;
  }).join("");

  // FIX: один обработчик вместо двух конфликтующих
  list.querySelectorAll(".track-row").forEach(row => {
    row.addEventListener("click", e => {
      if (e.target.closest(".tr-menu")) return;
      if (e.target.closest(".tr-like")) { toggleLike(row.dataset.id); return; }
      const idx = +row.dataset.idx;
      setQueue([...tracks], idx);
    });
  });

  list.querySelectorAll(".tr-menu").forEach(btn => {
    if (!btn.dataset.id) {
      console.warn("renderTracks: tr-menu button without data-id", btn.closest(".track-row"));
      return;
    }
    btn.addEventListener("click", e => { e.stopPropagation(); openCtxMenu(btn.dataset.id, btn); });
  });
}

function getFavoriteTracks() {
  return libraryTracks().filter(t => S.likedIds.has(t.id));
}

function getPlaylistTracks(playlist) {
  if (!playlist) return [];
  if (playlist.id === "favorites") return getFavoriteTracks();
  return libraryTracks().filter(t => playlist.tracks?.includes(t.id));
}

function renderFilters() {
  const tracks = S.allTracks.length ? S.allTracks : S.tracks;
  
  // Собираем уникальные значения
  const artists = [...new Set(tracks.map(t => t.artist).filter(Boolean))].sort();
  const genres  = [...new Set(tracks.map(t => t.genre).filter(Boolean))].sort();

  // Функция для отрисовки опций в кастомный dropdown
  const fillDropdown = (menuId, items, type, allLabelKey) => {
    const menu = $(menuId);
    if (!menu) return;
    
    const allLabel = t(allLabelKey);
    let html = `<button class="dropdown-item" onclick="selectFilterOption('${type}', '', '${allLabel}')">${allLabel}</button>`;
    
    items.forEach(item => {
      const isSelected = S.filters[type] === item;
      html += `
        <button class="dropdown-item ${isSelected ? 'active' : ''}" onclick="selectFilterOption('${type}', '${escAttr(item)}', '${escAttr(item)}')">
          ${esc(item)}
        </button>`;
    });
    
    menu.innerHTML = html;
    
    // Обновляем текст на кнопке
    const selectedSpan = $(`selected-${type}`);
    if (selectedSpan) {
      selectedSpan.textContent = S.filters[type] || allLabel;
    }
  };

  fillDropdown('menu-artist', artists, 'artist', 'filters.allArtists');
  fillDropdown('menu-genre', genres, 'genre', 'filters.allGenres');
}

// Новая функция для выбора опции
function selectFilterOption(type, value, label) {
  S.filters[type] = value;
  
  // Обновляем текст на кнопке
  const selectedSpan = $(`selected-${type}`);
  if (selectedSpan) selectedSpan.textContent = label;
  
  // Закрываем dropdown
  document.querySelectorAll('.dropdown.open').forEach(d => d.classList.remove('open'));
  
  // Вызываем поиск/фильтрацию
  onSearch(); 
}

function showSection(section) {
  const map = {
    "tracks": "section-tracks",
    "playlists": "section-playlists",
    "playlist": "section-playlist",
    "history": "section-history",
  };
  Object.entries(map).forEach(([key, id]) => {
    const el = $(id);
    if (!el) return;
    el.style.display = key === section ? "" : "none";
  });
  const recent = $("section-recents");
  if (recent) {
    recent.style.display = section === "tracks" && isHomeRoute() ? "" : "none";
    if (section === "tracks" && isHomeRoute()) renderRecentCards();
  }
  S.page = section;
  updateSidebarActive(section);
}

/* ── Spotify-like State Sync ── */

function syncStateToStorage() {
  const stateToSave = {
    qi: S.qi,
    queue: S.queue,
    currentTime: audio.currentTime,
    volume: audio.volume,
    page: S.page,
    currentPlaylist: S.currentPlaylist,
    filters: S.filters
  };
  localStorage.setItem('noxtify_session', JSON.stringify(stateToSave));
}

audio.addEventListener('play', syncStateToStorage);
audio.addEventListener('pause', syncStateToStorage);
audio.addEventListener('timeupdate', () => {
  updateProgress();
  if (Math.floor(audio.currentTime) % 5 === 0) syncStateToStorage();
});

async function restoreSession() {
  const saved = localStorage.getItem('noxtify_session');
  if (!saved) return;
  try {
    const state = JSON.parse(saved);
    if (state.filters) S.filters = state.filters;
    if (state.page) showSection(state.page);
    if (state.queue && state.queue.length && state.qi !== -1) {
      S.queue = state.queue; S.qi = state.qi;
      const track = S.queue[S.qi];
      if (track) {
        audio.src = api.stream(track.id);
        audio.currentTime = state.currentTime || 0;
        audio.volume = state.volume || 1;
        renderNowPlaying(track);
        syncPlayBtn();
      }
    }
  } catch (e) { console.error("Session restore failed", e); }
}


function updateSidebarActive(section) {
  // Убираем active у всех иконок
  document.querySelectorAll('.sidebar-icon').forEach(icon => {
    icon.classList.remove('active');
  });

  // Определяем, какую иконку подсветить
  let activeId = '';
  if (section === 'tracks') activeId = 'nav-home';
  if (section === 'playlists' || section === 'playlist') activeId = 'nav-library';
  if (section === 'history') activeId = 'nav-history';

  // Добавляем active нужной иконке
  if (activeId) {
    const activeIcon = document.getElementById(activeId);
    if (activeIcon) activeIcon.classList.add('active');
  }
}

function renderPlaylists() {
  const list = $("playlist-list");
  if (!list) return;
  const favCount = getFavoriteTracks().length;
  const cards = [`
    <div class="playlist-card" data-id="favorites">
      <div class="playlist-title">${t("playlists.favorites")}</div>
      <div class="playlist-sub">${favCount} ${trackWord(favCount)}</div>
    </div>
  `];
  cards.push(...S.playlists.map(pl => `
    <div class="playlist-card" data-id="${pl.id}">
      <div class="playlist-title">${esc(pl.name)}</div>
      <div class="playlist-sub">${pl.tracks.length} ${trackWord(pl.tracks.length)}</div>
    </div>
  `));
  list.innerHTML = cards.join("");
  list.querySelectorAll(".playlist-card").forEach(card => {
    card.addEventListener("click", () => {
      if (card.dataset.id === "favorites") {
        openFavorites();
        return;
      }
      const pl = S.playlists.find(x => x.id === card.dataset.id);
      if (pl) openPlaylistView(pl);
    });
  });
}

async function loadPlaylists() {
  const res = await api.getPlaylists();
  S.playlists = res.playlists || [];
  renderPlaylists();
}

function navigateTo(path, replace = false) {
  const needsReload = path === "/" || path === "/history" || path.startsWith("/playlists");
  if (location.pathname !== path && needsReload) {
    if (replace) location.replace(path);
    else location.href = path;
    return;
  }
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  handleRoute(path);
}

function handleRoute(path = location.pathname) {
  const normalized = path.replace(/\/+$/, "");
  if (normalized === "" || normalized === "/") {
    showSection("tracks");
    return;
  }
  if (normalized === "/playlists") {
    openLibrary(true);
    return;
  }
  if (normalized === "/playlists/favorite") {
    openFavorites(true);
    return;
  }
  if (normalized === "/history") {
    openHistory(true);
    return;
  }
  const match = normalized.match(/^\/playlists\/([a-f0-9]{4}(?:-[a-f0-9]{4}){4})$/i);
  if (match) {
    const id = match[1];
    const pl = id === "favorites"
      ? { id: "favorites", name: t("playlists.favorites"), tracks: getFavoriteTracks().map(t => t.id) }
      : S.playlists.find(x => x.id === id);
    if (pl) {
      openPlaylistView(pl, true);
      return;
    }
  }
  showSection("tracks");
}

function openLibrary(replace = false) {
  const route = "/playlists";
  if (location.pathname !== route) {
    location.href = route;
    return;
  }
  showSection("playlists");
  renderPlaylists();
  if (replace) history.replaceState(null, "", route);
  else history.pushState(null, "", route);
}

function openHistory(replace = false) {
  const route = "/history";
  if (location.pathname !== route) {
    location.href = route;
    return;
  }
  showSection("history");
  loadHistory();
  if (replace) history.replaceState(null, "", route);
  else history.pushState(null, "", route);
}

function openFavorites(replace = false) {
  openPlaylistView({ id: "favorites", name: t("playlists.favorites"), tracks: getFavoriteTracks().map(t => t.id) }, replace);
}

function openPlaylistView(playlist, replace = false) {
  const route = playlist.id === "favorites" ? "/playlists/favorite" : `/playlists/${playlist.id}`;
  if (location.pathname !== route) {
    location.href = route;
    return;
  }
  S.currentPlaylist = playlist;
  showSection("playlist");
  $("playlist-name").textContent = playlist.name;
  const tracks = getPlaylistTracks(playlist);
  $("playlist-count").textContent = `${tracks.length} ${trackWord(tracks.length)}`;
  renderTracks(tracks, "playlist-track-list");
  if (replace) {
    history.replaceState(null, "", route);
  } else {
    history.pushState(null, "", route);
  }
}

async function loadHistory() {
  const res = await api.getHistory(100, 0);
  renderHistory(res.history || []);
}

function renderHistory(history) {
  const list = $("history-list");
  if (!list) return;
  if (!history.length) {
    list.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="currentColor" width="40" height="40"><path d="M12 3v10.55A4 4 0 1014 17V7h4V3h-6z"/></svg>
      <p>${t("history.emptyTitle")}</p><small>${t("history.emptySubtitle")}</small>
    </div>`;
    return;
  }
  list.innerHTML = history.map((h, i) => {
    if (!h.track_id) {
      console.warn("renderHistory: skipping history item without track_id", h);
      return "";
    }
    const url = api.cover(h.cover);
    const liked = S.likedIds.has(h.track_id);
    return `<div class="track-row" data-id="${h.track_id}" data-idx="${i}">
      <span class="tr-num">${i + 1}</span>
      <div class="tr-cover-wrap">
        <div class="tr-cover">${url ? `<img src="${url}" alt="" loading="lazy"/>` : '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#666666"><path d="M287-167q-47-47-47-113t47-113q47-47 113-47 23 0 42.5 5.5T480-418v-422h240v160H560v400q0 66-47 113t-113 47q-66 0-113-47Z"/></svg>'}</div>
        <div class="tr-meta">
          <span class="tr-title">${esc(h.title)}</span>
          <span class="tr-artist">${esc(displayArtist(h.artist))}</span>
        </div>
      </div>
      <button class="tr-like${liked ? " liked" : ""}" data-id="${h.track_id}" aria-label="${t("track.liked")}">
        <svg viewBox="0 0 24 24" fill="${liked ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.8" width="16" height="16">
          <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
        </svg>
      </button>
      <span class="tr-dur">${fmt(h.duration)}</span>
      <button class="tr-menu" data-id="${h.track_id}" aria-label="${t("track.menu")}">⋯</button>
    </div>`;
  }).join("");

  list.querySelectorAll(".track-row").forEach(row => {
    row.addEventListener("click", e => {
      if (e.target.closest(".tr-menu")) return;
      if (e.target.closest(".tr-like")) { toggleLike(row.dataset.id); return; }
      const idx = +row.dataset.idx;
      setQueue(history.map(h => findTrackById(h.track_id)).filter(Boolean), idx);
    });
  });

  list.querySelectorAll(".tr-menu").forEach(btn => {
    btn.addEventListener("click", e => { e.stopPropagation(); openCtxMenu(btn.dataset.id, btn); });
  });
}

async function openMetadataModal(trackId) {
  let track = findTrackById(trackId);
  if (!track) {
    track = await api.getTrack(trackId).catch(() => null);
  }
  if (!track) return;
  $("metadata-modal-title").textContent = `Редактировать: ${track.title}`;
  $("meta-title").value = track.title;
  $("meta-artist").value = track.artist;
  $("meta-album").value = track.album;
  $("meta-genre").value = track.genre || "Unknown";
  $("cover-input").value = "";
  $("modal-backdrop").classList.add("open");
  S.editTargetId = trackId;
}

function closeMetadataModal() {
  $("modal-backdrop").classList.remove("open");
  S.editTargetId = null;
}

async function submitMetadataForm(event) {
  event.preventDefault();
  const trackId = S.editTargetId;
  if (!trackId) return;

  const title = $("meta-title").value.trim();
  const artist = $("meta-artist").value.trim();
  const album = $("meta-album").value.trim();
  const genre = $("meta-genre").value.trim();

  const res = await fetch(`/api/v1/tracks/${trackId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, artist, album, genre })
  });
  const updated = await res.json();

  const coverFile = $("cover-input").files[0];
  if (coverFile) {
    const fd = new FormData();
    fd.append("file", coverFile);
    const coverRes = await fetch(`/api/v1/covers/${trackId}`, { method: "POST", body: fd });
    const coverData = await coverRes.json();
    if (coverData.cover) updated.cover = coverData.cover;
  }

  await loadTracks();
  if (S.page === "history") await loadHistory();
  if (S.queue[S.qi] && S.queue[S.qi].id === trackId) {
    S.queue[S.qi] = updated;
    renderNowPlaying(updated);
  }

  closeMetadataModal();
  toast("Сохранено");
}

function setupNavigation() {
  $("nav-home")?.addEventListener("click", () => navigateTo("/"));
  $("nav-library")?.addEventListener("click", openLibrary);
  $("nav-favorites")?.addEventListener("click", openFavorites);
  $("nav-history")?.addEventListener("click", openHistory);
  $("btn-back")?.addEventListener("click", () => window.history.back());
  $("btn-fwd")?.addEventListener("click", () => window.history.forward());
  $("btn-back-to-playlists")?.addEventListener("click", openLibrary);
  $("btn-new-playlist")?.addEventListener("click", async () => {
    const name = prompt("Имя плейлиста", "Новый плейлист");
    if (!name) return;
    const pl = await api.createPlaylist(name.trim() || "Новый плейлист");
    S.playlists.unshift(pl);
    renderPlaylists();
    openPlaylistView(pl);
    toast("Плейлист создан");
  });
  $("metadata-form")?.addEventListener("submit", submitMetadataForm);
  $("btn-metadata-cancel")?.addEventListener("click", closeMetadataModal);
  $("modal-backdrop")?.addEventListener("click", e => {
    if (e.target === $("modal-backdrop")) closeMetadataModal();
  });
  $("cm-edit")?.addEventListener("click", async () => {
    if (!ctxTarget) return;
    await openMetadataModal(ctxTarget);
    closeCtxMenu();
  });
  $("cm-download")?.addEventListener("click", () => {
    if (!ctxTarget) return;
    window.open(api.download(ctxTarget), "_blank");
    closeCtxMenu();
  });

  $("cm-add")?.addEventListener("click", () => {
    const trackId = ctxTarget;
    closeCtxMenu();
    if (!trackId) return;
    openAddToPlaylistPopup(trackId);
  });
}

function setupSettings() {
  const backdrop = $("settings-backdrop");
  const btn = $("nav-settings") || document.querySelector("#sidebar .sidebar-bottom .sidebar-icon:not(#nav-upload)");
  const select = $("language-select");
  if (!backdrop || !btn || !select) return;

  btn.id = "nav-settings";
  btn.addEventListener("click", () => {
    select.value = currentLang;
    backdrop.classList.add("open");
  });
  backdrop.addEventListener("click", e => {
    if (e.target === backdrop) backdrop.classList.remove("open");
  });
  select.addEventListener("change", async e => {
    await loadLanguage(e.target.value);
    renderCurrentView();
  });
}

function renderCurrentView() {
  if (S.page === "history") {
    loadHistory();
    return;
  }
  if (S.page === "playlists") {
    renderPlaylists();
    return;
  }
  if (S.page === "playlist" && S.currentPlaylist) {
    openPlaylistView(S.currentPlaylist, true);
    return;
  }
  renderTracks(S.tracks, "track-list");
  renderRecentCards();
}

// FIX: убрана мёртвая переменная currentTitle
function toggleLike(id) {
  if (S.likedIds.has(id)) S.likedIds.delete(id);
  else S.likedIds.add(id);
  saveLiked();
  const targetId = S.page === "playlist" ? "playlist-track-list" : "track-list";
  const tracks = S.page === "playlist" && S.currentPlaylist ? getPlaylistTracks(S.currentPlaylist) : S.tracks;
  renderTracks(tracks, targetId);
  renderPlaylists();
  const cur = S.queue[S.qi];
  if (cur && cur.id === id) syncLikeBtn(id);
}

// ── Context menu ───────────────────────────────────────────────────
let ctxTarget = null;

function openCtxMenu(trackId, anchor) {
  if (!trackId) {
    console.warn("openCtxMenu: missing trackId", anchor);
    return;
  }
  ctxTarget = trackId;
  const menu = $("ctx-menu");
  const rect = anchor.getBoundingClientRect();
  menu.style.top  = (rect.top  - menu.offsetHeight - 8 + window.scrollY) + "px";
  menu.style.left = (rect.left - 120) + "px";
  menu.classList.add("open");
  setTimeout(() => document.addEventListener("click", e => {
    if (!menu.contains(e.target)) closeCtxMenu();
  }, { once: true }), 0);
}

function closeCtxMenu() { $("ctx-menu").classList.remove("open"); ctxTarget = null; }

function openAddToPlaylistPopup(trackId) {
  ctxTarget = trackId;
  renderAddToPlaylistPopup();
  const backdrop = $("add-playlist-backdrop");
  if (!backdrop) return;
  backdrop.classList.add("open");
}

function closeAddToPlaylistPopup() {
  const backdrop = $("add-playlist-backdrop");
  if (!backdrop) return;
  backdrop.classList.remove("open");
}

function renderAddToPlaylistPopup() {
  const list = $("add-playlist-list");
  if (!list) return;
  const track = findTrackById(ctxTarget);
  if (!track) {
    list.innerHTML = `<div class="empty-state"><p>Трек не найден</p></div>`;
    return;
  }
  if (!S.playlists.length) {
    list.innerHTML = `<div class="empty-state"><p>Нет доступных плейлистов</p><small>Создай плейлист в библиотеке</small></div>`;
    return;
  }
  list.innerHTML = S.playlists.map(pl => `
    <button class="playlist-choice" type="button" data-id="${pl.id}">
      <span>${esc(pl.name)}</span>
      <small>${pl.tracks.length} трек${pl.tracks.length === 1 ? "" : "ов"}</small>
    </button>
  `).join("");
  list.querySelectorAll(".playlist-choice").forEach(btn => {
    btn.addEventListener("click", async () => {
      const plId = btn.dataset.id;
      if (!plId || !ctxTarget) {
        console.warn("Add to playlist failed: missing data", { plId, ctxTarget });
        if (!ctxTarget) {
          toast("Не удалось добавить: трек не выбран", "error");
        } else {
          toast("Не удалось добавить: плейлист не выбран", "error");
        }
        return;
      }
      try {
        await api.addToPlaylist(plId, ctxTarget);
        closeAddToPlaylistPopup();
        await loadPlaylists();
        toast("Добавлено в плейлист");
      } catch (error) {
        console.error("Add to playlist failed", error);
        const message = error?.message ? error.message : "ошибка сервера";
        toast(`Не удалось добавить: ${message}`, "error");
      }
    });
  });
}

function renderAddToPlaylistPopupTranslated() {
  const list = $("add-playlist-list");
  if (!list) return;
  const track = findTrackById(ctxTarget);
  if (!track) {
    list.innerHTML = `<div class="empty-state"><p>${t("track.notFound")}</p></div>`;
    return;
  }
  if (!S.playlists.length) {
    list.innerHTML = `<div class="empty-state"><p>${t("playlists.emptyAddTitle")}</p><small>${t("playlists.emptyAddSubtitle")}</small></div>`;
    return;
  }
  list.innerHTML = S.playlists.map(pl => `
    <button class="playlist-choice" type="button" data-id="${pl.id}">
      <span>${esc(pl.name)}</span>
      <small>${pl.tracks.length} ${trackWord(pl.tracks.length)}</small>
    </button>
  `).join("");
  list.querySelectorAll(".playlist-choice").forEach(btn => {
    btn.addEventListener("click", async () => {
      const plId = btn.dataset.id;
      if (!plId || !ctxTarget) {
        toast(t("playlists.addFailed", { message: !ctxTarget ? t("playlists.noTrack") : t("playlists.noPlaylist") }), "error");
        return;
      }
      try {
        await api.addToPlaylist(plId, ctxTarget);
        closeAddToPlaylistPopup();
        await loadPlaylists();
        toast(t("playlists.added"));
      } catch (error) {
        const message = error?.message ? error.message : "server error";
        toast(t("playlists.addFailed", { message }), "error");
      }
    });
  });
}

renderAddToPlaylistPopup = renderAddToPlaylistPopupTranslated;

$("add-playlist-backdrop")?.addEventListener("click", e => {
  if (e.target === $("add-playlist-backdrop")) closeAddToPlaylistPopup();
});

$("cm-play").addEventListener("click", () => {
  if (!ctxTarget) return;
  const tracks = libraryTracks();
  const idx = tracks.findIndex(t => t.id === ctxTarget);
  if (idx >= 0) setQueue([...tracks], idx);
  closeCtxMenu();
});

$("cm-delete").addEventListener("click", async () => {
  if (!ctxTarget) return;
  const track = findTrackById(ctxTarget);
  if (!track || !confirm(`Удалить "${track.title}"?`)) return;
  await api.del(ctxTarget);
  closeCtxMenu();
  loadTracks();
  toast("Трек удалён");
});

// ── Upload ─────────────────────────────────────────────────────────
function setupUpload() {
  const zone  = $("drop-zone");
  const input = $("file-input");
  const backdrop = $("upload-backdrop");
  if (!zone || !input) return;

  const openUploadPopup = () => backdrop?.classList.add("open");
  const closeUploadPopup = () => {
    backdrop?.classList.remove("open");
    zone.classList.remove("drag-over");
  };
  const resetUploadProgress = () => {
    const bar = $("upload-progress");
    bar.querySelector(".progress-fill").style.width = "0%";
    bar.style.display = "none";
  };

  $("nav-upload")?.addEventListener("click", e => {
    e.preventDefault();
    resetUploadProgress();
    openUploadPopup();
  });
  $("btn-pick-files")?.addEventListener("click", e => {
    e.stopPropagation();
    input.click();
  });
  backdrop?.addEventListener("click", e => {
    if (e.target === backdrop) closeUploadPopup();
  });

  zone.addEventListener("click", e => {
    if (e.target.tagName === "BUTTON") return;
    input.click();
  });
  zone.addEventListener("dragover", e => { e.preventDefault(); zone.classList.add("drag-over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", e => {
    e.preventDefault(); e.stopPropagation(); zone.classList.remove("drag-over");
    uploadFiles(e.dataTransfer.files);
  });
  input.addEventListener("change", () => uploadFiles(input.files));

  document.body.addEventListener("dragover", e => { e.preventDefault(); openUploadPopup(); zone.classList.add("drag-over"); });
  document.body.addEventListener("dragleave", e => { if (!e.relatedTarget) zone.classList.remove("drag-over"); });
  document.body.addEventListener("drop", e => {
    e.preventDefault(); zone.classList.remove("drag-over");
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  });
}

async function uploadFiles(files) {
  const arr = Array.from(files);
  if (!arr.length) return;
  const bar = $("upload-progress");
  bar.style.display = "block";
  for (let i = 0; i < arr.length; i++) {
    bar.querySelector(".progress-label").textContent = `Загрузка ${i + 1}/${arr.length}: ${arr[i].name}`;
    bar.querySelector(".progress-label").textContent = t("upload.progressFile", { current: i + 1, total: arr.length, name: arr[i].name });
    bar.querySelector(".progress-fill").style.width = `${(i / arr.length) * 100}%`;
    const fd = new FormData(); fd.append("file", arr[i]);
    await api.upload(fd).catch(() => toast(`Ошибка: ${arr[i].name}`, "error"));
  }
  bar.querySelector(".progress-fill").style.width = "100%";
  setTimeout(() => {
    bar.style.display = "none";
    $("upload-backdrop")?.classList.remove("open");
    $("drop-zone")?.classList.remove("drag-over");
    $("file-input").value = "";
  }, 600);
  loadTracks();
  toast(`Загружено ${arr.length} трек(ов)`);
}

// ── Controls ───────────────────────────────────────────────────────
function setupControls() {
  $("btn-prev").onclick = playPrev;
  $("btn-play").onclick = () => audio.paused ? audio.play() : audio.pause();
  $("btn-next").onclick = playNext;

  $("btn-shuffle").onclick = function() {
    S.shuffle = !S.shuffle; this.classList.toggle("active", S.shuffle);
  };

  $("btn-repeat").onclick = function() {
    const modes = ["none","all","one"];
    S.repeat = modes[(modes.indexOf(S.repeat) + 1) % 3];
    this.dataset.mode = S.repeat;
    this.classList.toggle("active", S.repeat !== "none");
    this.title = S.repeat === "one" ? "Повтор: один" : S.repeat === "all" ? "Повтор: все" : "Повтор: выкл";
  };

  $("btn-like")?.addEventListener("click", () => {
    const cur = S.queue[S.qi];
    if (cur) toggleLike(cur.id);
  });

  const vol = $("volume-slider");
  vol.addEventListener("input", () => {
    audio.volume = vol.value / 100;
    updateRangeFill(vol);
  });
  updateRangeFill(vol);

  const pb = $("progress-bar");
  pb.addEventListener("input", () => {
    audio.currentTime = (pb.value / 100) * (audio.duration || 0);
    updateRangeFill(pb);
  });
}

// ── Hotkeys ────────────────────────────────────────────────────────
function setupHotkeys() {
  document.addEventListener("keydown", e => {
    // Игнорируем если фокус в инпуте
    if (e.target.matches("input, textarea")) return;

    switch (e.code) {
      case "Space":
        e.preventDefault();
        audio.paused ? audio.play() : audio.pause();
        break;
      case "ArrowRight":
        e.preventDefault();
        audio.currentTime = Math.min(audio.currentTime + 5, audio.duration || 0);
        break;
      case "ArrowLeft":
        e.preventDefault();
        audio.currentTime = Math.max(audio.currentTime - 5, 0);
        break;
      case "ArrowUp":
        e.preventDefault();
        audio.volume = Math.min(audio.volume + 0.1, 1);
        $("volume-slider").value = audio.volume * 100;
        updateRangeFill($("volume-slider"));
        break;
      case "ArrowDown":
        e.preventDefault();
        audio.volume = Math.max(audio.volume - 0.1, 0);
        $("volume-slider").value = audio.volume * 100;
        updateRangeFill($("volume-slider"));
        break;
      case "KeyN":
        playNext();
        break;
      case "KeyP":
        playPrev();
        break;
      case "KeyL": {
        const cur = S.queue[S.qi];
        if (cur) toggleLike(cur.id);
        break;
      }
      case "KeyS":
        S.shuffle = !S.shuffle;
        $("btn-shuffle").classList.toggle("active", S.shuffle);
        break;
    }
  });
}

// ── Search ─────────────────────────────────────────────────────────
function setupSearch() {
  let timer;
  $("search-input").addEventListener("input", e => {
    clearTimeout(timer);
    timer = setTimeout(() => loadTracks(e.target.value), 280);
  });
  $("artist-filter")?.addEventListener("change", e => {
    S.filters.artist = e.target.value;
    loadTracks($("search-input")?.value || "");
  });
  $("genre-filter")?.addEventListener("change", e => {
    S.filters.genre = e.target.value;
    loadTracks($("search-input")?.value || "");
  });
}

// ── Init ───────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  await loadLanguage();
  await Promise.all([loadTracks(), loadPlaylists()]);
  setupUpload();
  setupControls();
  setupSearch();
  setupHotkeys();
  setupNavigation();
  setupSettings();
  handleRoute();
  window.addEventListener("popstate", () => handleRoute());
});
