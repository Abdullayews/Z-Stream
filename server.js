const express = require('express');
const mysql = require('mysql2/promise');
const axios = require('axios');
const path = require('path');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
require('dotenv').config();

const { 
  getEnabledMovieSources, 
  buildMovieUrl, 
  getEnabledSeriesSources, 
  buildSeriesUrl 
} = require('./sources');

const app = express();
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.static(__dirname));

// ── Compression ──
app.use(compression({ level: 5, threshold: 1024 }));

// ── Rate limiting ──
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, error: 'rate_limited', message: 'Too many requests.' }
});
app.use('/api/', generalLimiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: { success: false, error: 'rate_limited', message: 'Too many login attempts.' }
});

// ── Serve HTML with permissive headers ──
function serveIndex(req, res) {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'index.html'));
}
app.get('/', serveIndex);
app.get('/index.html', serveIndex);

// ── ENV VALIDATION ──
const REQUIRED_ENV = ['TIDB_HOST', 'TIDB_USER', 'TIDB_PASSWORD', 'TIDB_DATABASE'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) {
  console.error('❌ MISSING ENVIRONMENT VARIABLES: ' + missingEnv.join(', '));
}
if (!process.env.TMDB_API_KEY) {
  console.warn('⚠️  TMDB_API_KEY missing — sync & seasons will fail.');
}

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_KEY = process.env.TMDB_API_KEY;

// ── DATABASE ──
const pool = mysql.createPool({
  host: process.env.TIDB_HOST,
  port: parseInt(process.env.TIDB_PORT) || 4000,
  user: process.env.TIDB_USER,
  password: process.env.TIDB_PASSWORD,
  database: process.env.TIDB_DATABASE,
  ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 15000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

const genreMap = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary',
  18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music',
  9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi', 10770: 'TV Movie', 53: 'Thriller',
  10752: 'War', 37: 'Western'
};

const tableMap = { movies: 'movies_cache', series: 'series_cache', anime: 'anime_cache' };

function classifyDbError(err) {
  const code = err && err.code;
  const m = (err && err.message) || '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Host not found — TIDB_HOST is wrong.';
  if (code === 'ETIMEDOUT' || /timeout/i.test(m)) return 'Connection timed out — check IP Access List.';
  if (code === 'ER_ACCESS_DENIED_ERROR') return 'Access denied — check credentials.';
  if (code === 'ER_BAD_DB_ERROR') return 'Unknown database — check TIDB_DATABASE.';
  return `Database error (${code || 'unknown'})`;
}

// ── SCHEMA ──
let schemaReady = false;

async function ensureSchema() {
  if (schemaReady) return;

  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(64) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL
  )`);

  for (const t of Object.values(tableMap)) {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${t} (
      tmdb_id INT NOT NULL PRIMARY KEY,
      title VARCHAR(255),
      release_date VARCHAR(10),
      rating DECIMAL(4,2) DEFAULT 0,
      genre VARCHAR(64),
      poster VARCHAR(300),
      backdrop VARCHAR(300),
      overview TEXT,
      KEY idx_release (release_date)
    )`);
  }

  const [[{ c }]] = await pool.query('SELECT COUNT(*) AS c FROM users');
  if (c === 0) {
    const au = process.env.ADMIN_USER || 'admin';
    const ap = process.env.ADMIN_PASS || 'admin';
    try {
      await pool.query('INSERT INTO users (username, password) VALUES (?, ?)', [au, ap]);
      console.log(`✓ Default user created: ${au} / ${ap}`);
    } catch (e) { /* race */ }
  }

  if (process.env.ADMIN_USER && process.env.ADMIN_PASS) {
    await pool.query(
      'INSERT INTO users (username, password) VALUES (?, ?) ON DUPLICATE KEY UPDATE password = VALUES(password)',
      [process.env.ADMIN_USER, process.env.ADMIN_PASS]
    );
  }

  schemaReady = true;
}

async function bootDb() {
  for (let i = 1; i <= 3; i++) {
    try {
      await pool.query('SELECT 1');
      await ensureSchema();
      console.log('✓ Database connected & schema ready');
      return;
    } catch (e) {
      console.error(`✗ DB init attempt ${i}/3 failed: ${classifyDbError(e)}`);
      await sleep(4000);
    }
  }
  console.error('✗ Database NOT ready at boot.');
}
bootDb();

// ── EMBED PROXY — same-origin iframe loading ──
app.get('/api/embed', async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).send('Missing url parameter');
  }

  try {
    const parsed = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).send('Invalid protocol');
    }
  } catch (e) {
    return res.status(400).send('Invalid URL');
  }

  try {
    const response = await axios.get(targetUrl, {
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      },
      responseType: 'text',
      validateStatus: () => true // Accept all status codes, don't throw
    });

    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });

    res.send(response.data);

  } catch (err) {
    console.error('Embed proxy error:', err.message);
    res.status(502).send(`<!DOCTYPE html><html><head><title>Server Error</title></head><body style="background:#000;color:#E50914;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center;"><h2>⚠ Server Unavailable</h2><p style="color:#A1A1A1;">Try another server below.</p></div></body></html>`);
  }
});

// ── IMDb ID lookup (for providers that need IMDb instead of TMDB) ──
async function getImdbId(tmdbId) {
  try {
    const movieRes = await axios.get(
      `${TMDB_BASE}/movie/${tmdbId}/external_ids?api_key=${TMDB_KEY}`,
      { timeout: 10000 }
    );
    if (movieRes.data.imdb_id) return movieRes.data.imdb_id;
  } catch (e) { /* not a movie */ }

  try {
    const tvRes = await axios.get(
      `${TMDB_BASE}/tv/${tmdbId}/external_ids?api_key=${TMDB_KEY}`,
      { timeout: 10000 }
    );
    if (tvRes.data.imdb_id) return tvRes.data.imdb_id;
  } catch (e) { /* not TV */ }

  return null;
}

// ── HEALTH ──
app.get('/api/health', async (req, res) => {
  const out = {
    ok: false,
    db: false,
    dbError: null,
    tables: {},
    userCount: null,
    tmdbKey: !!TMDB_KEY,
    uptime: Math.floor(process.uptime())
  };

  try {
    await pool.query('SELECT 1');
    out.db = true;

    for (const t of ['users', ...Object.values(tableMap)]) {
      try {
        const [[row]] = await pool.query(`SELECT COUNT(*) AS c FROM ${t}`);
        out.tables[t] = row.c;
      } catch (e) {
        out.tables[t] = 'MISSING';
      }
    }

    out.userCount = out.tables.users;
    out.ok = out.db && out.tables.users !== 'MISSING';
  } catch (err) {
    out.dbError = classifyDbError(err);
  }

  res.json(out);
});

// ── AUTH ──
app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'bad_request', message: 'Enter both fields.' });
  }

  try {
    await ensureSchema();
    const [rows] = await pool.query(
      'SELECT id FROM users WHERE username = ? AND password = ? LIMIT 1',
      [username, password]
    );

    if (rows.length) {
      res.json({ success: true });
    } else {
      res.status(401).json({
        success: false,
        error: 'bad_credentials',
        message: 'Invalid username or password.'
      });
    }
  } catch (err) {
    console.error('Login DB error:', err.code);
    res.status(503).json({
      success: false,
      error: 'db_down',
      message: classifyDbError(err)
    });
  }
});

// ── TMDB SYNC ──
let syncState = {
  isSyncing: false,
  currentPage: 0,
  totalItems: 0,
  category: 'idle',
  lastSyncAt: null
};

async function fetchWithRetry(url, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try { return await axios.get(url, { timeout: 15000 }); }
    catch (err) { lastErr = err; await sleep(2500 * (i + 1)); }
  }
  throw lastErr;
}

app.get('/api/start-sync', async (req, res) => {
  if (syncState.isSyncing) {
    return res.json({ msg: 'Already syncing', ...syncState });
  }

  try {
    await ensureSchema();
    syncState = {
      isSyncing: true,
      currentPage: 0,
      totalItems: 0,
      category: 'movies',
      lastSyncAt: syncState.lastSyncAt
    };
    runSync();
    res.json({ msg: 'Sync started', ...syncState });
  } catch (err) {
    res.status(503).json({
      msg: classifyDbError(err),
      isSyncing: false,
      currentPage: 0,
      totalItems: 0,
      category: 'idle',
      lastSyncAt: null
    });
  }
});

app.get('/api/sync-status', (req, res) => res.json(syncState));

async function runSync() {
  const today = new Date().toISOString().slice(0, 10);

  const categories = [
    {
      name: 'movies',
      url: `${TMDB_BASE}/discover/movie?api_key=${TMDB_KEY}&sort_by=primary_release_date.desc&include_adult=false&primary_release_date.lte=${today}&page=`
    },
    {
      name: 'series',
      url: `${TMDB_BASE}/discover/tv?api_key=${TMDB_KEY}&sort_by=first_air_date.desc&include_adult=false&first_air_date.lte=${today}&page=`
    },
    {
      name: 'anime',
      url: `${TMDB_BASE}/discover/tv?api_key=${TMDB_KEY}&with_genres=16&with_original_language=ja&sort_by=first_air_date.desc&include_adult=false&first_air_date.lte=${today}&page=`
    }
  ];

  try {
    for (const category of categories) {
      if (!syncState.isSyncing) break;
      syncState.category = category.name;
      const tableName = tableMap[category.name];
      let page = 1, hasMore = true;

      while (hasMore && syncState.isSyncing && page <= 10) {
        let response;
        try {
          response = await fetchWithRetry(`${category.url}${page}`);
        } catch (err) {
          console.error(`Sync: ${category.name} page ${page} failed: ${err.message}`);
          hasMore = false;
          break;
        }

        const items = response.data.results || [];
        if (!items.length) {
          hasMore = false;
          break;
        }

        for (const m of items) {
          const genreId = (m.genre_ids && m.genre_ids[0]) || null;
          try {
            const [result] = await pool.query(
              `INSERT INTO ${tableName} (tmdb_id, title, release_date, rating, genre, poster, backdrop, overview)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON DUPLICATE KEY UPDATE tmdb_id = tmdb_id`,
              [
                m.id,
                m.title || m.name || 'Untitled',
                m.release_date || m.first_air_date || null,
                m.vote_average || 0,
                genreId ? (genreMap[genreId] || 'Unknown') : 'Unknown',
                m.poster_path ? `https://image.tmdb.org/t/p/w342${m.poster_path}` : null,
                m.backdrop_path ? `https://image.tmdb.org/t/p/w780${m.backdrop_path}` : null,
                m.overview || ''
              ]
            );
            if (result.affectedRows === 1) {
              syncState.totalItems++;
            }
          } catch (e) { /* skip bad row */ }
        }

        syncState.currentPage = page;
        page++;
        await sleep(page % 20 === 0 ? 10000 : 250);
      }
    }

    syncState.lastSyncAt = new Date().toISOString();
    console.log('✓ TMDB sync complete.');
  } catch (err) {
    console.error('Sync crashed:', err.message);
  } finally {
    syncState.isSyncing = false;
  }
}

// ── CACHE ──
const apiCache = new Map();

function getCache(key) {
  const entry = apiCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    apiCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(key, value, ttlMs) {
  if (apiCache.size > 500) {
    const oldestKey = apiCache.keys().next().value;
    apiCache.delete(oldestKey);
  }
  apiCache.set(key, { value, expiry: Date.now() + ttlMs });
}

// ── CATALOG ──
app.get('/api/movies', async (req, res) => {
  try {
    const cacheKey = 'movies_catalog';
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    await ensureSchema();
    const year = new Date().getFullYear();
    const minDate = `${year - 2}-01-01`;
    const today = new Date().toISOString().slice(0, 10);

    const query = `
      SELECT 'films' AS type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview
      FROM movies_cache
      WHERE release_date >= ? AND release_date <= ? AND poster IS NOT NULL AND poster <> ''
      UNION ALL
      SELECT 'series' AS type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview
      FROM series_cache
      WHERE release_date >= ? AND release_date <= ? AND poster IS NOT NULL AND poster <> ''
      UNION ALL
      SELECT 'anime' AS type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview
      FROM anime_cache
      WHERE release_date >= ? AND release_date <= ? AND poster IS NOT NULL AND poster <> ''
      ORDER BY rating DESC LIMIT 500`;

    const [rows] = await pool.query(query, [minDate, today, minDate, today, minDate, today]);

    setCache(cacheKey, rows, 15 * 60 * 1000);
    res.json(rows);
  } catch (err) {
    console.error('movies:', err.message);
    res.status(500).json([]);
  }
});

app.get('/api/movie/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad id' });

    const cacheKey = `movie_${id}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const query = `
      SELECT 'films' AS type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview
      FROM movies_cache WHERE tmdb_id = ?
      UNION ALL
      SELECT 'series' AS type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview
      FROM series_cache WHERE tmdb_id = ?
      UNION ALL
      SELECT 'anime' AS type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview
      FROM anime_cache WHERE tmdb_id = ?
      LIMIT 1`;

    const [rows] = await pool.query(query, [id, id, id]);

    if (rows.length) {
      setCache(cacheKey, rows[0], 60 * 60 * 1000);
      res.json(rows[0]);
    } else {
      res.status(404).json({ error: 'Not cached yet' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);

  try {
    const cacheKey = `search_${q.toLowerCase()}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    await ensureSchema();
    const query = `
      SELECT 'films' AS type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview
      FROM movies_cache WHERE INSTR(LOWER(title), LOWER(?)) > 0
      UNION ALL
      SELECT 'series' AS type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview
      FROM series_cache WHERE INSTR(LOWER(title), LOWER(?)) > 0
      UNION ALL
      SELECT 'anime' AS type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview
      FROM anime_cache WHERE INSTR(LOWER(title), LOWER(?)) > 0
      ORDER BY rating DESC LIMIT 24`;

    const [rows] = await pool.query(query, [q, q, q]);
    setCache(cacheKey, rows, 5 * 60 * 1000);
    res.json(rows);
  } catch (err) {
    console.error('search:', err.message);
    res.json([]);
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const cacheKey = 'categories';
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    await ensureSchema();
    const [rows] = await pool.query(`
      SELECT genre AS id, genre AS name FROM (
        SELECT genre FROM movies_cache
        UNION SELECT genre FROM series_cache
        UNION SELECT genre FROM anime_cache
      ) g
      WHERE genre IS NOT NULL AND genre <> '' AND genre <> 'Unknown'
      ORDER BY name`);

    const result = [{ id: 'all', name: 'All' }, ...rows];
    setCache(cacheKey, result, 60 * 60 * 1000);
    res.json(result);
  } catch (err) {
    res.json([{ id: 'all', name: 'All' }]);
  }
});

// ── SOURCES ──
async function getItemType(id) {
  const [films] = await pool.query('SELECT tmdb_id FROM movies_cache WHERE tmdb_id = ? LIMIT 1', [id]);
  if (films.length) return 'films';

  const [series] = await pool.query('SELECT tmdb_id FROM series_cache WHERE tmdb_id = ? LIMIT 1', [id]);
  if (series.length) return 'series';

  const [anime] = await pool.query('SELECT tmdb_id FROM anime_cache WHERE tmdb_id = ? LIMIT 1', [id]);
  if (anime.length) return 'anime';

  return null;
}

app.get('/api/sources', async (req, res) => {
  try {
    const id = parseInt(req.query.id);
    const season = Math.max(1, parseInt(req.query.s) || 1);
    const episode = Math.max(1, parseInt(req.query.e) || 1);

    if (!id) return res.json([]);

    const cacheKey = `sources_${id}_${season}_${episode}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    let type = (req.query.type || '').toLowerCase();
    if (!['films', 'movies', 'series', 'anime'].includes(type)) {
      type = (await getItemType(id)) || 'films';
    }

    const isTV = type === 'series' || type === 'anime';
    const list = isTV ? getEnabledSeriesSources() : getEnabledMovieSources();

    // Get IMDb ID for providers that need it
    const imdbId = await getImdbId(id);

    const sources = [];
    for (const s of list) {
      let url;

      if (isTV) {
        url = buildSeriesUrl(s.id, imdbId || id, season, episode, id);
      } else {
        url = buildMovieUrl(s.id, imdbId || id, id);
      }

      if (!url || !/^https?:\/\//.test(url)) continue;

      // Route through our proxy
      const proxyUrl = `/api/embed?url=${encodeURIComponent(url)}`;

      sources.push({
        name: s.name,
        url: proxyUrl,
        directUrl: url
      });
    }

    setCache(cacheKey, sources, 30 * 60 * 1000);
    res.json(sources);
  } catch (err) {
    console.error('sources:', err.message);
    res.json([]);
  }
});

// ── SEASONS ──
app.get('/api/seasons/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.json([]);

  const cacheKey = `seasons_${id}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const r = await axios.get(`${TMDB_BASE}/tv/${id}?api_key=${TMDB_KEY}`, {
      timeout: 12000
    });

    const seasons = (r.data.seasons || [])
      .filter(s => s.season_number > 0 && s.episode_count > 0)
      .map(s => ({
        name: s.name,
        season_number: s.season_number,
        episode_count: s.episode_count
      }));

    setCache(cacheKey, seasons, 60 * 60 * 1000);
    res.json(seasons);
  } catch (err) {
    res.json([]);
  }
});

// ── CACHE CLEAR ──
app.post('/api/clear-cache', (req, res) => {
  apiCache.clear();
  res.json({ success: true, message: 'All caches cleared' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🔥 Z-Stream listening on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
  console.log(`🎥 Embed proxy: http://localhost:${PORT}/api/embed?url=...`);
});
