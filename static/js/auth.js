/**
 * Authentication System for Noxtify
 * Supports guest mode (public content) and user accounts (full features)
 */

// Helper function to generate guest ID (defined before Auth object)
function _generateGuestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return [...bytes]
      .map((b, i) => ([4, 6, 8, 10].includes(i) ? "-" : "") + b.toString(16).padStart(2, "0"))
      .join("");
  }
  return "uid-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const Auth = {
  // ────── State ──────────────────────────────────────────────────────────────
  token: localStorage.getItem("noxtify_token"),
  _pendingUserId: null,
  user: null,
  isGuest: !localStorage.getItem("noxtify_token"),
  guestId: localStorage.getItem("noxtify_user_id") || _generateGuestId(),
  config: { open_registration: true, require_email_verification: false },

  // ────── Initialization ──────────────────────────────────────────────────────
  async init() {
    localStorage.setItem("noxtify_user_id", this.guestId);
    await this._loadAuthConfig();
    if (this.token) {
      const loaded = await this._loadUserFromToken();
      if (!loaded) {
        this._clearAuth();
      } else {
        // User is logged in, close auth modal
        this._closeAuthModal();
      }
    }
    this._setupEventListeners();
    this._updateUI();
    return this.user;
  },

  async _loadAuthConfig() {
    try {
      const res = await fetch("/api/v1/auth/config");
      if (res.ok) {
        this.config = await res.json();
      }
    } catch (error) {
      console.warn("Failed to load auth config:", error);
    }
  },

  async _loadUserFromToken() {
    try {
      const res = await fetch("/api/v1/auth/me", {
        headers: { Authorization: `Bearer ${this.token}` }
      });
      if (res.ok) {
        this.user = await res.json();
        this.isGuest = false;
        return true;
      } else if (res.status === 401) {
        return false;
      }
    } catch (error) {
      console.warn("Failed to load user:", error);
    }
    return false;
  },

  _setupEventListeners() {
    const loginView = document.getElementById("auth-login-view");
    const registerView = document.getElementById("auth-register-view");
    
    if (loginView) {
      const btnLogin = document.getElementById("btn-do-login");
      const btnRegister = document.getElementById("btn-go-register");
      if (btnLogin) btnLogin.addEventListener("click", () => this._handleLogin());
      if (btnRegister) btnRegister.addEventListener("click", () => this._showRegisterView());
    }

    if (registerView) {
      const btnDoRegister = document.getElementById("btn-do-register");
      const btnGoLogin = document.getElementById("btn-go-login");
      if (btnDoRegister) btnDoRegister.addEventListener("click", () => this._handleRegister());
      if (btnGoLogin) btnGoLogin.addEventListener("click", () => this._showLoginView());
    }

    // Logout button
    const btnLogout = document.getElementById("btn-logout");
    if (btnLogout) btnLogout.addEventListener("click", () => this.logout());

    // Перепиши обработчик btn-verify-back:
    const btnVerifyBack = document.getElementById("btn-verify-back");
    if (btnVerifyBack) btnVerifyBack.addEventListener("click", () => this._showLoginView());

    // Close modal on backdrop click
    const authBackdrop = document.getElementById("auth-backdrop");
    if (authBackdrop) {
      authBackdrop.addEventListener("click", (e) => {
        if (e.target === authBackdrop) this._closeAuthModal();
      });
    }

    // Allow Enter key to submit
    const loginField = document.getElementById("login-field");
    const loginPassword = document.getElementById("login-password");
    if (loginField) loginField.addEventListener("keypress", (e) => e.key === "Enter" && this._handleLogin());
    if (loginPassword) loginPassword.addEventListener("keypress", (e) => e.key === "Enter" && this._handleLogin());

    const regUsername = document.getElementById("reg-username");
    const regEmail = document.getElementById("reg-email");
    const regPassword = document.getElementById("reg-password");
    if (regPassword) regPassword.addEventListener("keypress", (e) => e.key === "Enter" && this._handleRegister());

    const btnVerify = document.getElementById("btn-do-verify");
    if (btnVerify) btnVerify.addEventListener("click", () => this._handleVerify());

    const verifyCode = document.getElementById("verify-code");
    if (verifyCode) verifyCode.addEventListener("keypress", e => e.key === "Enter" && this._handleVerify());

  },

  // ────── Login ──────────────────────────────────────────────────────────────
  async _handleLogin() {
    const loginField = document.getElementById("login-field");
    const loginPassword = document.getElementById("login-password");
    const authError = document.getElementById("auth-error");

    if (!loginField || !loginPassword) return;

    const login = loginField.value.trim();
    const password = loginPassword.value;

    if (!login || !password) {
      this._showError("auth-error", "Все поля обязательны");
      return;
    }

    const loginBtn = document.getElementById("btn-do-login");
    if (loginBtn) loginBtn.disabled = true;

    try {
      const res = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login, password })
      });

      if (res.ok) {
        const data = await res.json();
        this._setAuth(data.token, data.user);
        this._closeAuthModal();
        window.location.reload();
      } else {
        const error = await res.json().catch(() => ({ error: "Unknown error" }));
        this._showError("auth-error", error.error || "Не верный email/пароль");
      }
    } catch (error) {
      console.error("Login failed:", error);
      this._showError("auth-error", "Ошибка соединения");
    } finally {
      if (loginBtn) loginBtn.disabled = false;
    }
  },

  // ────── Register ──────────────────────────────────────────────────────────
  async _handleRegister() {
    const username = document.getElementById("reg-username")?.value.trim();
    const email = document.getElementById("reg-email")?.value.trim();
    const password = document.getElementById("reg-password")?.value;

    if (!username || !email || !password) {
      this._showError("auth-reg-error", "Все поля обязательны");
      return;
    }

    if (username.length < 3) {
      this._showError("auth-reg-error", "Имя должно содержать минимум 3 символа");
      return;
    }

    if (password.length < 6) {
      this._showError("auth-reg-error", "Пароль должен содержать минимум 6 символов");
      return;
    }

    const regBtn = document.getElementById("btn-do-register");
    if (regBtn) regBtn.disabled = true;

    try {
      const res = await fetch("/api/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, email, password })
      });

      if (res.ok) {
        const data = await res.json();
        if (this.config.require_email_verification) {
          this._pendingUserId = data.user_id;
          this._showVerifyView();
        } else {
          this._setAuth(data.token, data.user);
          this._closeAuthModal();
          window.location.reload();
        }
      } else {
        const error = await res.json().catch(() => ({}));
        this._showError("auth-reg-error", error.error || "Ошибка регистрации");
      }
    } catch (error) {
      console.error("Register failed:", error);
      this._showError("auth-reg-error", "Ошибка соединения");
    } finally {
      if (regBtn) regBtn.disabled = false;
    }
  },

  _showVerifyView() {
    document.getElementById("auth-login-view").style.display = "none";
    document.getElementById("auth-register-view").style.display = "none";
    document.getElementById("auth-verify-view").style.display = "block";
    setTimeout(() => document.getElementById("verify-code")?.focus(), 100);
  },

  async _handleVerify() {
    const code = document.getElementById("verify-code")?.value.trim();
    if (!code || code.length !== 6) {
      this._showError("auth-verify-error", "Введи 6-значный код");
      return;
    }
    const btn = document.getElementById("btn-do-verify");
    if (btn) btn.disabled = true;
    try {
      const res = await fetch("/api/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: this._pendingUserId, code })
      });
      if (res.ok) {
        const data = await res.json();
        this._setAuth(data.token, data.user);
        this._closeAuthModal();
        window.location.reload();
      } else {
        const error = await res.json().catch(() => ({}));
        this._showError("auth-verify-error", error.error || "Неверный код");
      }
    } catch {
      this._showError("auth-verify-error", "Ошибка соединения");
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  // ────── Auth Token Management ──────────────────────────────────────────────
  _setAuth(token, user) {
    this.token = token;
    this.user = user;
    this.isGuest = false;
    localStorage.setItem("noxtify_token", token);
    localStorage.setItem("noxtify_user", JSON.stringify(user));
    this._updateUI();
  },

  _clearAuth() {
    this.token = null;
    this.user = null;
    this.isGuest = true;
    localStorage.removeItem("noxtify_token");
    localStorage.removeItem("noxtify_user");
    this._updateUI();
  },

  logout() {
    this._clearAuth();
    window.location.reload();
  },

  // ────── UI Updates ──────────────────────────────────────────────────────────
  _updateUI() {
    const avatar = document.querySelector(".avatar");
    if (!avatar) return;

    // Avatar should always be clickable
    avatar.style.display = "flex";
    avatar.style.cursor = "pointer";

    if (this.user) {
      avatar.setAttribute("title", `${this.user.username} (${this.user.email})`);
      // Show user initials in avatar
      const initials = (this.user.username || "U").substring(0, 1).toUpperCase();
      avatar.textContent = initials;
      avatar.onclick = () => this._showUserMenu();
    } else {
      avatar.setAttribute("title", "Войти или зарегистрироваться");
      // Show login icon
      avatar.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#888888"><path d="M480-481q-66 0-108-42t-42-108q0-66 42-108t108-42q66 0 108 42t42 108q0 66-42 108t-108 42ZM160-160v-94q0-38 19-65t49-44q67-30 128.5-45T480-418q63 0 124.5 15T733-358q30 17 49 44t19 65v94H160Z"/></svg>';
      avatar.onclick = () => this.showAuthModal();
    }
  },

  _showUserMenu() {
    // Show profile popup menu
    const avatar = document.querySelector(".avatar");
    const profilePopup = document.getElementById("profile-popup");
    if (!profilePopup || !avatar) return;
    
    const userInfo = {
      username: this.user?.username || "User",
      email: this.user?.email || ""
    };
    
    const usernameEl = document.getElementById("profile-username");
    const emailEl = document.getElementById("profile-email");
    const profileAvatarEl = document.getElementById("profile-avatar");
    
    if (usernameEl) usernameEl.textContent = userInfo.username;
    if (emailEl) emailEl.textContent = userInfo.email;
    if (profileAvatarEl) {
      const initials = (userInfo.username || "U").substring(0, 1).toUpperCase();
      profileAvatarEl.textContent = initials;
    }
    
    profilePopup.style.display = profilePopup.style.display === "flex" ? "none" : "flex";
    
    // Close on outside click
    const closeHandler = (e) => {
      if (!profilePopup.contains(e.target) && !avatar.contains(e.target)) {
        profilePopup.style.display = "none";
        document.removeEventListener("click", closeHandler);
      }
    };
    setTimeout(() => document.addEventListener("click", closeHandler), 100);
  },

  _showError(elementId, message) {
    const element = document.getElementById(elementId);
    if (element) {
      element.textContent = message;
      element.style.display = "block";
    }
  },

  _showVerificationNotice(message) {
    const notice = document.getElementById("auth-verify-notice");
    if (notice) {
      const text = notice.querySelector("p");
      if (text) text.textContent = message;
      notice.style.display = "block";
    }
  },

  _showLoginView() {
    document.getElementById("auth-login-view").style.display = "block";
    document.getElementById("auth-register-view").style.display = "none";
    document.getElementById("auth-verify-view").style.display = "none";
    this._pendingUserId = null;
  },

  _showRegisterView() {
    const loginView = document.getElementById("auth-login-view");
    const registerView = document.getElementById("auth-register-view");
    if (loginView) loginView.style.display = "none";
    if (registerView) registerView.style.display = "block";
    document.getElementById("auth-reg-error")?.style.display === "none";
  },

  _closeAuthModal() {
    const backdrop = document.getElementById("auth-backdrop");
    if (backdrop) backdrop.classList.remove("open");
  },

  // ────── Permission & Access Control ────────────────────────────────────────
  
  /**
   * Check if user can access a track
   * Guest: only public tracks
   * Authenticated: own tracks + public tracks
   */
  canAccessTrack(track) {
    if (!track) return false;
    
    // Own track
    if (this.user && track.user_id === this.user.id) return true;
    
    // Public track (check if it's in a public playlist)
    // This check should be done on backend, here we assume backend handles it
    return false;
  },

  /**
   * Check if user can modify a track
   * Only owner can modify
   */
  canModifyTrack(track) {
    return this.user && track.user_id === this.user.id;
  },

  /**
   * Check if user can access a playlist
   * Guest: only public playlists
   * Authenticated: own playlists + public playlists
   */
  canAccessPlaylist(playlist) {
    if (!playlist) return false;
    
    // Own playlist
    if (this.user && playlist.user_id === this.user.id) return true;
    
    // Public playlist
    if (playlist.public) return true;
    
    return false;
  },

  /**
   * Check if user can modify a playlist
   * Only owner can modify
   */
  canModifyPlaylist(playlist) {
    return this.user && playlist.user_id === this.user.id;
  },

  // ────── API Helpers ────────────────────────────────────────────────────────

  /**
   * Get authorization header for API requests
   * If authenticated: use JWT token
   * If guest: use guest ID
   */
  getAuthHeader() {
    const headers = { "X-User-Id": this.guestId };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }
    return headers;
  },

  /**
   * Make authenticated API request
   */
  async apiRequest(method = "GET", path = "/", data = null, options = {}) {
    const url = path.startsWith("/") ? path : "/" + path;
    const fetchOptions = {
      method,
      headers: {
        ...this.getAuthHeader(),
        ...options.headers
      }
    };

    if (data) {
      fetchOptions.headers["Content-Type"] = "application/json";
      fetchOptions.body = JSON.stringify(data);
    }

    try {
      const response = await fetch(url, fetchOptions);
      
      // Handle 401 - token expired
      if (response.status === 401 && this.token) {
        this._clearAuth();
        // Show login modal
        const backdrop = document.getElementById("auth-backdrop");
        if (backdrop) backdrop.classList.add("open");
        throw new Error("Session expired. Please login again.");
      }

      return response;
    } catch (error) {
      console.error(`API request failed (${method} ${url}):`, error);
      throw error;
    }
  },

  // ────── Public Content Discovery ────────────────────────────────────────────

  /**
   * Get public playlists
   * Available to both guest and authenticated users
   */
  async getPublicPlaylists(query = "", limit = 50, offset = 0) {
    const params = new URLSearchParams({ q: query, limit, offset });
    const response = await this.apiRequest("GET", `/api/v1/playlists/public?${params}`);
    if (!response.ok) throw new Error("Failed to fetch public playlists");
    return response.json();
  },

  /**
   * Get public playlist details
   * Available to both guest and authenticated users
   */
  async getPublicPlaylist(playlistId) {
    const response = await this.apiRequest("GET", `/api/v1/playlists/${playlistId}`);
    if (!response.ok) throw new Error("Failed to fetch playlist");
    return response.json();
  },

  // ────── User Content (Authenticated Only) ──────────────────────────────────

  /**
   * Get user's own tracks
   * Requires authentication
   */
  async getUserTracks(query = "", filters = {}, limit = 100, offset = 0) {
    if (!this.user) throw new Error("Authentication required");

    const params = new URLSearchParams({
      q: query,
      limit,
      offset,
      sort: "created_at",
      order: "desc"
    });

    if (filters.artist) params.set("artist", filters.artist);
    if (filters.genre) params.set("genre", filters.genre);

    const response = await this.apiRequest("GET", `/api/v1/tracks?${params}`);
    if (!response.ok) throw new Error("Failed to fetch tracks");
    return response.json();
  },

  /**
   * Get user's playlists
   * Requires authentication
   */
  async getUserPlaylists() {
    if (!this.user) throw new Error("Authentication required");

    const response = await this.apiRequest("GET", "/api/v1/playlists");
    if (!response.ok) throw new Error("Failed to fetch playlists");
    return response.json();
  },

  /**
   * Create new playlist
   * Requires authentication
   */
  async createPlaylist(name = "New Playlist", isPublic = false) {
    if (!this.user) throw new Error("Authentication required");

    const response = await this.apiRequest("POST", "/api/v1/playlists", {
      name,
      public: isPublic
    });
    if (!response.ok) throw new Error("Failed to create playlist");
    return response.json();
  },

  /**
   * Upload track
   * Requires authentication
   */
  async uploadTrack(file, metadata = {}) {
    if (!this.user) throw new Error("Authentication required");

    const formData = new FormData();
    formData.append("file", file);
    
    if (metadata.title) formData.append("title", metadata.title);
    if (metadata.artist) formData.append("artist", metadata.artist);
    if (metadata.album) formData.append("album", metadata.album);
    if (metadata.genre) formData.append("genre", metadata.genre);

    const response = await this.apiRequest("POST", "/api/v1/tracks", null, {
      headers: { ...this.getAuthHeader() },
      method: "POST",
      body: formData
    });

    if (!response.ok) throw new Error("Failed to upload track");
    return response.json();
  },

  /**
   * Record track play in history
   * Requires authentication
   */
  async recordPlay(trackId) {
    if (!this.user) return; // Guest doesn't have history

    await this.apiRequest("POST", "/api/v1/history", { track_id: trackId });
  },

  /**
   * Get play history
   * Requires authentication
   */
  async getHistory(limit = 100, offset = 0) {
    if (!this.user) throw new Error("Authentication required");

    const response = await this.apiRequest("GET", `/api/v1/history?limit=${limit}&offset=${offset}`);
    if (!response.ok) throw new Error("Failed to fetch history");
    return response.json();
  },

  // ────── Show Auth Modal ────────────────────────────────────────────────────
  showAuthModal() {
    const backdrop = document.getElementById("auth-backdrop");
    if (backdrop) backdrop.classList.add("open");
  },

  hideAuthModal() {
    const backdrop = document.getElementById("auth-backdrop");
    if (backdrop) backdrop.classList.remove("open");
  }
};

// Initialize auth system when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => Auth.init());
} else {
  Auth.init();
}
