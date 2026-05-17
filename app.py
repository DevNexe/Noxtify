from flask import Flask, request, jsonify, send_from_directory, render_template, abort, send_file
from flask_cors import CORS
import os, uuid, time, threading
from pathlib import Path
from mutagen import File as MutagenFile
import sqlite3
import base64

app = Flask(__name__)
CORS(app)

TRACKS_DIR = Path("uploads/tracks")
COVERS_DIR = Path("uploads/covers")
DB_PATH    = Path("noxtify.db")

TRACKS_DIR.mkdir(parents=True, exist_ok=True)
COVERS_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_AUDIO = {".mp3", ".flac", ".ogg", ".wav", ".m4a"}
ALLOWED_IMAGE = {".jpg", ".jpeg", ".png", ".webp"}

_db_lock = threading.Lock()

# ── Database ────────────────────────────────────────────────────────────────

def get_db():
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.row_factory = sqlite3.Row
    return con

def init_db():
    with get_db() as con:
        con.executescript("""
            CREATE TABLE IF NOT EXISTS tracks (
                id         TEXT PRIMARY KEY,
                filename   TEXT NOT NULL,
                ext        TEXT NOT NULL,
                title      TEXT NOT NULL,
                artist     TEXT NOT NULL DEFAULT 'Unknown',
                album      TEXT NOT NULL DEFAULT 'Unknown',
                duration   INTEGER NOT NULL DEFAULT 0,
                cover      TEXT,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS playlists (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS playlist_tracks (
                playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
                track_id    TEXT NOT NULL REFERENCES tracks(id)    ON DELETE CASCADE,
                position    INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (playlist_id, track_id)
            );

            CREATE TABLE IF NOT EXISTS history (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id    TEXT NOT NULL,
                track_id   TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
                played_at  INTEGER NOT NULL
            );
        """)
        cols = {row["name"] for row in con.execute("PRAGMA table_info(tracks)").fetchall()}
        if "genre" not in cols:
            con.execute("ALTER TABLE tracks ADD COLUMN genre TEXT NOT NULL DEFAULT 'Unknown'")

init_db()

# ── Helpers ─────────────────────────────────────────────────────────────────

def row_to_dict(row) -> dict:
    return dict(row) if row else None

def track_to_dict(row) -> dict:
    d = row_to_dict(row)
    return d

def get_user_id():
    user_id = request.headers.get("X-User-Id")
    return user_id.strip() if user_id else None

# ── Metadata extraction ─────────────────────────────────────────────────────

def extract_metadata(path: Path) -> dict:
    meta = {"title": path.stem, "artist": "Unknown", "album": "Unknown", "genre": "Unknown", "duration": 0, "cover": None}
    try:
        audio = MutagenFile(path, easy=True)
        if audio:
            meta["title"]    = (audio.get("title")  or [path.stem])[0]
            meta["artist"]   = (audio.get("artist") or ["Unknown"])[0]
            meta["album"]    = (audio.get("album")  or ["Unknown"])[0]
            meta["genre"]    = (audio.get("genre")  or ["Unknown"])[0]
            meta["duration"] = int(audio.info.length) if hasattr(audio, "info") else 0

        raw = MutagenFile(path)
        if raw:
            pics = raw.get("APIC:") or raw.get("APIC:Cover") or \
                   (raw.pictures[0] if hasattr(raw, "pictures") and raw.pictures else None)
            if pics:
                cover_id   = str(uuid.uuid4())
                cover_path = COVERS_DIR / f"{cover_id}.jpg"
                data       = pics.data if hasattr(pics, "data") else pics
                cover_path.write_bytes(data)
                meta["cover"] = cover_id
    except Exception:
        pass
    return meta

# ── PWA + Frontend ──────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/playlists", defaults={"path": ""})
@app.route("/playlists/<path:path>")
def playlists(path=""):
    return render_template("playlists.html")

@app.route("/history")
def history():
    return render_template("index.html")

@app.route('/manifest.json')
def serve_manifest():
    return send_from_directory('.', 'static/manifest.json')

@app.route('/sw.js')
def serve_sw():
    return send_from_directory('.', 'static/js/sw.js')
# ── Tracks ──────────────────────────────────────────────────────────────────

@app.route("/api/v1/tracks", methods=["GET"])
def get_tracks():
    q      = request.args.get("q", "").strip()
    artist = request.args.get("artist", "").strip()
    genre  = request.args.get("genre", "").strip()
    sort   = request.args.get("sort", "created_at")
    order  = "DESC" if request.args.get("order", "desc") == "desc" else "ASC"
    limit  = min(int(request.args.get("limit", 100)), 500)
    offset = int(request.args.get("offset", 0))

    allowed_sort = {"created_at", "title", "artist", "album", "genre", "duration"}
    if sort not in allowed_sort:
        sort = "created_at"

    where = []
    params = []
    if q:
        pattern = f"%{q}%"
        where.append("(title LIKE ? OR artist LIKE ? OR genre LIKE ?)")
        params.extend([pattern, pattern, pattern])
    if artist:
        where.append("artist LIKE ?")
        params.append(f"%{artist}%")
    if genre:
        where.append("genre = ?")
        params.append(genre)

    where_sql = f"WHERE {' AND '.join(where)}" if where else ""

    with _db_lock, get_db() as con:
        rows = con.execute(
            f"SELECT * FROM tracks {where_sql} ORDER BY {sort} {order} LIMIT ? OFFSET ?",
            (*params, limit, offset)
        ).fetchall()
        total = con.execute(
            f"SELECT COUNT(*) FROM tracks {where_sql}",
            params
        ).fetchone()[0]

    return jsonify({"tracks": [row_to_dict(r) for r in rows], "total": total, "limit": limit, "offset": offset})


@app.route("/api/v1/tracks/<track_id>", methods=["GET"])
def get_track(track_id):
    with _db_lock, get_db() as con:
        row = con.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
    if not row:
        abort(404)
    return jsonify(row_to_dict(row))


@app.route("/api/v1/tracks", methods=["POST"])
def upload_track():
    if "file" not in request.files:
        return jsonify({"error": "No file"}), 400
    f   = request.files["file"]
    ext = Path(f.filename).suffix.lower()
    if ext not in ALLOWED_AUDIO:
        return jsonify({"error": "Unsupported format"}), 415

    track_id  = str(uuid.uuid4())
    filename  = f"{track_id}{ext}"
    save_path = TRACKS_DIR / filename
    f.save(save_path)

    meta = extract_metadata(save_path)
    for field in ("title", "artist", "album", "genre"):
        val = request.form.get(field, "").strip()
        if val:
            meta[field] = val

    now = int(time.time())
    with _db_lock, get_db() as con:
        con.execute(
            "INSERT INTO tracks (id, filename, ext, title, artist, album, genre, duration, cover, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (track_id, filename, ext, meta["title"], meta["artist"],
             meta["album"], meta["genre"], meta["duration"], meta["cover"], now)
        )

    return jsonify({"id": track_id, "filename": filename, "ext": ext, **meta, "created_at": now}), 201


@app.route("/api/v1/tracks/<track_id>", methods=["PATCH"])
def update_track(track_id):
    data = request.get_json(force=True)
    fields = {k: data[k] for k in ("title", "artist", "album", "genre") if k in data}
    if not fields:
        return jsonify({"error": "Nothing to update"}), 400

    with _db_lock, get_db() as con:
        row = con.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
        if not row:
            abort(404)
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        con.execute(f"UPDATE tracks SET {set_clause} WHERE id = ?", (*fields.values(), track_id))
        updated = con.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()

    return jsonify(row_to_dict(updated))


@app.route("/api/v1/tracks/<track_id>", methods=["DELETE"])
def delete_track(track_id):
    with _db_lock, get_db() as con:
        row = con.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
        if not row:
            abort(404)
        track = row_to_dict(row)
        con.execute("DELETE FROM tracks WHERE id = ?", (track_id,))

    try:
        (TRACKS_DIR / track["filename"]).unlink(missing_ok=True)
        if track.get("cover"):
            (COVERS_DIR / f"{track['cover']}.jpg").unlink(missing_ok=True)
    except Exception:
        pass

    return jsonify({"deleted": track_id})

# ── Playlists ───────────────────────────────────────────────────────────────

@app.route("/api/v1/playlists", methods=["GET"])
def get_playlists():
    with _db_lock, get_db() as con:
        rows = con.execute("SELECT * FROM playlists ORDER BY created_at DESC").fetchall()
        result = []
        for pl in rows:
            pl_dict = row_to_dict(pl)
            track_ids = [r[0] for r in con.execute(
                "SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position",
                (pl["id"],)
            ).fetchall()]
            pl_dict["tracks"] = track_ids
            result.append(pl_dict)
    return jsonify({"playlists": result})


@app.route("/api/v1/history", methods=["POST"])
def record_history():
    user_id = get_user_id()
    if not user_id:
        return jsonify({"error": "No user id"}), 400
    data = request.get_json(force=True)
    track_id = data.get("track_id")
    if not track_id:
        return jsonify({"error": "No track id"}), 400
    now = int(time.time())
    with _db_lock, get_db() as con:
        if not con.execute("SELECT 1 FROM tracks WHERE id = ?", (track_id,)).fetchone():
            return jsonify({"error": "Track not found"}), 404
        con.execute(
            "INSERT INTO history (user_id, track_id, played_at) VALUES (?, ?, ?)",
            (user_id, track_id, now)
        )
    return jsonify({"track_id": track_id, "played_at": now}), 201


@app.route("/api/v1/history", methods=["GET"])
def get_history():
    user_id = get_user_id()
    if not user_id:
        return jsonify({"error": "No user id"}), 400
    limit = min(int(request.args.get("limit", 100)), 500)
    offset = int(request.args.get("offset", 0))
    with _db_lock, get_db() as con:
        total = con.execute(
            "SELECT COUNT(*) FROM history WHERE user_id = ?", (user_id,)
        ).fetchone()[0]
        rows = con.execute(
            "SELECT h.track_id, h.played_at, t.title, t.artist, t.album, t.genre, t.cover, t.duration "
            "FROM history h JOIN tracks t ON t.id = h.track_id "
            "WHERE h.user_id = ? ORDER BY h.played_at DESC LIMIT ? OFFSET ?",
            (user_id, limit, offset)
        ).fetchall()
    return jsonify({"history": [row_to_dict(r) for r in rows], "total": total, "limit": limit, "offset": offset})


@app.route("/api/v1/playlists", methods=["POST"])
def create_playlist():
    data  = request.get_json(force=True)
    raw   = uuid.uuid4().hex[:20]
    pl_id = "-".join(raw[i:i+4] for i in range(0, 20, 4))
    name  = data.get("name", "New Playlist").strip() or "New Playlist"
    now   = int(time.time())
    with _db_lock, get_db() as con:
        con.execute("INSERT INTO playlists (id, name, created_at) VALUES (?, ?, ?)", (pl_id, name, now))
    return jsonify({"id": pl_id, "name": name, "tracks": [], "created_at": now}), 201


@app.route("/api/v1/playlists/<pl_id>/tracks", methods=["POST"])
def add_to_playlist(pl_id):
    data     = request.get_json(force=True)
    track_id = data.get("track_id")
    if not track_id:
        return jsonify({"error": "No track id provided"}), 400
    with _db_lock, get_db() as con:
        if not con.execute("SELECT 1 FROM playlists WHERE id = ?", (pl_id,)).fetchone():
            return jsonify({"error": "Playlist not found"}), 404
        if not con.execute("SELECT 1 FROM tracks WHERE id = ?", (track_id,)).fetchone():
            return jsonify({"error": "Track not found"}), 404
        pos = (con.execute(
            "SELECT COALESCE(MAX(position)+1, 0) FROM playlist_tracks WHERE playlist_id = ?", (pl_id,)
        ).fetchone()[0])
        con.execute(
            "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)",
            (pl_id, track_id, pos)
        )
        track_ids = [r[0] for r in con.execute(
            "SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position", (pl_id,)
        ).fetchall()]
        pl = row_to_dict(con.execute("SELECT * FROM playlists WHERE id = ?", (pl_id,)).fetchone())
    pl["tracks"] = track_ids
    return jsonify(pl)


@app.route("/api/v1/playlists/<pl_id>/tracks/<track_id>", methods=["DELETE"])
def remove_from_playlist(pl_id, track_id):
    with _db_lock, get_db() as con:
        if not con.execute("SELECT 1 FROM playlists WHERE id = ?", (pl_id,)).fetchone():
            abort(404)
        con.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?", (pl_id, track_id)
        )
        track_ids = [r[0] for r in con.execute(
            "SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position", (pl_id,)
        ).fetchall()]
        pl = row_to_dict(con.execute("SELECT * FROM playlists WHERE id = ?", (pl_id,)).fetchone())
    pl["tracks"] = track_ids
    return jsonify(pl)


@app.route("/api/v1/playlists/<pl_id>", methods=["DELETE"])
def delete_playlist(pl_id):
    with _db_lock, get_db() as con:
        if not con.execute("SELECT 1 FROM playlists WHERE id = ?", (pl_id,)).fetchone():
            abort(404)
        con.execute("DELETE FROM playlists WHERE id = ?", (pl_id,))
    return jsonify({"deleted": pl_id})

# ── Media — без прямого доступа к uploads/ ──────────────────────────────────

@app.route("/api/v1/stream/<track_id>")
def stream_track(track_id):
    with _db_lock, get_db() as con:
        row = con.execute("SELECT filename FROM tracks WHERE id = ?", (track_id,)).fetchone()
    if not row:
        abort(404)
    path = TRACKS_DIR / row["filename"]
    if not path.exists():
        abort(404)
    return send_from_directory(TRACKS_DIR.resolve(), row["filename"])


@app.route("/api/v1/download/<track_id>")
def download_track(track_id):
    with _db_lock, get_db() as con:
        row = con.execute("SELECT filename, title, artist FROM tracks WHERE id = ?", (track_id,)).fetchone()
    if not row:
        abort(404)
    path = TRACKS_DIR / row["filename"]
    if not path.exists():
        abort(404)
    ext            = Path(row["filename"]).suffix
    download_name  = f"{row['artist']} - {row['title']}{ext}"
    return send_file(path.resolve(), as_attachment=True, download_name=download_name)


@app.route("/api/v1/covers/<cover_id>")
def get_cover(cover_id):
    # Запрещаем path traversal
    safe_id = Path(cover_id).name
    path    = COVERS_DIR / f"{safe_id}.jpg"
    if not path.exists():
        abort(404)
    return send_from_directory(COVERS_DIR.resolve(), f"{safe_id}.jpg")


@app.route("/api/v1/covers/<track_id>", methods=["POST"])
def upload_cover(track_id):
    with _db_lock, get_db() as con:
        if not con.execute("SELECT 1 FROM tracks WHERE id = ?", (track_id,)).fetchone():
            abort(404)
        if "file" not in request.files:
            return jsonify({"error": "No file"}), 400
        f   = request.files["file"]
        ext = Path(f.filename).suffix.lower()
        if ext not in ALLOWED_IMAGE:
            return jsonify({"error": "Unsupported image format"}), 415

        # Удаляем старую обложку
        old = con.execute("SELECT cover FROM tracks WHERE id = ?", (track_id,)).fetchone()
        if old and old["cover"]:
            (COVERS_DIR / f"{old['cover']}.jpg").unlink(missing_ok=True)

        cover_id = str(uuid.uuid4())
        f.save(COVERS_DIR / f"{cover_id}.jpg")
        con.execute("UPDATE tracks SET cover = ? WHERE id = ?", (cover_id, track_id))

    return jsonify({"cover": cover_id})


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
