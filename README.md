# Noxtify - Personal Music Streaming

A self-hosted Spotify alternative with support for downloading from Spotify playlists.

## Installation

### Prerequisites
- Python 3.8+
- FFmpeg (required by spotdl)

### Windows Setup

1. **Install FFmpeg:**
   ```bash
   choco install ffmpeg
   # Or download from https://ffmpeg.org/download.html
   ```

2. **Clone and setup:**
   ```bash
   pip install -r requirements.txt
   ```

3. **Configure (edit `noxtify.cfg`):**
   ```ini
   [app]
   secret_key = your-random-secret-here
   debug = true
   host = 0.0.0.0
   port = 5000
   ```

4. **Run:**
   ```bash
   python app.py
   ```

### Linux/MacOS Setup

```bash
# Install FFmpeg
# Ubuntu:
sudo apt install ffmpeg

# MacOS:
brew install ffmpeg

# Install dependencies
pip install -r requirements.txt

# Run
python app.py
```

## Features

### Upload Local Music
- Upload MP3, FLAC, OGG, WAV, M4A files
- Auto-extract metadata (title, artist, album, cover)

### Download from Spotify
**Single Track:**
```bash
POST /api/v1/tracks/download-spotify
{
  "url": "https://open.spotify.com/track/...",
  "public": true
}
```

**Entire Playlist:**
```bash
POST /api/v1/playlists/download-spotify
{
  "url": "https://open.spotify.com/playlist/...",
  "name": "My Playlist"
}
```

### Create Playlists
- Organize downloaded tracks
- Public/private playlists
- Share playlists with others

## How It Works

The Spotify downloader uses **spotdl** which:
1. Fetches metadata from Spotify (no login required!)
2. Searches for matching tracks on YouTube Music
3. Downloads audio in high quality (~320kbps MP3)
4. Saves to your Noxtify library

**Why YouTube Music?**
- No DRM protection
- Better availability globally
- Legal and safe

## API Endpoints

### Tracks
- `GET /api/v1/tracks` - List tracks
- `POST /api/v1/tracks` - Upload file
- `POST /api/v1/tracks/download-spotify` - Download from Spotify
- `PATCH /api/v1/tracks/<id>` - Edit metadata
- `DELETE /api/v1/tracks/<id>` - Delete track

### Playlists
- `GET /api/v1/playlists` - List user playlists
- `POST /api/v1/playlists` - Create playlist
- `POST /api/v1/playlists/download-spotify` - Import Spotify playlist
- `POST /api/v1/playlists/<id>/tracks` - Add track
- `DELETE /api/v1/playlists/<id>/tracks/<track_id>` - Remove track

### Auth
- `POST /api/v1/auth/register` - Register
- `POST /api/v1/auth/login` - Login
- `GET /api/v1/auth/me` - Current user

## Troubleshooting

**"spotdl not installed"**
```bash
pip install spotdl
```

**"ffmpeg not found"**
Make sure FFmpeg is installed and in your PATH.

**"Download timeout"**
Your internet is slow or the playlist is very large. Try downloading a single track first.

## Legal Notice

This software is for personal use only. It downloads music from YouTube Music based on Spotify metadata. Users are responsible for complying with YouTube Music and Spotify's terms of service.
