const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = Number(process.env.PORT) || 7000;

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

function matchAnyCandidateId(item, candidates) {
  for (const cand of candidates) {
    if (matchProviderId(item, cand.provider, cand.id)) {
      return cand;
    }
  }
  return null;
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
    // Fall through to TVMaze fallback for series
  }

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
  const tmdbKey = (cfg?.tmdbApiKey || process.env.TMDB_API_KEY || '').trim();

  if (parsed.provider === 'tmdb') {
    if (!tmdbKey) {
      console.log('[SiloBridge] TMDB_API_KEY is empty/missing');
    } else {
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
        console.log('[SiloBridge] TMDB external_ids:', {
          imdb_id: ext.imdb_id,
          tvdb_id: ext.tvdb_id,
        });
        if (ext.imdb_id && String(ext.imdb_id).startsWith('tt')) {
          found.set(`imdb:${ext.imdb_id}`, { provider: 'imdb', id: String(ext.imdb_id) });
        }
        if (ext.tvdb_id) {
          found.set(`tvdb:${ext.tvdb_id}`, { provider: 'tvdb', id: String(ext.tvdb_id) });
        }
      } catch (err) {
        console.log(
          '[SiloBridge] TMDB external_ids error:',
          err.response?.status || err.message,
          err.response?.data?.status_message || ''
        );
      }
    }
  }

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

  if (itemType === 'Series') {
    const imdbCandidate = Array.from(found.values()).find((c) =>
