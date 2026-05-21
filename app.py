from flask import Flask, request, jsonify, send_from_directory, render_template, abort, send_file
from flask_cors import CORS
import os, re, uuid, time, threading, configparser, secrets, smtplib, socket, subprocess, urllib.error, urllib.request, urllib.parse, imghdr
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from pathlib import Path
from mutagen import File as MutagenFile
import requests
from yt_dlp import YoutubeDL
import sqlite3
import bcrypt
import jwt as pyjwt
from functools import wraps
import random

# ── Config ───────────────────────────────────────────────────────────────────

cfg = configparser.ConfigParser()
cfg.read("noxtify.cfg")

SECRET_KEY           = cfg.get("app", "secret_key", fallback="change-me")
DEBUG                = cfg.getboolean("app", "debug", fallback=True)
HOST                 = cfg.get("app", "host", fallback="0.0.0.0")
PORT                 = cfg.getint("app", "port", fallback=5000)
OPEN_REGISTRATION    = cfg.getboolean("registration", "open", fallback=True)
REQUIRE_EMAIL_VERIFY = cfg.getboolean("registration", "require_email_verification", fallback=False)
SMTP_HOST            = cfg.get("email", "smtp_host", fallback="")
SMTP_PORT            = cfg.getint("email", "smtp_port", fallback=587)
SMTP_USER            = cfg.get("email", "smtp_user", fallback="")
SMTP_PASSWORD        = cfg.get("email", "smtp_password", fallback="")
FROM_NAME            = cfg.get("email", "from_name", fallback="Noxtify")
FROM_EMAIL           = cfg.get("email", "from_email", fallback="")
TRACKS_DIR           = Path(cfg.get("storage", "tracks_dir", fallback="uploads/tracks"))
COVERS_DIR           = Path(cfg.get("storage", "covers_dir", fallback="uploads/covers"))

TRACKS_DIR.mkdir(parents=True, exist_ok=True)
COVERS_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH       = Path("noxtify.db")
ALLOWED_AUDIO = {".mp3", ".flac", ".ogg", ".wav", ".m4a"}
ALLOWED_IMAGE = {".jpg", ".jpeg", ".png", ".webp"}

app = Flask(__name__)
CORS(app)
_db_lock = threading.Lock()

# ── Database ──────────────────────────────────────────────────────────────────

def get_db():
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con

def init_db():
    with get_db() as con:
        con.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id            TEXT PRIMARY KEY,
                username      TEXT NOT NULL UNIQUE,
                email         TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                verified      INTEGER NOT NULL DEFAULT 0,
                verify_token  TEXT,
                created_at    INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tracks (
                id         TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                filename   TEXT NOT NULL,
                ext        TEXT NOT NULL,
                title      TEXT NOT NULL,
                artist     TEXT NOT NULL DEFAULT 'Unknown',
                album      TEXT NOT NULL DEFAULT 'Unknown',
                genre      TEXT NOT NULL DEFAULT 'Unknown',
                duration   INTEGER NOT NULL DEFAULT 0,
                cover      TEXT,
                public     INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS playlists (
                id         TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name       TEXT NOT NULL,
                public     INTEGER NOT NULL DEFAULT 0,
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
                user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                track_id   TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
                played_at  INTEGER NOT NULL
            );
        """)
        # Add public column to tracks if it doesn't exist
        try:
            con.execute("ALTER TABLE tracks ADD COLUMN public INTEGER NOT NULL DEFAULT 1")
        except sqlite3.OperationalError:
            pass # Column already exists
        try:
            con.execute("ALTER TABLE users ADD COLUMN verify_token_exp INTEGER")
        except sqlite3.OperationalError:
            pass
        try:
            con.execute("ALTER TABLE tracks ADD COLUMN source TEXT DEFAULT 'local'")
        except sqlite3.OperationalError:
            pass
        try:
            con.execute("ALTER TABLE tracks ADD COLUMN source_url TEXT")
        except sqlite3.OperationalError:
            pass
        try:
            con.execute("ALTER TABLE playlists ADD COLUMN cover TEXT")
        except sqlite3.OperationalError:
            pass

init_db()

# ── Auth helpers ──────────────────────────────────────────────────────────────

def row_to_dict(row):
    return dict(row) if row else None

def make_jwt(user_id: str) -> str:
    payload = {"sub": user_id, "iat": int(time.time()), "exp": int(time.time()) + 60 * 60 * 24 * 30}
    return pyjwt.encode(payload, SECRET_KEY, algorithm="HS256")

def decode_jwt(token: str):
    try:
        return pyjwt.decode(token, SECRET_KEY, algorithms=["HS256"])
    except Exception:
        return None

def get_token():
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:]
    return request.cookies.get("token")

def resolve_user():
    token = get_token()
    if token:
        payload = decode_jwt(token)
        if payload:
            with _db_lock, get_db() as con:
                user = con.execute("SELECT * FROM users WHERE id=?", (payload["sub"],)).fetchone()
            if user:
                user_dict = row_to_dict(user)
                user_dict["is_guest"] = (user_dict["email"] or "").endswith("@noxtify.guest")
                return user_dict
    
    # Guest support via X-User-Id header
    guest_id = request.headers.get("X-User-Id")
    if guest_id:
        with _db_lock, get_db() as con:
            user = con.execute("SELECT * FROM users WHERE id=?", (guest_id,)).fetchone()
            if not user:
                # Auto-create guest user record to satisfy foreign keys
                now = int(time.time())
                try:
                    con.execute(
                        "INSERT INTO users (id, username, email, password_hash, verified, created_at) "
                        "VALUES (?,?,?,?,?,?)",
                        (guest_id, f"Guest_{guest_id[:8]}", f"{guest_id}@noxtify.guest", "guest_nopass", 1, now)
                    )
                    user = con.execute("SELECT * FROM users WHERE id=?", (guest_id,)).fetchone()
                except sqlite3.Error:
                    return None
            
            user_dict = row_to_dict(user)
            user_dict["is_guest"] = True
            return user_dict
            
    return None

def auth_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        user = resolve_user()
        if not user:
            return jsonify({"error": "Unauthorized"}), 401
        if REQUIRE_EMAIL_VERIFY and not user["verified"]:
            return jsonify({"error": "Email not verified"}), 403
        request.current_user = user
        return f(*args, **kwargs)
    return wrapper

def optional_auth(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        request.current_user = resolve_user()
        return f(*args, **kwargs)
    return wrapper

def is_track_public(con, track_id: str) -> bool:
    # Check if the track itself is public
    row = con.execute("SELECT public FROM tracks WHERE id = ?", (track_id,)).fetchone()
    if row and row[0] == 1:
        return True
    # Or if it's in a public playlist
    row = con.execute(
        "SELECT 1 FROM playlist_tracks pt "
        "JOIN playlists p ON p.id = pt.playlist_id "
        "WHERE pt.track_id = ? AND p.public = 1",
        (track_id,)
    ).fetchone()
    return row is not None

# ── Email ─────────────────────────────────────────────────────────────────────

def send_verification_email(to_email: str, username: str, code: str):
    if not SMTP_HOST or not SMTP_USER:
        return
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = "Код подтверждения — Noxtify"
        msg["From"]    = f"{FROM_NAME} <{FROM_EMAIL}>"
        msg["To"]      = to_email
        html = f"""<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
          <h2>Привет, {username}!</h2>
          <p>Твой код подтверждения:</p>
          <div style="font-size:36px;font-weight:700;letter-spacing:8px;padding:20px;background:#1a1a1a;color:#fff;border-radius:12px;text-align:center">{code}</div>
          <p style="color:#888;font-size:13px;margin-top:12px">Код действителен 15 минут.</p>
        </div>"""
        msg.attach(MIMEText(html, "html"))
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as s:
            s.starttls()
            s.login(SMTP_USER, SMTP_PASSWORD)
            s.sendmail(FROM_EMAIL, to_email, msg.as_string())
    except Exception as e:
        app.logger.error(f"Email send failed: {e}")

# ── Metadata ──────────────────────────────────────────────────────────────────

def _find_cover_url(raw) -> str | None:
    if not hasattr(raw, "tags") or not raw.tags:
        return None
    urls = []
    for key, frame in raw.tags.items():
        if not frame:
            continue
        if hasattr(frame, "url"):
            text = str(frame.url)
        else:
            text = str(frame)
        if not text or "http" not in text.lower():
            continue
        found = re.findall(r"https?://[^\s'\"]+", text)
        for url in found:
            if re.search(r"\.(jpe?g|png|webp|gif)(?:[?#]|$)", url, re.I):
                return url
            if key.lower().startswith("wxxx") or key.lower().startswith("woar") or "cover" in key.lower() or "art" in key.lower():
                return url
            urls.append(url)
    return urls[0] if urls else None


def _fetch_image_from_url(url: str) -> bytes | None:
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
        })
        with urllib.request.urlopen(req, timeout=10) as resp:
            content_type = resp.headers.get("Content-Type", "").lower()
            if content_type and not content_type.startswith("image/"):
                return None
            data = resp.read(5 * 1024 * 1024 + 1)
            if len(data) > 5 * 1024 * 1024:
                return None
            if not imghdr.what(None, data):
                return None
            return data
    except (urllib.error.URLError, urllib.error.HTTPError, socket.timeout, ValueError) as e:
        app.logger.debug(f"Cover URL fetch failed for {url}: {e}")
        return None


def _save_cover_from_url(url: str, user_id: str) -> str | None:
    data = _fetch_image_from_url(url)
    if not data:
        return None
    cover_id = str(uuid.uuid4())
    cover_dir = COVERS_DIR / user_id
    cover_dir.mkdir(parents=True, exist_ok=True)
    (cover_dir / f"{cover_id}.jpg").write_bytes(data)
    return cover_id

SPOTIFY_OEMBED_URL = "https://open.spotify.com/oembed"
SPOTIFY_URL_RE = re.compile(r"(?:https?://open\.spotify\.com/|spotify:)(track|playlist)[:/](?P<id>[A-Za-z0-9]+)")
SPOTIFY_TRACK_LINK_RE = re.compile(r'/track/([A-Za-z0-9]+)')
SPOTIFY_TRACK_URI_RE = re.compile(r'spotify:track:([A-Za-z0-9]+)')


def _normalize_spotify_url(url: str) -> str:
    if not url:
        return ""
    url = url.strip()
    if url.startswith("spotify:"):
        parts = url.split(":")
        if len(parts) >= 3:
            return f"https://open.spotify.com/{parts[1]}/{parts[2].split('?')[0]}"
    return url.split("?")[0]


def _spotify_url_type(url: str) -> tuple[str, str] | None:
    url = _normalize_spotify_url(url)
    match = SPOTIFY_URL_RE.match(url)
    if not match:
        return None
    return match.group(1), match.group("id")


def _fetch_spotify_oembed(url: str) -> dict | None:
    try:
        resp = requests.get(SPOTIFY_OEMBED_URL, params={"url": url}, headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
        if resp.status_code == 200:
            return resp.json()
    except requests.RequestException as e:
        app.logger.debug(f"Spotify oEmbed failed for {url}: {e}")
    return None


import html as _html

def _spotify_track_query_from_url(url: str) -> dict | None:
    url = _normalize_spotify_url(url)
    parsed = _spotify_url_type(url)
    if not parsed or parsed[0] != "track":
        return None

    # Prefer oEmbed for lightweight metadata
    data = _fetch_spotify_oembed(url)
    title = (data.get("title", "").strip() if data else "")
    artist = (data.get("author_name", "").strip() if data else "")
    genre = ""
    image_url = None
    duration = 0

    try:
        resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
        if resp.status_code == 200:
            html_text = resp.text

            og_image = re.search(r'<meta[^>]+property=[\'\"]og:image[\'\"][^>]+content=[\'\"]([^\'\"]+)[\'\"]', html_text, re.I)
            twitter_image = re.search(r'<meta[^>]+name=[\'\"]twitter:image[\'\"][^>]+content=[\'\"]([^\'\"]+)[\'\"]', html_text, re.I)
            image_url = (og_image.group(1).strip() if og_image else None) or (twitter_image.group(1).strip() if twitter_image else None)

            duration_meta = re.search(r'<meta[^>]+name=[\'\"]music:duration[\'\"][^>]+content=[\'\"]([^\'\"]+)[\'\"]', html_text, re.I)
            if duration_meta:
                try:
                    duration = int(duration_meta.group(1).strip())
                except ValueError:
                    duration = 0

            genre_meta = re.search(r'<meta[^>]+name=[\'\"]music:genre[\'\"][^>]+content=[\'\"]([^\'\"]+)[\'\"]', html_text, re.I)
            if genre_meta:
                genre = genre_meta.group(1).strip()

            m = re.search(r'<meta[^>]+name=[\'\"]description[\'\"][^>]+content=[\'\"]([^\'\"]+)[\'\"]', html_text, re.I)
            desc = m.group(1).strip() if m else None

            if not title:
                og_title = re.search(r'<meta[^>]+property=[\'\"]og:title[\'\"][^>]+content=[\'\"]([^\'\"]+)[\'\"]', html_text, re.I)
                title = og_title.group(1).strip() if og_title else title

            if desc:
                parts = [p.strip() for p in desc.split('·') if p.strip()]
                if len(parts) >= 2 and not artist:
                    artist = parts[1]


            if not title or not artist:
                for candidate in (desc, title):
                    if not candidate:
                        continue
                    candidate = _html.unescape(candidate)
                    m_by = re.match(r'^(?P<title>.+) by (?P<artist>.+?) on Spotify', candidate, re.I)
                    if m_by:
                        title = title or m_by.group('title').strip()
                        artist = artist or m_by.group('artist').strip()
                        break
                    for sep in [' — ', ' – ', ' - ', ' • ', '·', '•']:
                        if sep in candidate:
                            parts = [p.strip() for p in candidate.split(sep) if p.strip()]
                            if len(parts) >= 2:
                                first, second = parts[0], parts[1]
                                if not title and not artist:
                                    if re.search(r'feat\.|ft\.|,', first, re.I):
                                        artist = first
                                        title = second
                                    else:
                                        title = second
                                        artist = first
                                elif not title:
                                    title = second
                                elif not artist:
                                    artist = first
                                break
                        if title and artist:
                            break
    except requests.RequestException as e:
        app.logger.debug(f"Spotify page scrape failed for {url}: {e}")

    if not title or not artist:
        return None

    return {
        "title": title,
        "artist": artist,
        "genre": genre,
        "duration": duration,
        "image_url": image_url,
        "query": f"{artist} - {title}"
    }


def _clean_spotify_playlist_name(name: str) -> str:
    name = _html.unescape((name or "").strip())
    if not name:
        return ""
    name = re.sub(r"^\s*(?:playlist|spotify playlist)\s*[·•:-]\s*", "", name, flags=re.I)
    name = re.sub(r"\s*(?:\||-)\s*Spotify\s*$", "", name, flags=re.I)
    name = re.sub(r"\s+on Spotify\s*$", "", name, flags=re.I)
    name = re.sub(r"\s*-\s*playlist by .*$", "", name, flags=re.I)
    return name.strip()


def _spotify_playlist_name_from_url(url: str) -> str | None:
    url = _normalize_spotify_url(url)
    parsed = _spotify_url_type(url)
    if not parsed or parsed[0] != "playlist":
        return None

    data = _fetch_spotify_oembed(url)
    name = _clean_spotify_playlist_name(data.get("title", "") if data else "")
    if name:
        return name

    try:
        resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=10)
        if resp.status_code != 200:
            return None
        html_text = resp.text
        for pattern in (
            r'<meta[^>]+property=[\'\"]og:title[\'\"][^>]+content=[\'\"]([^\'\"]+)[\'\"]',
            r'<meta[^>]+name=[\'\"]twitter:title[\'\"][^>]+content=[\'\"]([^\'\"]+)[\'\"]',
            r"<title[^>]*>(.*?)</title>",
        ):
            match = re.search(pattern, html_text, re.I | re.S)
            name = _clean_spotify_playlist_name(match.group(1) if match else "")
            if name:
                return name
    except requests.RequestException as e:
        app.logger.debug(f"Spotify playlist name parse failed for {url}: {e}")
    return None


def _get_spotify_playlist_track_urls(url: str) -> list[str]:
    url = _normalize_spotify_url(url)
    parsed = _spotify_url_type(url)
    if not parsed or parsed[0] != "playlist":
        return []
    try:
        resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=15)
        if resp.status_code != 200:
            return []
        text = resp.text
        track_ids = []
        for tid in SPOTIFY_TRACK_LINK_RE.findall(text) + SPOTIFY_TRACK_URI_RE.findall(text):
            if tid not in track_ids:
                track_ids.append(tid)
        return [f"https://open.spotify.com/track/{tid}" for tid in track_ids]
    except requests.RequestException as e:
        app.logger.debug(f"Spotify playlist parse failed for {url}: {e}")
    return []


def _download_audio_search(track_id: str, query: str, user_dir: Path) -> Path | None:
    if not query:
        return None
    user_dir.mkdir(parents=True, exist_ok=True)
    search_variants = [query, f"{query} audio", f"{query} official audio", f"{query} lyrics"]
    search_providers = [
        ("YouTube", "ytsearch1:"),
        ("SoundCloud", "scsearch1:"),
    ]
    for search_text in search_variants:
        for provider_name, prefix in search_providers:
            search_query = prefix + search_text
            output_template = str(user_dir / f"{track_id}.%(ext)s")
            ydl_opts = {
                "format": "bestaudio/best",
                "outtmpl": output_template,
                "noplaylist": True,
                "quiet": True,
                "no_warnings": True,
                "ignoreerrors": True,
                "source_address": "0.0.0.0",
            }
            try:
                with YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(search_query, download=True)
                if not info:
                    continue
                if isinstance(info, dict) and info.get("entries"):
                    info = next((item for item in info["entries"] if item), None)
                if not info:
                    continue
                if info.get("requested_downloads"):
                    file_path = info["requested_downloads"][0].get("filepath")
                    if file_path and Path(file_path).exists():
                        return Path(file_path)
                candidates = list(user_dir.glob(f"{track_id}.*"))
                if candidates:
                    return max(candidates, key=lambda p: p.stat().st_mtime)
            except Exception as e:
                app.logger.debug(f"Audio search failed for {query} on {provider_name}: {e}")
                continue
    return None


def extract_metadata(path: Path, user_id: str) -> dict:
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
            data = None
            
            # Try embedded image first
            if hasattr(raw, 'keys'):
                for key in raw.keys():
                    if key.startswith("APIC:"):
                        try:
                            data = raw[key].data
                            break
                        except Exception:
                            continue
            if not data and hasattr(raw, "pictures") and raw.pictures:
                data = raw.pictures[0].data

            # If no embedded cover, try a remote cover URL from tags
            if not data:
                cover_url = _find_cover_url(raw)
                if cover_url:
                    data = _fetch_image_from_url(cover_url)

            if data:
                cover_id  = str(uuid.uuid4())
                cover_dir = COVERS_DIR / user_id
                cover_dir.mkdir(parents=True, exist_ok=True)
                (cover_dir / f"{cover_id}.jpg").write_bytes(data)
                meta["cover"] = cover_id
    except Exception as e:
        app.logger.debug(f"Cover extraction failed for {path}: {e}")
    return meta

# ── Auth routes ───────────────────────────────────────────────────────────────
@app.route("/api/v1/auth/register", methods=["POST"])
def register():
    if not OPEN_REGISTRATION:
        return jsonify({"error": "Registration is closed"}), 403
    data     = request.get_json(force=True)
    username = (data.get("username") or "").strip()
    email    = (data.get("email") or "").strip().lower()
    password = (data.get("password") or "")
    if not username or not email or not password:
        return jsonify({"error": "All fields required"}), 400
    if len(username) < 3:
        return jsonify({"error": "Username too short"}), 400
    if len(password) < 6:
        return jsonify({"error": "Password too short"}), 400
    if "@" not in email:
        return jsonify({"error": "Invalid email"}), 400
    pw_hash      = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    user_id      = str(uuid.uuid4())
    verify_token = str(random.randint(100000, 999999)) if REQUIRE_EMAIL_VERIFY else None
    now          = int(time.time())
    try:
        with _db_lock, get_db() as con:
            verify_exp = now + 60 * 15  # 15 минут
            con.execute(
                "INSERT INTO users (id, username, email, password_hash, verified, verify_token, verify_token_exp, created_at) VALUES (?,?,?,?,?,?,?,?)",
                (user_id, username, email, pw_hash, 0 if REQUIRE_EMAIL_VERIFY else 1, verify_token, verify_exp if REQUIRE_EMAIL_VERIFY else None, now)
            )
    except sqlite3.IntegrityError as e:
        if "username" in str(e):
            return jsonify({"error": "Username already taken"}), 409
        return jsonify({"error": "Email already registered"}), 409
    if REQUIRE_EMAIL_VERIFY and verify_token:
        send_verification_email(email, username, verify_token)
        return jsonify({"message": "Check your email", "user_id": user_id}), 201
    token = make_jwt(user_id)
    return jsonify({"token": token, "user": {"id": user_id, "username": username, "email": email}}), 201

@app.route("/api/v1/auth/login", methods=["POST"])
def login():
    data     = request.get_json(force=True)
    login_id = (data.get("login") or "").strip().lower()
    password = (data.get("password") or "")
    if not login_id or not password:
        return jsonify({"error": "All fields required"}), 400
    with _db_lock, get_db() as con:
        user = con.execute(
            "SELECT * FROM users WHERE lower(email)=? OR lower(username)=?", (login_id, login_id)
        ).fetchone()
    if not user or not bcrypt.checkpw(password.encode(), user["password_hash"].encode()):
        return jsonify({"error": "Invalid credentials"}), 401
    if REQUIRE_EMAIL_VERIFY and not user["verified"]:
        return jsonify({"error": "Email not verified"}), 403
    token = make_jwt(user["id"])
    return jsonify({"token": token, "user": {"id": user["id"], "username": user["username"], "email": user["email"]}})

@app.route("/api/v1/auth/verify", methods=["POST"])
def verify_email():
    data    = request.get_json(force=True)
    user_id = data.get("user_id", "").strip()
    code    = data.get("code", "").strip()
    if not user_id or not code:
        return jsonify({"error": "Missing fields"}), 400
    with _db_lock, get_db() as con:
        user = con.execute("SELECT * FROM users WHERE id=? AND verify_token=?", (user_id, code)).fetchone()
        if not user:
            return jsonify({"error": "Invalid code"}), 400
        if user["verify_token_exp"] and int(time.time()) > user["verify_token_exp"]:
            return jsonify({"error": "Code expired"}), 400
        # Update user to verified
        con.execute("UPDATE users SET verified=1, verify_token=NULL, verify_token_exp=NULL WHERE id=?", (user_id,))
    
    token = make_jwt(user_id)
    return jsonify({"token": token, "user": {"id": user["id"], "username": user["username"], "email": user["email"]}})

@app.route("/api/v1/auth/me")
@auth_required
def me():
    u = request.current_user
    return jsonify({"id": u["id"], "username": u["username"], "email": u["email"]})


@app.route("/api/v1/auth/config")
def auth_config():
    return jsonify({"open_registration": OPEN_REGISTRATION, "require_email_verification": REQUIRE_EMAIL_VERIFY})

# ── Tracks ────────────────────────────────────────────────────────────────────

@app.route("/api/v1/tracks", methods=["GET"])
@auth_required
def get_tracks():
    q      = request.args.get("q", "").strip()
    artist = request.args.get("artist", "").strip()
    genre  = request.args.get("genre", "").strip()
    sort   = request.args.get("sort", "created_at")
    order  = "DESC" if request.args.get("order", "desc") == "desc" else "ASC"
    limit  = min(int(request.args.get("limit", 100)), 500)
    offset = int(request.args.get("offset", 0))
    
    uid      = request.current_user["id"]
    is_guest = request.current_user.get("is_guest", False)
    
    allowed_sort = {"created_at", "title", "artist", "album", "genre", "duration"}
    if sort not in allowed_sort:
        sort = "created_at"
        
    # All users see public tracks. Registered users also see their own private tracks.
    if is_guest:
        where = ["public = 1"]
        params = []
    else:
        where  = ["(public = 1 OR user_id = ?)"]
        params = [uid]
        
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
    where_sql = f"WHERE {' AND '.join(where)}"
    with _db_lock, get_db() as con:
        rows  = con.execute(
            f"SELECT * FROM tracks {where_sql} ORDER BY {sort} {order} LIMIT ? OFFSET ?",
            (*params, limit, offset)
        ).fetchall()
        total = con.execute(f"SELECT COUNT(*) FROM tracks {where_sql}", params).fetchone()[0]
    return jsonify({"tracks": [row_to_dict(r) for r in rows], "total": total, "limit": limit, "offset": offset})


@app.route("/api/v1/tracks/<track_id>", methods=["GET"])
@optional_auth
def get_track(track_id):
    with _db_lock, get_db() as con:
        row = con.execute("SELECT * FROM tracks WHERE id=?", (track_id,)).fetchone()
        if not row:
            abort(404)
        
        # Guests can access any track since they can see all in the list
        if request.current_user and request.current_user.get("is_guest"):
            return jsonify(row_to_dict(row))
            
        uid = request.current_user["id"] if request.current_user else None
        if row["user_id"] != uid and not is_track_public(con, track_id):
            abort(403)
    return jsonify(row_to_dict(row))


@app.route("/api/v1/tracks", methods=["POST"])
@auth_required
def upload_track():
    if request.current_user.get("is_guest"):
        return jsonify({"error": "Registration required to upload"}), 403
    
    if "file" not in request.files:
        return jsonify({"error": "No file"}), 400
    f   = request.files["file"]
    ext = Path(f.filename).suffix.lower()
    if ext not in ALLOWED_AUDIO:
        return jsonify({"error": "Unsupported format"}), 415
    uid      = request.current_user["id"]
    track_id = str(uuid.uuid4())
    filename = f"{track_id}{ext}"
    user_dir = TRACKS_DIR / uid
    user_dir.mkdir(parents=True, exist_ok=True)
    save_path = user_dir / filename
    f.save(save_path)
    meta = extract_metadata(save_path, uid)
    for field in ("title", "artist", "album", "genre"):
        val = request.form.get(field, "").strip()
        if val:
            meta[field] = val
    # Check for public flag in form
    is_public = request.form.get("public", "1") == "1"
    
    now = int(time.time())
    with _db_lock, get_db() as con:
        con.execute(
            "INSERT INTO tracks (id, user_id, filename, ext, title, artist, album, genre, duration, cover, public, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (track_id, uid, filename, ext, meta["title"], meta["artist"],
             meta["album"], meta["genre"], meta["duration"], meta["cover"], int(is_public), now)
        )
    return jsonify({"id": track_id, **meta, "public": is_public, "created_at": now}), 201


@app.route("/api/v1/tracks/download-spotify", methods=["POST"])
@auth_required
def download_spotify_track():
    """Download single track from Spotify using Spotify metadata and yt-dlp search."""
    if request.current_user.get("is_guest"):
        return jsonify({"error": "Registration required to download"}), 403
    
    data = request.get_json(force=True)
    spotify_url = data.get("url") or data.get("spotify_url")
    
    if not spotify_url:
        return jsonify({"error": "Spotify URL required"}), 400
    
    uid = request.current_user["id"]
    track_id = str(uuid.uuid4())
    user_dir = TRACKS_DIR / uid
    user_dir.mkdir(parents=True, exist_ok=True)
    
    track_info = _spotify_track_query_from_url(spotify_url)
    if not track_info:
        return jsonify({"error": "Failed to parse Spotify track metadata"}), 400
    
    downloaded_file = _download_audio_search(track_id, track_info["query"], user_dir)
    if not downloaded_file:
        return jsonify({"error": "Track not found on YouTube or fallback services"}), 404
    
    output_path = user_dir / f"{track_id}{downloaded_file.suffix}"
    if downloaded_file != output_path:
        downloaded_file.rename(output_path)
    
    if not output_path.exists():
        return jsonify({"error": "Download failed - file not found"}), 400
    
    meta = extract_metadata(output_path, uid)
    meta["title"] = track_info.get("title") or meta["title"]
    meta["artist"] = track_info.get("artist") or meta["artist"]
    if not meta["duration"] and track_info.get("duration"):
        meta["duration"] = track_info["duration"]
    if track_info.get("genre"):
        meta["genre"] = track_info["genre"]
    elif not meta["genre"] or meta["genre"] == "Unknown":
        meta["genre"] = ""
    if not meta["cover"] and track_info.get("image_url"):
        cover_id = _save_cover_from_url(track_info["image_url"], uid)
        if cover_id:
            meta["cover"] = cover_id
    is_public = data.get("public", True)

    now = int(time.time())
    with _db_lock, get_db() as con:
        con.execute(
            "INSERT INTO tracks (id, user_id, filename, ext, title, artist, album, genre, duration, cover, public, created_at, source, source_url) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (track_id, uid, output_path.name, output_path.suffix, meta["title"], meta["artist"],
             meta["album"], meta["genre"], meta["duration"], meta["cover"], int(is_public), now, "spotify", spotify_url)
        )
    
    return jsonify({"id": track_id, **meta, "public": is_public, "source": "spotify", "created_at": now}), 201


@app.route("/api/v1/playlists/download-spotify", methods=["POST"])
@auth_required
def download_spotify_playlist():
    """Download entire Spotify playlist using Spotify metadata and yt-dlp search."""
    if request.current_user.get("is_guest"):
        return jsonify({"error": "Registration required to download"}), 403
    
    data = request.get_json(force=True)
    spotify_url = data.get("url") or data.get("spotify_url")
    
    if not spotify_url:
        return jsonify({"error": "Spotify URL required"}), 400
    
    uid = request.current_user["id"]
    user_dir = TRACKS_DIR / uid
    user_dir.mkdir(parents=True, exist_ok=True)
    
    playlist_id = str(uuid.uuid4())
    playlist_name = (data.get("name") or "").strip()
    if not playlist_name:
        playlist_name = _spotify_playlist_name_from_url(spotify_url) or "Spotify Playlist"
    now = int(time.time())
    
    track_urls = _get_spotify_playlist_track_urls(spotify_url)
    if not track_urls:
        return jsonify({"error": "Could not parse Spotify playlist tracks"}), 400
    
    track_ids = []
    with _db_lock, get_db() as con:
        con.execute(
            "INSERT INTO playlists (id, user_id, name, public, created_at) VALUES (?,?,?,?,?)",
            (playlist_id, uid, playlist_name, 1, now)
        )
        
        position = 0
        for track_url in track_urls:
            track_info = _spotify_track_query_from_url(track_url)
            if not track_info:
                app.logger.debug(f"Skipping playlist track with missing metadata: {track_url}")
                continue
            try:
                track_id = str(uuid.uuid4())
                downloaded_file = _download_audio_search(track_id, track_info["query"], user_dir)
                if not downloaded_file:
                    app.logger.debug(f"Skipping playlist track not found: {track_info['query']}")
                    continue
                output_path = user_dir / f"{track_id}{downloaded_file.suffix}"
                if downloaded_file != output_path:
                    downloaded_file.rename(output_path)
                
                meta = extract_metadata(output_path, uid)
                meta["title"] = track_info.get("title") or meta["title"]
                meta["artist"] = track_info.get("artist") or meta["artist"]
                if not meta["duration"] and track_info.get("duration"):
                    meta["duration"] = track_info["duration"]
                if track_info.get("genre"):
                    meta["genre"] = track_info["genre"]
                elif not meta["genre"] or meta["genre"] == "Unknown":
                    meta["genre"] = ""
                if not meta["cover"] and track_info.get("image_url"):
                    cover_id = _save_cover_from_url(track_info["image_url"], uid)
                    if cover_id:
                        meta["cover"] = cover_id

                # Insert track as public (imported from spotify)
                con.execute(
                    "INSERT INTO tracks (id, user_id, filename, ext, title, artist, album, genre, duration, cover, public, created_at, source, source_url) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (track_id, uid, output_path.name, output_path.suffix, meta["title"], meta["artist"],
                     meta["album"], meta["genre"], meta["duration"], meta["cover"], 1, now, "spotify", spotify_url)
                )
                # Track playlist cover: prefer first available track cover
                try:
                    if not locals().get('first_cover') and meta.get('cover'):
                        first_cover = meta.get('cover')
                except Exception:
                    first_cover = meta.get('cover') if meta.get('cover') else None
                con.execute(
                    "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?,?,?)",
                    (playlist_id, track_id, position)
                )
                track_ids.append(track_id)
                position += 1
            except Exception as e:
                app.logger.error(f"Error processing playlist track {track_url}: {e}")
                continue
    
    if not track_ids:
        return jsonify({"error": "No tracks were downloaded from the playlist"}), 400
    # If we captured a cover from playlist tracks, update playlist record
    try:
        if 'first_cover' in locals() and first_cover:
            with _db_lock, get_db() as con:
                con.execute("UPDATE playlists SET cover=? WHERE id=?", (first_cover, playlist_id))
    except Exception as e:
        app.logger.debug(f"Failed to set playlist cover: {e}")

    return jsonify({
        "playlist_id": playlist_id,
        "id": playlist_id,
        "name": playlist_name,
        "public": True,
        "tracks_count": len(track_ids),
        "tracks": track_ids,
        "source": "spotify",
        "source_url": spotify_url
    }), 201


@app.route("/api/v1/tracks/<track_id>", methods=["PATCH"])
@auth_required
def update_track(track_id):
    if request.current_user.get("is_guest"):
        return jsonify({"error": "Forbidden"}), 403
    data   = request.get_json(force=True)
    fields = {k: data[k] for k in ("title", "artist", "album", "genre", "public") if k in data}
    if not fields:
        return jsonify({"error": "Nothing to update"}), 400
    
    # Cast public to int if present
    if "public" in fields:
        fields["public"] = int(bool(fields["public"]))
        
    with _db_lock, get_db() as con:
        row = con.execute("SELECT * FROM tracks WHERE id=? AND user_id=?", (track_id, request.current_user["id"])).fetchone()
        if not row:
            abort(404)
        set_clause = ", ".join(f"{k}=?" for k in fields)
        con.execute(f"UPDATE tracks SET {set_clause} WHERE id=?", (*fields.values(), track_id))
        updated = con.execute("SELECT * FROM tracks WHERE id=?", (track_id,)).fetchone()
    return jsonify(row_to_dict(updated))


@app.route("/api/v1/tracks/<track_id>", methods=["DELETE"])
@auth_required
def delete_track(track_id):
    if request.current_user.get("is_guest"):
        return jsonify({"error": "Forbidden"}), 403
    uid = request.current_user["id"]
    with _db_lock, get_db() as con:
        row = con.execute("SELECT * FROM tracks WHERE id=? AND user_id=?", (track_id, uid)).fetchone()
        if not row:
            abort(404)
        track = row_to_dict(row)
        con.execute("DELETE FROM tracks WHERE id=?", (track_id,))
    try:
        (TRACKS_DIR / uid / track["filename"]).unlink(missing_ok=True)
        if track.get("cover"):
            (COVERS_DIR / uid / f"{track['cover']}.jpg").unlink(missing_ok=True)
    except Exception:
        pass
    return jsonify({"deleted": track_id})

# ── Playlists ─────────────────────────────────────────────────────────────────

@app.route("/api/v1/playlists", methods=["GET"])
@auth_required
def get_playlists():
    uid = request.current_user["id"]
    with _db_lock, get_db() as con:
        rows   = con.execute("SELECT * FROM playlists WHERE user_id=? ORDER BY created_at DESC", (uid,)).fetchall()
        result = []
        for pl in rows:
            pl_dict = row_to_dict(pl)
            pl_dict["tracks"] = [r[0] for r in con.execute(
                "SELECT track_id FROM playlist_tracks WHERE playlist_id=? ORDER BY position", (pl["id"],)
            ).fetchall()]
            result.append(pl_dict)
    return jsonify({"playlists": result})


@app.route("/api/v1/playlists/public", methods=["GET"])
def get_public_playlists():
    q      = request.args.get("q", "").strip()
    limit  = min(int(request.args.get("limit", 50)), 200)
    offset = int(request.args.get("offset", 0))
    where  = ["p.public = 1"]
    params = []
    if q:
        where.append("p.name LIKE ?")
        params.append(f"%{q}%")
    where_sql = f"WHERE {' AND '.join(where)}"
    with _db_lock, get_db() as con:
        rows   = con.execute(
            f"SELECT p.*, u.username FROM playlists p "
            f"JOIN users u ON u.id = p.user_id "
            f"{where_sql} ORDER BY p.created_at DESC LIMIT ? OFFSET ?",
            (*params, limit, offset)
        ).fetchall()
        result = []
        for pl in rows:
            pl_dict = row_to_dict(pl)
            track_rows = con.execute(
                "SELECT t.* FROM tracks t "
                "JOIN playlist_tracks pt ON pt.track_id = t.id "
                "WHERE pt.playlist_id = ? ORDER BY pt.position",
                (pl["id"],)
            ).fetchall()
            pl_dict["tracks"]        = [r["id"] for r in track_rows]
            pl_dict["track_objects"] = [row_to_dict(r) for r in track_rows]
            result.append(pl_dict)
    return jsonify({"playlists": result, "total": len(result)})


@app.route("/api/v1/playlists/<pl_id>", methods=["GET"])
@optional_auth
def get_playlist(pl_id):
    with _db_lock, get_db() as con:
        pl = con.execute(
            "SELECT p.*, u.username FROM playlists p JOIN users u ON u.id=p.user_id WHERE p.id=?", (pl_id,)
        ).fetchone()
        if not pl:
            abort(404)
        uid = request.current_user["id"] if request.current_user else None
        if not pl["public"] and pl["user_id"] != uid:
            abort(403)
        pl_dict    = row_to_dict(pl)
        track_rows = con.execute(
            "SELECT t.* FROM tracks t JOIN playlist_tracks pt ON pt.track_id=t.id "
            "WHERE pt.playlist_id=? ORDER BY pt.position", (pl_id,)
        ).fetchall()
        pl_dict["tracks"]        = [r["id"] for r in track_rows]
        pl_dict["track_objects"] = [row_to_dict(r) for r in track_rows]
    return jsonify(pl_dict)


@app.route("/api/v1/playlists", methods=["POST"])
@auth_required
def create_playlist():
    if request.current_user.get("is_guest"):
        return jsonify({"error": "Registration required to create playlists"}), 403
    data   = request.get_json(force=True)
    raw    = uuid.uuid4().hex[:20]
    pl_id  = "-".join(raw[i:i+4] for i in range(0, 20, 4))
    name   = data.get("name", "New Playlist").strip() or "New Playlist"
    public = bool(data.get("public", False))
    now    = int(time.time())
    uid    = request.current_user["id"]
    with _db_lock, get_db() as con:
        con.execute("INSERT INTO playlists (id, user_id, name, public, created_at) VALUES (?,?,?,?,?)",
                    (pl_id, uid, name, int(public), now))
    return jsonify({"id": pl_id, "name": name, "public": public, "tracks": [], "created_at": now}), 201


@app.route("/api/v1/playlists/<pl_id>", methods=["PATCH"])
@auth_required
def update_playlist(pl_id):
    if request.current_user.get("is_guest"):
        return jsonify({"error": "Forbidden"}), 403
    uid  = request.current_user["id"]
    data = request.get_json(force=True)
    with _db_lock, get_db() as con:
        pl = con.execute("SELECT * FROM playlists WHERE id=? AND user_id=?", (pl_id, uid)).fetchone()
        if not pl:
            abort(404)
        name   = data.get("name", pl["name"]).strip() or pl["name"]
        public = int(bool(data.get("public", pl["public"])))
        # Allow updating cover as well
        fields = [name, public]
        sql = "UPDATE playlists SET name=?, public=?"
        if "cover" in data:
            sql += ", cover=?"
            fields.append(data.get("cover"))
        sql += " WHERE id=?"
        fields.append(pl_id)
        con.execute(sql, tuple(fields))
        updated = row_to_dict(con.execute("SELECT * FROM playlists WHERE id=?", (pl_id,)).fetchone())
        updated["tracks"] = [r[0] for r in con.execute(
            "SELECT track_id FROM playlist_tracks WHERE playlist_id=? ORDER BY position", (pl_id,)
        ).fetchall()]
    return jsonify(updated)


@app.route("/api/v1/playlists/<pl_id>/tracks", methods=["POST"])
@auth_required
def add_to_playlist(pl_id):
    if request.current_user.get("is_guest"):
        return jsonify({"error": "Forbidden"}), 403
    uid      = request.current_user["id"]
    data     = request.get_json(force=True)
    track_id = data.get("track_id")
    if not track_id:
        return jsonify({"error": "No track id"}), 400
    with _db_lock, get_db() as con:
        if not con.execute("SELECT 1 FROM playlists WHERE id=? AND user_id=?", (pl_id, uid)).fetchone():
            return jsonify({"error": "Playlist not found"}), 404
        if not con.execute("SELECT 1 FROM tracks WHERE id=? AND user_id=?", (track_id, uid)).fetchone():
            return jsonify({"error": "Track not found"}), 404
        pos = con.execute(
            "SELECT COALESCE(MAX(position)+1,0) FROM playlist_tracks WHERE playlist_id=?", (pl_id,)
        ).fetchone()[0]
        con.execute("INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?,?,?)",
                    (pl_id, track_id, pos))
        track_ids = [r[0] for r in con.execute(
            "SELECT track_id FROM playlist_tracks WHERE playlist_id=? ORDER BY position", (pl_id,)
        ).fetchall()]
        pl = row_to_dict(con.execute("SELECT * FROM playlists WHERE id=?", (pl_id,)).fetchone())
    pl["tracks"] = track_ids
    return jsonify(pl)


@app.route("/api/v1/playlists/<pl_id>/tracks/<track_id>", methods=["DELETE"])
@auth_required
def remove_from_playlist(pl_id, track_id):
    if request.current_user.get("is_guest"):
        return jsonify({"error": "Forbidden"}), 403
    uid = request.current_user["id"]
    with _db_lock, get_db() as con:
        if not con.execute("SELECT 1 FROM playlists WHERE id=? AND user_id=?", (pl_id, uid)).fetchone():
            abort(404)
        con.execute("DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?", (pl_id, track_id))
        track_ids = [r[0] for r in con.execute(
            "SELECT track_id FROM playlist_tracks WHERE playlist_id=? ORDER BY position", (pl_id,)
        ).fetchall()]
        pl = row_to_dict(con.execute("SELECT * FROM playlists WHERE id=?", (pl_id,)).fetchone())
    pl["tracks"] = track_ids
    return jsonify(pl)


@app.route("/api/v1/playlists/<pl_id>", methods=["DELETE"])
@auth_required
def delete_playlist(pl_id):
    if request.current_user.get("is_guest"):
        return jsonify({"error": "Forbidden"}), 403
    uid = request.current_user["id"]
    with _db_lock, get_db() as con:
        if not con.execute("SELECT 1 FROM playlists WHERE id=? AND user_id=?", (pl_id, uid)).fetchone():
            abort(404)
        con.execute("DELETE FROM playlists WHERE id=?", (pl_id,))
    return jsonify({"deleted": pl_id})

# ── History ───────────────────────────────────────────────────────────────────

@app.route("/api/v1/history", methods=["POST"])
@auth_required
def record_history():
    uid      = request.current_user["id"]
    data     = request.get_json(force=True)
    track_id = data.get("track_id")
    if not track_id:
        return jsonify({"error": "No track id"}), 400
    now = int(time.time())
    with _db_lock, get_db() as con:
        if not con.execute("SELECT 1 FROM tracks WHERE id=?", (track_id,)).fetchone():
            return jsonify({"error": "Track not found"}), 404
        con.execute("INSERT INTO history (user_id, track_id, played_at) VALUES (?,?,?)", (uid, track_id, now))
    return jsonify({"track_id": track_id, "played_at": now}), 201


@app.route("/api/v1/history", methods=["GET"])
@auth_required
def get_history():
    uid    = request.current_user["id"]
    limit  = min(int(request.args.get("limit", 100)), 500)
    offset = int(request.args.get("offset", 0))
    with _db_lock, get_db() as con:
        total = con.execute("SELECT COUNT(*) FROM history WHERE user_id=?", (uid,)).fetchone()[0]
        rows  = con.execute(
            "SELECT h.track_id, h.played_at, t.title, t.artist, t.album, t.genre, t.cover, t.duration "
            "FROM history h JOIN tracks t ON t.id=h.track_id "
            "WHERE h.user_id=? ORDER BY h.played_at DESC LIMIT ? OFFSET ?",
            (uid, limit, offset)
        ).fetchall()
    return jsonify({"history": [row_to_dict(r) for r in rows], "total": total})

# ── Media ─────────────────────────────────────────────────────────────────────

@app.route("/api/v1/stream/<track_id>")
@optional_auth
def stream_track(track_id):
    with _db_lock, get_db() as con:
        row = con.execute("SELECT filename, user_id FROM tracks WHERE id=?", (track_id,)).fetchone()
        if not row:
            abort(404)
        
        # Allow guests to stream any track
        if request.current_user and request.current_user.get("is_guest"):
            pass
        else:
            uid = request.current_user["id"] if request.current_user else None
            if row["user_id"] != uid and not is_track_public(con, track_id):
                abort(403)
                
    path = TRACKS_DIR / row["user_id"] / row["filename"]
    if not path.exists():
        abort(404)
    return send_from_directory(path.parent.resolve(), path.name)


@app.route("/api/v1/download/<track_id>")
@optional_auth
def download_track(track_id):
    with _db_lock, get_db() as con:
        row = con.execute("SELECT * FROM tracks WHERE id=?", (track_id,)).fetchone()
    if not row:
        abort(404)
        
    uid = request.current_user["id"] if request.current_user else None
    is_guest = request.current_user.get("is_guest", False) if request.current_user else True
    
    # Гости могут скачивать любые треки, но зарегистрированные пользователи могут скачивать только свои или публичные
    if not is_guest and row["user_id"] != uid:
        with _db_lock, get_db() as con:
            if not is_track_public(con, track_id):
                abort(403)
                
    path = TRACKS_DIR / row["user_id"] / row["filename"]
    if not path.exists():
        abort(404)
    ext = Path(row["filename"]).suffix
    return send_file(path.resolve(), as_attachment=True, download_name=f"{row['artist']} - {row['title']}{ext}")


@app.route("/api/v1/covers/<cover_id>")
@optional_auth
def get_cover(cover_id):
    safe_id = Path(cover_id).name
    with _db_lock, get_db() as con:
        track = con.execute("SELECT id, user_id FROM tracks WHERE cover=?", (safe_id,)).fetchone()
    if not track:
        abort(404)
        
    # Allow guests to see any cover
    if request.current_user and request.current_user.get("is_guest"):
        pass
    else:
        uid  = request.current_user["id"] if request.current_user else None
        if track["user_id"] != uid:
            with _db_lock, get_db() as con:
                if not is_track_public(con, track["id"]):
                    abort(403)
                    
    path = COVERS_DIR / track["user_id"] / f"{safe_id}.jpg"
    if not path.exists():
        abort(404)
    return send_from_directory(path.parent.resolve(), path.name)


@app.route("/api/v1/covers/<track_id>", methods=["POST"])
@auth_required
def upload_cover(track_id):
    if request.current_user.get("is_guest"):
        return jsonify({"error": "Forbidden"}), 403
    uid = request.current_user["id"]
    with _db_lock, get_db() as con:
        row = con.execute("SELECT * FROM tracks WHERE id=? AND user_id=?", (track_id, uid)).fetchone()
        if not row:
            abort(404)
        if "file" not in request.files:
            return jsonify({"error": "No file"}), 400
        f   = request.files["file"]
        ext = Path(f.filename).suffix.lower()
        if ext not in ALLOWED_IMAGE:
            return jsonify({"error": "Unsupported image format"}), 415
        if row["cover"]:
            (COVERS_DIR / uid / f"{row['cover']}.jpg").unlink(missing_ok=True)
        cover_id  = str(uuid.uuid4())
        cover_dir = COVERS_DIR / uid
        cover_dir.mkdir(parents=True, exist_ok=True)
        f.save(cover_dir / f"{cover_id}.jpg")
        con.execute("UPDATE tracks SET cover=? WHERE id=?", (cover_id, track_id))
    return jsonify({"cover": cover_id})

# ── Frontend ──────────────────────────────────────────────────────────────────

@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def index(path=""):
    if path.startswith("api/") or path.startswith("static/"):
        abort(404)
    return render_template("index.html")


@app.route('/manifest.json')
def serve_manifest():
    response = send_from_directory('static', 'manifest.json')
    response.headers['Content-Type'] = 'application/manifest+json'
    return response


@app.route('/sw.js')
def serve_sw():
    response = send_from_directory('static/js', 'sw.js')
    response.headers['Content-Type'] = 'application/javascript'
    response.headers['Service-Worker-Allowed'] = '/'
    return response


if __name__ == "__main__":
    app.run(debug=DEBUG, host=HOST, port=PORT)
