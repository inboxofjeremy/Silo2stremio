const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 7000;

app.use(cors());
app.use(express.json());

// Lightweight session & metadata caches only
const sessionCache = new Map(); // key = `${serverUrl}::${username}` -> { userId, accessToken }
const metaCache = new Map(); // key = `${type}:${baseId}:${season}:${episode}` -> { name, year, epTitle, epReleased }

const EMY_AUTH_HEADER =
  'MediaBrowser Client="SiloStremioBridge", Device="Stremio", DeviceId="silo-stremio-bridge-v1", Version="1.3.9"';

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  if (cfg.userId && cfg.accessToken && !cfg.username) {
    return {
      serverUrl: cfg.serverUrl.replace(/\/+$/, ''),
      userId: cfg.userId,
      accessToken: cfg.accessToken,
    };
  }

  const baseUrl = cfg.serverUrl.replace(/\/+$/, '');
  const key = `${baseUrl}::${cfg.username}`;

  if (!forceRefresh && sessionCache.has(key)) {
    return sessionCache.get(key);
  }

  return authenticateSilo(baseUrl, cfg.username, cfg.password);
}

async function siloGet(cfg, path, params = {}, attempt = 0) {
  let session = await getValidSession(cfg, false);
  try {
    const res = await axios.get(`${session.serverUrl}${path}`, {
      params,
      headers: {
        'X-Emby-Token': session.accessToken,
        'X-Emby-Authorization': EMY_AUTH_HEADER,
      },
      timeout: 15000,
    });
    return { data: res.data, session };
  } catch (err) {
    const status = err.response?.status;

    if ((status === 401 || status === 403) && cfg.username && attempt === 0) {
      console.log('[SiloBridge] Token expired, re-authenticating...');
      await getValidSession(cfg, true);
      return siloGet(cfg, path, params, attempt + 1);
    }

    if (status === 429 && attempt < 2) {
      const retryAfterHeader = Number(err.response?.headers?.['retry-after']);
      const delayMs = !Number.isNaN(retryAfterHeader) && retryAfterHeader > 0
        ? Math.min(retryAfterHeader * 1000, 4000)
        : 600 * (attempt + 1);
      console.log(`[SiloBridge] Hit 429 on ${path}, retrying in ${delayMs}ms...`);
      await sleep(delayMs);
      return siloGet(cfg, path, params, attempt + 1);
    }

    throw err;
  }
}

function parseStremioId(rawId) {
  const parts = String(rawId).split(':');

  if (parts[0].startsWith('tt')) {
    return {
      provider: 'imdb',
      id: parts[0],
      season: parts[1] !== undefined ? Number(parts[1]) : null,
      episode: parts[2] !== undefined ? Number(parts[2]) : null,
    };
  }

  const map = { tmdb: 'tmdb', tvdb: 'tvdb', anidb: 'anidb' };
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

function normalizeTitle(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function resolveCinemetaInfo(type, baseId, season = null, episode = null) {
  const key = `${type}:${baseId}:${season || ''}:${episode || ''}`;
  if (metaCache.has(key)) return metaCache.get(key);

  try {
    const res = await axios.get(
      `https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(baseId)}.json`,
      { timeout: 6000 }
    );
    const meta = res.data?.meta;
    if (meta?.name) {
      let epTitle = null;
      let epReleased = null;

      if (type === 'series' && Array.isArray(meta.videos) && season !== null && episode !== null) {
        const video = meta.videos.find(
          (v) => Number(v.season) === Number(season) && Number(v.episode) === Number(episode)
        );
        if (video) {
          epTitle = video.name || video.title || null;
          epReleased = video.released ? String(video.released).slice(0, 10) : null;
        }
      }

      const info = {
        name: meta.name,
        year: meta.releaseInfo ? parseInt(String(meta.releaseInfo).slice(0, 4), 10) : null,
        imdb_id: meta.imdb_id || (baseId.startsWith('tt') ? baseId : null),
        epTitle,
        epReleased,
      };
      metaCache.set(key, info);
      return info;
    }
  } catch {
    // Ignore Cinemeta timeout/miss
  }
  return null;
}

async function searchSiloOnDemand(cfg, itemType, parsed) {
  const session = await getValidSession(cfg, false);
  const providerKey = `${parsed.provider}.${parsed.id}`;

  // 1. Direct server-side lookup by Provider ID
  const { data: idData, session: activeSession } = await siloGet(
    cfg,
    `/Users/${session.userId}/Items`,
    {
      Recursive: true,
      IncludeItemTypes: itemType,
      AnyProviderIdEquals: providerKey,
      Fields: 'ProviderIds,MediaSources,Path,ProductionYear',
      Limit: 25,
    }
  );

  let items = (idData?.Items || []).filter((item) =>
    matchProviderId(item, parsed.provider, parsed.id)
  );

  if (items.length > 0) {
    return { matches: [items[0]], session: activeSession, method: 'ProviderId' };
  }

  // 2. Fallback: Resolve title via Cinemeta and query Silo's SearchTerm directly
  const baseId = parsed.provider === 'imdb' ? parsed.id : `${parsed.provider}:${parsed.id}`;
  const meta = await resolveCinemetaInfo(itemType === 'Movie' ? 'movie' : 'series', baseId);

  if (meta?.name) {
    const { data: searchData, session: searchSession } = await siloGet(
      cfg,
      `/Users/${session.userId}/Items`,
      {
        Recursive: true,
        IncludeItemTypes: itemType,
        SearchTerm: meta.name,
        Fields: 'ProviderIds,MediaSources,Path,ProductionYear',
        Limit: 25,
      }
    );

    const targetNorm = normalizeTitle(meta.name);
    const candidates = searchData?.Items || [];

    const exactIdMatch = candidates.find((item) =>
      matchProviderId(item, parsed.provider, parsed.id)
    );
    if (exactIdMatch) {
      return { matches: [exactIdMatch], session: searchSession, method: 'SearchTerm+Id' };
    }

    const matchedCandidate = candidates.find((item) => {
      const itemNorm = normalizeTitle(item.Name);
      return (
        itemNorm === targetNorm ||
        itemNorm === `${targetNorm} ca` ||
        itemNorm.startsWith(`${targetNorm} `)
      );
    });

    if (matchedCandidate) {
      return { matches: [matchedCandidate], session: searchSession, method: `Title(${matchedCandidate.Name})` };
    }
  }

  return { matches: [], session: activeSession, method: 'None' };
}

async function getSingleEpisode(cfg, seriesId, targetSeason, targetEpisode, meta = null) {
  const session = await getValidSession(cfg, false);

  async function fetchSeasonEpisodes(seasonNum) {
    try {
      const res = await siloGet(cfg, `/Shows/${seriesId}/Episodes`, {
        UserId: session.userId,
        Season: seasonNum,
        Fields: 'ProviderIds,MediaSources,Path,PremiereDate',
      });
      return { episodes: res.data?.Items || [], session: res.session };
    } catch {
      const res = await siloGet(cfg, `/Users/${session.userId}/Items`, {
        ParentId: seriesId,
        Recursive: true,
        IncludeItemTypes: 'Episode',
        ParentIndexNumber: seasonNum,
        IndexNumber: targetEpisode,
        Fields: 'ProviderIds,MediaSources,Path,PremiereDate',
        Limit: 100,
      });
      return { episodes: res.data?.Items || [], session: res.session };
    }
  }

  // 1. Strictly try exact season + episode index first
  const primary = await fetchSeasonEpisodes(targetSeason);
  const exactMatch = primary.episodes.filter(
    (ep) => Number(ep.IndexNumber) === Number(targetEpisode)
  );
  if (exactMatch.length > 0) {
    return { episodes: exactMatch, session: primary.session };
  }

  // 2. Year-based fallback: match by episode title or premiere air date if seasons are year-indexed
  const currentYear = new Date().getFullYear();
  const airYear = meta?.epReleased ? parseInt(meta.epReleased.slice(0, 4), 10) : null;
  const possibleYears = [...new Set([airYear, currentYear, currentYear - 1, currentYear - 2].filter(Boolean))];

  if (!possibleYears.includes(targetSeason) && (meta?.epTitle || meta?.epReleased)) {
    const targetEpNorm = normalizeTitle(meta.epTitle);

    for (const yearSeason of possibleYears) {
      const yearRes = await fetchSeasonEpisodes(yearSeason);
      if (yearRes.episodes.length === 0) continue;

      let matched = yearRes.episodes.filter((ep) => {
        const epNorm = normalizeTitle(ep.Name);
        return targetEpNorm && (epNorm === targetEpNorm || epNorm.includes(targetEpNorm) || targetEpNorm.includes(epNorm));
      });

      if (matched.length === 0 && meta.epReleased) {
        matched = yearRes.episodes.filter(
          (ep) => ep.PremiereDate && String(ep.PremiereDate).slice(0, 10) === meta.epReleased
        );
      }

      if (matched.length > 0) {
        console.log(
          `[SiloBridge] Year-season match: S${targetSeason}E${targetEpisode} -> S${yearSeason}E${matched[0].IndexNumber} (${matched[0].Name})`
        );
        return { episodes: matched, session: yearRes.session };
      }
    }
  }

  return { episodes: [], session };
}

function formatBytes(bytes) {
  if (!bytes || Number.isNaN(Number(bytes))) return '';
  const gb = Number(bytes) / (1024 ** 3);
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(Number(bytes) / (1024 ** 2)).toFixed(0)} MB`;
}

function buildStreamCards(item, serverUrl, accessToken, seriesTitle = '') {
  const sources =
    Array.isArray(item.MediaSources) && item.MediaSources.length > 0
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

    const details = [resLabel, videoCodec, audioCodec, channels, sizeStr].filter(Boolean).join(' • ');
    const displayName = seriesTitle || 'Direct Stream';

    const subtitles = streams
      .filter((s) => s.Type === 'Subtitle' && s.IsExternal)
      .map((sub) => ({
        id: `${source.Id}-${sub.Index}`,
        lang: sub.Language || 'eng',
        url: `${serverUrl}/Videos/${item.Id}/${source.Id}/Subtitles/${sub.Index}/Stream.vtt?api_key=${accessToken}`,
      }));

    // Standard Emby/StreamBridge static stream route
    const streamUrl = `${serverUrl}/Videos/${item.Id}/stream?static=true&MediaSourceId=${encodeURIComponent(source.Id)}&api_key=${accessToken}`;

    return {
      name: 'Silo',
      title: `${displayName}\n${details}`,
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
    version: '1.3.9',
    name: 'Silo Server',
    description: 'On-demand direct-play stream resolver for Silo Server',
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

app.get('/:config/search', async (req, res) => {
  const cfg = decodeConfig(req.params.config);
  if (!cfg) return res.status(400).json({ error: 'Invalid config' });

  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Provide ?q=search_term' });

  try {
    const session = await getValidSession(cfg, false);
    const { data } = await siloGet(cfg, `/Users/${session.userId}/Items`, {
      Recursive: true,
      IncludeItemTypes: 'Movie,Series',
      SearchTerm: q,
      Fields: 'ProviderIds,MediaSources,ProductionYear',
      Limit: 25,
    });
    const items = (data?.Items || []).map((i) => ({
      Id: i.Id,
      Name: i.Name,
      Type: i.Type,
      Year: i.ProductionYear,
      ProviderIds: i.ProviderIds || {},
    }));
    return res.json({ query: q, count: items.length, items });
  } catch (err) {
    return res.status(500).json({ error: err.message, details: err.response?.data });
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
    const itemType = type === 'movie' ? 'Movie' : 'Series';
    const { matches: foundItems, session, method } = await searchSiloOnDemand(cfg, itemType, parsed);

    let matches = [];
    let activeSession = session;

    const baseId = parsed.provider === 'imdb' ? parsed.id : `${parsed.provider}:${parsed.id}`;
    const epMeta =
      type === 'series' && parsed.season !== null && parsed.episode !== null
        ? await resolveCinemetaInfo('series', baseId, parsed.season, parsed.episode)
        : null;

    if (type === 'movie') {
      matches = foundItems;
    } else if (type === 'series' && parsed.season !== null && parsed.episode !== null) {
      for (const series of foundItems) {
        const epRes = await getSingleEpisode(cfg, series.Id, parsed.season, parsed.episode, epMeta);
        activeSession = epRes.session;
        matches.push(...epRes.episodes);
      }
    }

    console.log(
      `[SiloBridge] On-demand ${type} ${id} via [${method}] -> ${matches.length} stream(s)`
    );

    const streams = matches.flatMap((item) =>
      buildStreamCards(item, activeSession.serverUrl, activeSession.accessToken, foundItems[0]?.Name)
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
      window.location.href = generatedUrl.replace('https://', 'stremio://').replace('http://', 'stremio://');
    }
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Silo Stremio Bridge running on port ${PORT}`);
});
