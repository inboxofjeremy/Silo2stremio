const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 7000;

app.use(cors());
app.use(express.json());

// Lightweight session, metadata, ID-map, and short-TTL stream caches
const sessionCache = new Map(); // key = `${serverUrl}::${username}` -> { userId, accessToken }
const metaCache = new Map(); // key = `${type}:${baseId}:${season}:${episode}` -> { name, year, epTitle, epReleased }
const idMapCache = new Map(); // key = `${itemType}:${provider}:${id}` -> Array<{ provider, id }>
const streamCache = new Map(); // key = `${config}::${type}::${id}` -> { expiresAt, streams }
const inflightLookups = new Map(); // key = `${config}::${type}::${id}` -> Promise

const STREAM_CACHE_TTL_MS = 60 * 1000;

const EMY_AUTH_HEADER =
  'MediaBrowser Client="SiloStremioBridge", Device="Stremio", DeviceId="silo-stremio-bridge-v1", Version="1.4.0"';

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
      const delayMs =
        !Number.isNaN(retryAfterHeader) && retryAfterHeader > 0
          ? Math.min(retryAfterHeader * 1000, 4000)
          : 750 * (attempt + 1);
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

  const map = { tmdb: 'tmdb', tvdb: 'tvdb' };
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

  // 1. Try Cinemeta first
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
    // Fall through to TVMaze fallback for series
  }

  // 2. Fallback to TVMaze for series when Cinemeta misses
  if (type === 'series') {
    try {
      const [prefix, rawVal] = baseId.includes(':') ? baseId.split(':') : ['imdb', baseId];
      let showData = null;

      if (prefix === 'imdb' && rawVal.startsWith('tt')) {
        const r = await axios.get(
          `https://api.tvmaze.com/lookup/shows?imdb=${encodeURIComponent(rawVal)}`,
          { timeout: 6000 }
        );
        showData = r.data;
      } else if (prefix === 'tvdb') {
        const r = await axios.get(
          `https://api.tvmaze.com/lookup/shows?thetvdb=${encodeURIComponent(rawVal)}`,
          { timeout: 6000 }
        );
        showData = r.data;
      }

      if (showData?.id && showData?.name) {
        let epTitle = null;
        let epReleased = null;

        if (season !== null && episode !== null) {
          const epRes = await axios.get(
            `https://api.tvmaze.com/shows/${showData.id}/episodebynumber?season=${Number(season)}&number=${Number(episode)}`,
            { timeout: 6000 }
          );
          if (epRes.data) {
            epTitle = epRes.data.name || null;
            epReleased = epRes.data.airdate ? String(epRes.data.airdate).slice(0, 10) : null;
          }
        }

        const info = {
          name: showData.name,
          year: showData.premiered ? parseInt(String(showData.premiered).slice(0, 4), 10) : null,
          imdb_id: showData.externals?.imdb || null,
          epTitle,
          epReleased,
        };
        metaCache.set(key, info);
        return info;
      }
    } catch {
      // Ignore TVMaze lookup miss
    }
  }

  return null;
}

async function resolveEquivalentIds(parsed, itemType = 'Series', cfg = {}) {
  const incoming = { provider: parsed.provider, id: String(parsed.id) };
  const cacheKey = `${itemType}:${parsed.provider}:${parsed.id}`;

  if (idMapCache.has(cacheKey)) {
    return idMapCache.get(cacheKey);
  }

  const found = new Map([[`${incoming.provider}:${incoming.id}`, incoming]]);
  const stremioType = itemType === 'Movie' ? 'movie' : 'series';
  const tmdbKey = cfg?.tmdbApiKey || process.env.TMDB_API_KEY;

  // 1. If starting with TMDB and TMDB_API_KEY is configured, fetch /external_ids directly
  if (parsed.provider === 'tmdb' && tmdbKey) {
    const tmdbPath = itemType === 'Movie' ? 'movie' : 'tv';
    try {
      const res = await axios.get(
        `https://api.themoviedb.org/3/${tmdbPath}/${encodeURIComponent(parsed.id)}/external_ids`,
        {
          params: { api_key: tmdbKey },
          timeout: 5000,
        }
      );
      const ext = res.data || {};
      if (ext.imdb_id && String(ext.imdb_id).startsWith('tt')) {
        found.set(`imdb:${ext.imdb_id}`, { provider: 'imdb', id: String(ext.imdb_id) });
      }
      if (ext.tvdb_id) {
        found.set(`tvdb:${ext.tvdb_id}`, { provider: 'tvdb', id: String(ext.tvdb_id) });
      }
    } catch {
      // Ignore TMDB external_ids miss
    }
  }

  // 2. Check Cinemeta for linked imdb_id when starting with imdb or tmdb
  if (parsed.provider === 'imdb' || parsed.provider === 'tmdb') {
    const metaId = parsed.provider === 'imdb' ? parsed.id : `tmdb:${parsed.id}`;
    try {
      const res = await axios.get(
        `https://v3-cinemeta.strem.io/meta/${stremioType}/${encodeURIComponent(metaId)}.json`,
        { timeout: 5000 }
      );
      const imdbId = res.data?.meta?.imdb_id;
      if (imdbId && String(imdbId).startsWith('tt')) {
        found.set(`imdb:${imdbId}`, { provider: 'imdb', id: String(imdbId) });
      }
    } catch {
      // Ignore Cinemeta miss
    }
  }

  // 3. For series, check TVMaze lookup by imdb or tvdb to recover any linked imdb / tvdb IDs
  if (itemType === 'Series') {
    const imdbCandidate = Array.from(found.values()).find((c) => c.provider === 'imdb');
    const tvdbCandidate = Array.from(found.values()).find((c) => c.provider === 'tvdb');

    try {
      let show = null;
      if (imdbCandidate) {
        const r = await axios.get(
          `https://api.tvmaze.com/lookup/shows?imdb=${encodeURIComponent(imdbCandidate.id)}`,
          { timeout: 5000 }
        );
        show = r.data;
      } else if (tvdbCandidate) {
        const r = await axios.get(
          `https://api.tvmaze.com/lookup/shows?thetvdb=${encodeURIComponent(tvdbCandidate.id)}`,
          { timeout: 5000 }
        );
        show = r.data;
      }

      if (show?.externals) {
        if (show.externals.imdb) {
          found.set(`imdb:${show.externals.imdb}`, {
            provider: 'imdb',
            id: String(show.externals.imdb),
          });
        }
        if (show.externals.thetvdb) {
          found.set(`tvdb:${show.externals.thetvdb}`, {
            provider: 'tvdb',
            id: String(show.externals.thetvdb),
          });
        }
      }
    } catch {
      // Ignore TVMaze miss
    }
  }

  const list = Array.from(found.values());
  idMapCache.set(cacheKey, list);
  return list;
}

async function searchSiloOnDemand(cfg, itemType, parsed) {
  if (!['imdb', 'tmdb', 'tvdb'].includes(parsed.provider)) {
    return {
      matches: [],
      session: await getValidSession(cfg, false),
      method: 'UnsupportedIdType',
    };
  }

  const session = await getValidSession(cfg, false);
  const candidates = await resolveEquivalentIds(parsed, itemType, cfg);
  let activeSession = session;

  // Check every available ID (imdb, tmdb, tvdb) strictly by ID and return as soon as any one matches
  for (const cand of candidates) {
    const providerKey = `${cand.provider}.${cand.id}`;
    const { data: idData, session: nextSession } = await siloGet(
      cfg,
      `/Users/${session.userId}/Items`,
      {
        Recursive: true,
        IncludeItemTypes: itemType,
        AnyProviderIdEquals: providerKey,
        Fields: 'ProviderIds,MediaSources,Path,ProductionYear',
        Limit: 50,
      }
    );
    activeSession = nextSession;

    const items = (idData?.Items || []).filter((item) =>
      matchProviderId(item, cand.provider, cand.id)
    );

    if (items.length > 0) {
      return {
        matches: [items[0]],
        session: activeSession,
        method: `AnyIdMatch(${providerKey})`,
      };
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

  const primary = await fetchSeasonEpisodes(targetSeason);
  const exactMatch = primary.episodes.filter(
    (ep) => Number(ep.IndexNumber) === Number(targetEpisode)
  );
  if (exactMatch.length > 0) {
    return { episodes: exactMatch, session: primary.session };
  }

  const currentYear = new Date().getFullYear();
  const airYear = meta?.epReleased ? parseInt(meta.epReleased.slice(0, 4), 10) : null;
  const possibleYears = [
    ...new Set([airYear, currentYear, currentYear - 1, currentYear - 2].filter(Boolean)),
  ];

  if (!possibleYears.includes(targetSeason) && (meta?.epTitle || meta?.epReleased)) {
    const targetEpNorm = normalizeTitle(meta.epTitle);

    for (let i = 0; i < possibleYears.length; i++) {
      if (i > 0) {
        await sleep(200);
      }
      const yearSeason = possibleYears[i];
      const yearRes = await fetchSeasonEpisodes(yearSeason);
      if (yearRes.episodes.length === 0) continue;

      let matched = yearRes.episodes.filter((ep) => {
        const epNorm = normalizeTitle(ep.Name);
        return (
          targetEpNorm &&
          (epNorm === targetEpNorm ||
            epNorm.includes(targetEpNorm) ||
            targetEpNorm.includes(epNorm))
        );
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
  const gb = Number(bytes) / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(Number(bytes) / 1024 ** 2).toFixed(0)} MB`;
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
    version: '1.4.0',
    name: 'Silo Server',
    description: 'On-demand direct-play stream resolver for Silo Server',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'tmdb:', 'tvdb:'],
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
  const isConfigured = Boolean(
    cfg?.serverUrl && (cfg?.username || (cfg?.userId && cfg?.accessToken))
  );
  res.json(getManifest(isConfigured));
});

app.post('/api/auth', async (req, res) => {
  const { serverUrl, username, password } = req.body || {};
  if (!serverUrl || !username) {
    return res.status(400).json({ error: 'Server URL and Username are required.' });
  }

  try {
    const baseUrl
