const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 7000;

app.use(cors());
app.use(express.json());

// In-memory caches
const sessionCache = new Map(); // key = `${serverUrl}::${username}` -> { userId, accessToken }
const libraryCache = new Map(); // key = `${serverUrl}::${userId}` -> { timestamp, items }
const CACHE_TTL_MS = 5 * 60 * 1000;

const EMY_AUTH_HEADER =
  'MediaBrowser Client="SiloStremioBridge", Device="Stremio", DeviceId="silo-stremio-bridge-v1", Version="1.0.0"';

function encodeConfig(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function decodeConfig(encoded) {
  try {
    const raw = Buffer.from(encoded, 'base64url').toString('utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function authenticateSilo(serverUrl, username, password) {
  const baseUrl = serverUrl.replace(/\/+$/, '');
  const res = await axios.post(
    `${baseUrl}/Users/AuthenticateByName`,
    { Username: username, Pw: password || '' },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Emby-Authorization': EMY_AUTH_HEADER,
      },
      timeout: 15000,
    }
  );

  const userId = res.data?.User?.Id || res.data?.SessionInfo?.UserId;
  const accessToken = res.data?.AccessToken;

  if (!userId || !accessToken) {
    throw new Error('Authentication succeeded but UserId or AccessToken was missing.');
  }

  const session = { serverUrl: baseUrl, userId, accessToken };
  sessionCache.set(`${baseUrl}::${username}`, session);
  return session;
}

async function getValidSession(cfg, forceRefresh = false) {
  // Support legacy tokens if someone still uses an old manifest URL
  if (cfg.userId && cfg.accessToken && !cfg.username) {
    return { serverUrl: cfg.serverUrl.replace(/\/+$/, ''), userId: cfg.userId, accessToken: cfg.accessToken };
  }

  const baseUrl = cfg.serverUrl.replace(/\/+$/, '');
  const key = `${baseUrl}::${cfg.username}`;

  if (!forceRefresh && sessionCache.has(key)) {
    return sessionCache.get(key);
  }

  return authenticateSilo(baseUrl, cfg.username, cfg.password);
}

async function fetchItemsFromSilo(session) {
  return axios.get(`${session.serverUrl}/Users/${session.userId}/Items`, {
    params: {
      Recursive: true,
      IncludeItemTypes: 'Movie,Series,Episode',
      Fields: 'ProviderIds,MediaSources,Path',
    },
    headers: {
      'X-Emby-Token': session.accessToken,
      'X-Emby-Authorization': EMY_AUTH_HEADER,
    },
    timeout: 20000,
  });
}

async function getSiloLibrary(cfg) {
  let session = await getValidSession(cfg, false);
  const cacheKey = `${session.serverUrl}::${session.userId}`;
  const cached = libraryCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return { items: cached.items, session };
  }

  let res;
  try {
    res = await fetchItemsFromSilo(session);
  } catch (err) {
    // If Silo expired the token (401/403), force a fresh login and retry once
    if (err.response && (err.response.status === 401 || err.response.status === 403) && cfg.username) {
      console.log('[SiloBridge] Token expired, re-authenticating...');
      session = await getValidSession(cfg, true);
      res = await fetchItemsFromSilo(session);
    } else {
      throw err;
    }
  }

  const items = res.data?.Items || [];
  libraryCache.set(cacheKey, { timestamp: Date.now(), items });
  return { items, session };
}

function parseStremioId(rawId) {
  const parts = String(rawId).split(':');

  if (parts[0].startsWith('tt')) {
    return {
      provider: 'Imdb',
      id: parts[0],
      season: parts[1] !== undefined ? Number(parts[1]) : null,
      episode: parts[2] !== undefined ? Number(parts[2]) : null,
    };
  }

  const map = { tmdb: 'Tmdb', tvdb: 'Tvdb', anidb: 'AniDB' };
  const provider = map[parts[0].toLowerCase()];
  if (provider && parts[1]) {
    return {
      provider,
      id: parts[1],
      season: parts[2] !== undefined ? Number(parts[2]) : null,
      episode: parts[3] !== undefined ? Number(parts[3]) : null,
    };
  }

  return null;
}

function matchProviderId(item, provider, targetId) {
  if (!item?.ProviderIds) return false;
  for (const [key, val] of Object.entries(item.ProviderIds)) {
    if (key.toLowerCase() === provider.toLowerCase() && String(val) === String(targetId)) {
      return true;
    }
  }
  return false;
}

function formatBytes(bytes) {
  if (!bytes || Number.isNaN(Number(bytes))) return '';
  const gb = Number(bytes) / (1024 ** 3);
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(Number(bytes) / (1024 ** 2)).toFixed(0)} MB`;
}

function buildStreamCards(item, serverUrl, accessToken) {
  const sources = Array.isArray(item.MediaSources) && item.MediaSources.length > 0
    ? item.MediaSources
    : [{ Id: item.Id, Container: 'mp4', MediaStreams: [] }];

  return sources.map((source) => {
    const streams = source.MediaStreams || [];
    const video = streams.find((s) => s.Type === 'Video') || {};
    const audio = streams.find((s) => s.Type === 'Audio') || {};

    let resLabel = 'Direct Play';
    if (video.Height >= 2100 || video.Width >= 3800) resLabel = '4K';
    else if (video.Height >= 1000 || video.Width >= 1900) resLabel = '1080p';
    else if (video.Height >= 700 || video.Width >= 1200) resLabel = '720p';
    else if (video.Height) resLabel = `${video.Height}p`;

    const videoCodec = video.Codec ? video.Codec.toUpperCase() : '';
    const audioCodec = audio.Codec ? audio.Codec.toUpperCase() : '';
    const channels = audio.Channels ? `${audio.Channels}ch` : '';
    const sizeStr = formatBytes(source.Size);

    const details = [videoCodec, audioCodec, channels, sizeStr].filter(Boolean).join(' • ');
    const fileName = source.Name || item.Name || 'Direct Stream';

    const subtitles = streams
      .filter((s) => s.Type === 'Subtitle' && s.IsExternal)
      .map((sub) => ({
        id: `${source.Id}-${sub.Index}`,
        lang: sub.Language || 'eng',
        url: `${serverUrl}/Videos/${item.Id}/${source.Id}/Subtitles/${sub.Index}/Stream.vtt?api_key=${accessToken}`,
      }));

    const containerExt = source.Container ? `.${source.Container.split(',')[0]}` : '';
    const streamUrl = `${serverUrl}/Videos/${item.Id}/stream${containerExt}?static=true&MediaSourceId=${source.Id}&api_key=${accessToken}`;

    return {
      name: `Silo\n${resLabel}`,
      title: `${fileName}${details ? `\n${details}` : ''}`,
      url: streamUrl,
      ...(subtitles.length > 0 ? { subtitles } : {}),
      behaviorHints: {
        notWebReady: false,
        bingeGroup: `silo-${resLabel}`,
      },
    };
  });
}

function getManifest(configured = false) {
  return {
    id: 'org.silo.stremio.bridge',
    version: '1.1.0',
    name: 'Silo Server',
    description: 'Direct-play stream resolver for Silo Server (auto-refreshing session)',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'tmdb:', 'tvdb:', 'anidb:'],
    catalogs: [],
    behaviorHints: {
      configurable: true,
      configurationRequired: !configured,
    },
  };
}

app.get('/', (_req, res) => {
  res.redirect('/configure');
});

app.get('/manifest.json', (_req, res) => {
  res.json(getManifest(false));
});

app.get('/:config/manifest.json', (req, res) => {
  const cfg = decodeConfig(req.params.config);
  const isConfigured = Boolean(cfg?.serverUrl && (cfg?.username || (cfg?.userId && cfg?.accessToken)));
  res.json(getManifest(isConfigured));
});

app.post('/api/auth', async (req, res) => {
  const { serverUrl, username, password } = req.body || {};
  if (!serverUrl || !username) {
    return res.status(400).json({ error: 'Server URL and Username are required.' });
  }

  try {
    const baseUrl = serverUrl.replace(/\/+$/, '');
    const session = await authenticateSilo(baseUrl, username, password || '');
    // Store credentials so the bridge can auto-refresh expired tokens on demand
    const tokenConfig = encodeConfig({
      serverUrl: baseUrl,
      username,
      password: password || '',
    });

    return res.json({
      userId: session.userId,
      configToken: tokenConfig,
    });
  } catch (err) {
    const status = err.response?.status || 500;
    const msg =
      err.response?.data?.Message ||
      err.response?.data?.error ||
      err.message ||
      'Failed to connect to Silo Server.';
    return res.status(status).json({ error: msg });
  }
});

app.get('/:config/stream/:type/:id.json', async (req, res) => {
  const { config, type, id } = req.params;
  const cfg = decodeConfig(config);

  if (!cfg?.serverUrl || (!cfg?.username && !cfg?.accessToken)) {
    return res.json({ streams: [] });
  }

  const parsed = parseStremioId(id);
  if (!parsed) {
    return res.json({ streams: [] });
  }

  try {
    const { items, session } = await getSiloLibrary(cfg);
    let matches = [];

    if (type === 'movie') {
      matches = items.filter(
        (item) => item.Type === 'Movie' && matchProviderId(item, parsed.provider, parsed.id)
      );
    } else if (type === 'series' && parsed.season !== null && parsed.episode !== null) {
      const seriesIds = new Set(
        items
          .filter(
            (item) => item.Type === 'Series' && matchProviderId(item, parsed.provider, parsed.id)
          )
          .map((s) => s.Id)
      );

      matches = items.filter(
        (item) =>
          item.Type === 'Episode' &&
          seriesIds.has(item.SeriesId) &&
          Number(item.ParentIndexNumber) === parsed.season &&
          Number(item.IndexNumber) === parsed.episode
      );
    }

    console.log(`[SiloBridge] Lookup ${type} ${id} -> ${matches.length} match(es) out of ${items.length} library items`);

    const streams = matches.flatMap((item) =>
      buildStreamCards(item, session.serverUrl, session.accessToken)
    );

    return res.json({ streams });
  } catch (err) {
    console.error('[SiloBridge] Stream lookup failed:', err.response?.status || '', err.message);
    return res.json({ streams: [] });
  }
});

app.get(['/configure', '/:config/configure'], (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Silo Server — Stremio & AIOStreams Bridge</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f1117; color: #e5e7eb; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 16px; }
    .card { background: #181b23; border: 1px solid #2a2f3d; border-radius: 12px; padding: 28px; width: 100%; max-width: 460px; box-shadow: 0 12px 32px rgba(0,0,0,0.4); }
    h1 { font-size: 1.35rem; margin: 0 0 6px; color: #fff; }
    p.sub { font-size: 0.9rem; color: #9ca3af; margin: 0 0 20px; }
    label { display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 6px; color: #d1d5db; }
    input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid #374151; background: #0f1117; color: #fff; font-size: 0.95rem; margin-bottom: 14px; }
    input:focus { outline: none; border-color: #6366f1; }
    .hint { font-size: 0.78rem; color: #9ca3af; margin: -10px 0 14px; }
    button { width: 100%; padding: 11px; border: none; border-radius: 8px; font-size: 0.95rem; font-weight: 600; cursor: pointer; background: #6366f1; color: #fff; transition: background 0.15s; }
    button:hover { background: #4f46e5; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .result { margin-top: 18px; padding: 14px; border-radius: 8px; background: #0f1117; border: 1px solid #2a2f3d; display: none; }
    .result.error { border-color: #ef4444; color: #fca5a5; }
    .manifest-box { word-break: break-all; font-family: monospace; font-size: 0.82rem; color: #a5b4fc; background: #141720; padding: 10px; border-radius: 6px; margin: 10px 0; }
    .btn-row { display: flex; gap: 8px; margin-top: 10px; }
    .btn-secondary { background: #262b38; }
    .btn-secondary:hover { background: #323848; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Silo Server Bridge</h1>
    <p class="sub">Connect your Silo Server library to Stremio or AIOStreams.</p>

    <label for="serverUrl">Silo Compatibility Server URL</label>
    <input id="serverUrl" type="url" placeholder="https://bmsilo1-jf.appboxmanager.xyz" required />
    <div class="hint">Use your Silo Jellyfin/Emby compatibility URL (no trailing slash).</div>

    <label for="username">Username</label>
    <input id="username" type="text" placeholder="Username or Username#ProfileName" required />
    <div class="hint">Include #ProfileName if you use Silo household profiles.</div>

    <label for="password">Password</label>
    <input id="password" type="password" placeholder="Password (or Password#PIN)" />

    <button id="connectBtn" onclick="connectSilo()">Generate Manifest URL</button>

    <div id="errorBox" class="result error"></div>

    <div id="successBox" class="result">
      <div style="font-size:0.85rem;font-weight:600;color:#34d399;">Connected! Copy this Manifest URL into Stremio or AIOStreams:</div>
      <div id="manifestUrl" class="manifest-box"></div>
      <div class="btn-row">
        <button type="button" class="btn-secondary" onclick="copyManifest()">Copy Manifest URL</button>
        <button type="button" onclick="installStremio()">Install in Stremio</button>
      </div>
    </div>
  </div>

  <script>
    let generatedUrl = '';

    async function connectSilo() {
      const btn = document.getElementById('connectBtn');
      const errorBox = document.getElementById('errorBox');
      const successBox = document.getElementById('successBox');
      errorBox.style.display = 'none';
      successBox.style.display = 'none';

      const serverUrl = document.getElementById('serverUrl').value.trim();
      const username = document.getElementById('username').value.trim();
      const password = document.getElementById('password').value;

      if (!serverUrl || !username) {
        errorBox.textContent = 'Please enter both Server URL and Username.';
        errorBox.style.display = 'block';
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Connecting to Silo...';

      try {
        const res = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverUrl, username, password })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Login failed');

        generatedUrl = window.location.origin + '/' + data.configToken + '/manifest.json';
        document.getElementById('manifestUrl').textContent = generatedUrl;
        successBox.style.display = 'block';
      } catch (err) {
        errorBox.textContent = err.message;
        errorBox.style.display = 'block';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Generate Manifest URL';
      }
    }

    function copyManifest() {
      if (!generatedUrl) return;
      navigator.clipboard.writeText(generatedUrl);
      alert('Manifest URL copied!');
    }

    function installStremio() {
      if (!generatedUrl) return;
      window.location.href = generatedUrl.replace(/^https?:\/\//, 'stremio://');
    }
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Silo Stremio Bridge running on port ${PORT}`);
});
