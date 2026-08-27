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

/* ═══════════════ SETUP ═══════════════ */
const app = express();
app.set('trust proxy', 1); // REQUIRED on Render — else rate limiter blocks everyone

app.use(express.json());
app.use(express.static(__dirname));
app.use(compression({ level: 5, threshold: 1024 }));

const REQUIRED_ENV = ['TIDB_HOST', 'TIDB_USER', 'TIDB_PASSWORD', 'TIDB_DATABASE'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) console.error('❌ MISSING ENV VARS: ' + missingEnv.join(', '));
if (!process.env.TMDB_API_KEY) console.warn('⚠️  TMDB_API_KEY missing — sync/seasons/credits/providers will fail.');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_KEY = process.env.TMDB_API_KEY;

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 200,
  standardHeaders: 'draft-8', legacyHeaders: false,
  message: { success: false, error: 'rate_limited', message: 'Too many requests. Try again later.' }
});
app.use('/api/', generalLimiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 5,
  standardHeaders: 'draft-8', legacyHeaders: false,
  message: { success: false, error: 'rate_limited', message: 'Too many login attempts. Try again in 15 minutes.' }
});

/* ═══════════════ TTL CACHE ═══════════════ */
class TTLCache {
  constructor() { this.cache = new Map(); }
  get(key) {
    const e = this.cache.get(key);
    if (!e) return null;
    if (Date.now() > e.expiry) { this.cache.delete(key); return null; }
    return e.value;
  }
  set(key, value, ttlMs) {
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, { value, expiry: Date.now() + ttlMs });
  }
  clear() { this.cache.clear(); }
}
const apiCache = new TTLCache();

const CACHE_TTL = {
  movies: 15 * 60 * 1000,
  movie: 60 * 60 * 1000,
  search: 5 * 60 * 1000,
  categories: 60 * 60 * 1000,
  sources: 30 * 60 * 1000,
  seasons: 60 * 60 * 1000,
  credits: 6 * 3600 * 1000,
  providers: 6 * 3600 * 1000,
  frameable: 30 * 60 * 1000
};

/* ═══════════════ DATABASE ═══════════════ */
const pool = mysql.createPool({
  host: process.env.TIDB_HOST,
  port: parseInt(process.env.TIDB_PORT) || 4000,
  user: process.env.TIDB_USER,
  password: process.env.TIDB_PASSWORD,
  database: process.env.TIDB_DATABASE,
  ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
  waitForConnections: true, connectionLimit: 10, queueLimit: 0,
  connectTimeout: 15000, enableKeepAlive: true, keepAliveInitialDelay: 10000
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

const genreMap = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
  27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi',
  10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western',
  // TV-specific genres (TMDB genre_ids on /discover/tv)
  10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News', 10764: 'Reality',
  10765: 'Sci-Fi & Fantasy', 10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics'
};

// Movies + Series only (anime table dropped per DB reset)
const tableMap = { movies: 'movies_cache', series: 'series_cache' };

function classifyDbError(err) {
  const code = err && err.code;
  const m = (err && err.message) || '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Host not found — TIDB_HOST is wrong (hostname only).';
  if (code === 'ETIMEDOUT' || /timeout/i.test(m)) return 'Connection timed out — wrong host/port, or TiDB IP Access List blocks Render.';
  if (code === 'ECONNREFUSED') return 'Connection refused — check TIDB_HOST and TIDB_PORT (should be 4000).';
  if (code === 'ER_ACCESS_DENIED_ERROR' || /access denied/i.test(m)) return 'Access denied — check TIDB_USER / TIDB_PASSWORD.';
  if (code === 'ER_BAD_DB_ERROR' || /unknown database/i.test(m)) return 'Unknown database — check TIDB_DATABASE.';
  if (code === 'ER_NO_DB_ERROR') return 'No database selected — set TIDB_DATABASE.';
  if (/ssl|certificate|tls|handshake/i.test(m)) return 'TLS error — verify the TiDB Cloud host.';
  return `Database error (${code || 'unknown'}) — see Render logs.`;
}

/* ═══════════════ SCHEMA (skips your existing reset tables) ═══════════════ */
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
      console.log(`✓ Users table was empty — created login: ${au} / ${ap}`);
    } catch (e) { /* race — fine */ }
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
  console.error('✗ Database NOT ready at boot — login attempts will retry automatically.');
}
bootDb();

/* ═══════════════ HEALTH ═══════════════ */
app.get('/api/health', async (req, res) => {
  const out = {
    ok: false, db: false, dbError: null, tables: {}, userCount: null,
    tmdbKey: !!TMDB_KEY, cacheEntries: apiCache.cache.size,
    uptimeSec: Math.floor(process.uptime())
  };
  try {
    await pool.query('SELECT 1');
    out.db = true;
    try { await ensureSchema(); } catch (e) { out.dbError = 'Schema error: ' + classifyDbError(e); }
    for (const t of ['users', ...Object.values(tableMap)]) {
      try {
        const [[row]] = await pool.query(`SELECT COUNT(*) AS c FROM ${t}`);
        out.tables[t] = row.c;
      } catch (e) { out.tables[t] = 'MISSING'; }
    }
    out.userCount = typeof out.tables.users === 'number' ? out.tables.users : null;
    out.ok = out.db && out.tables.users !== 'MISSING';
  } catch (err) {
    out.dbError = classifyDbError(err);
  }
  res.json(out);
});

/* ═══════════════ AUTH ═══════════════ */
app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ success: false, error: 'bad_request', message: 'Enter both username and password.' });
  try {
    await ensureSchema();
    const [rows] = await pool.query('SELECT id FROM users WHERE username = ? AND password = ? LIMIT 1', [username, password]);
    if (rows.length) return res.json({ success: true });
    return res.status(401).json({ success: false, error: 'bad_credentials', message: 'Invalid username or password. Default is admin/admin.' });
  } catch (err) {
    console.error('Login DB error:', err.code || '', err.message);
    return res.status(503).json({ success: false, error: 'db_down', message: classifyDbError(err) });
  }
});

/* ═══════════════ SYNC (movies + series only) ═══════════════ */
let syncState = { isSyncing: false, currentPage: 0, totalItems: 0, category: 'idle' };

async function fetchWithRetry(url, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try { return await axios.get(url, { timeout: 15000 }); }
    catch (err) { lastErr = err; await sleep(2500 * (i + 1)); }
  }
  throw lastErr;
}

app.get('/api/start-sync', async (req, res) => {
  if (syncState.isSyncing) return res.json({ msg: 'Already syncing', ...syncState });
  try {
    await ensureSchema();
    let total = 0;
    for (const t of Object.values(tableMap)) {
      const [[row]] = await pool.query(`SELECT COUNT(*) AS c FROM ${t}`);
      total += row.c;
    }
    syncState = { isSyncing: true, currentPage: 0, totalItems: total, category: 'movies' };
    runSync();
    res.json({ msg: 'Sync started', ...syncState });
  } catch (err) {
    res.status(503).json({ msg: classifyDbError(err), isSyncing: false, currentPage: 0, totalItems: 0, category: 'idle' });
  }
});

app.get('/api/sync-status', (req, res) => res.json(syncState));

async function runSync() {
  const today = new Date().toISOString().slice(0, 10);
  const categories = [
    { name: 'movies', url: `${TMDB_BASE}/discover/movie?api_key=${TMDB_KEY}&sort_by=primary_release_date.desc&include_adult=false&primary_release_date.lte=${today}&page=` },
    { name: 'series', url: `${TMDB_BASE}/discover/tv?api_key=${TMDB_KEY}&sort_by=first_air_date.desc&include_adult=false&first_air_date.lte=${today}&page=` }
  ];

  try {
    for (const category of categories) {
      if (!syncState.isSyncing) break;
      syncState.category = category.name;
      const tableName = tableMap[category.name];
      let page = 1, hasMore = true;

      while (hasMore && syncState.isSyncing && page <= 10) {
        let response;
        try { response = await fetchWithRetry(`${category.url}${page}`); }
        catch (err) {
          console.error(`Sync: giving up on ${category.name} page ${page}: ${err.message}`);
          hasMore = false; break;
        }

        const items = response.data.results || [];
        if (!items.length) { hasMore = false; break; }

        const pageIds = items.map(m => m.id).filter(Boolean);
        if (pageIds.length) {
          const [existing] = await pool.query(`SELECT tmdb_id FROM ${tableName} WHERE tmdb_id IN (?)`, [pageIds]);
          if (existing.length === items.length) {
            console.log(`Sync: ${category.name} page ${page} fully cached — skipping rest.`);
            hasMore = false; break;
          }
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
            if (result.affectedRows === 1) syncState.totalItems++;
          } catch (e) { /* skip bad row */ }
        }

        syncState.currentPage = page;
        page++;
        await sleep(page % 20 === 0 ? 10000 : 300);
      }
    }
    console.log('✓ TMDB sync finished.');
  } catch (err) {
    console.error('Sync crashed:', err.message);
  } finally {
    syncState.isSyncing = false;
    apiCache.clear(); // fresh items appear immediately
  }
}

/* ═══════════════ CATALOG (movies + series) ═══════════════ */
app.get('/api/movies', async (req, res) => {
  const cached = apiCache.get('movies_catalog');
  if (cached) return res.json(cached);
  try {
    await ensureSchema();
    const year = new Date().getFullYear();
    const minDate = `${year - 2}-01-01`;
    const today = new Date().toISOString().slice(0, 10);
    const query = `
      SELECT 'movies' AS type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview
      FROM movies_cache
      WHERE release_date >= ? AND release_date <= ? AND poster IS NOT NULL AND poster <> ''
      UNION ALL
      SELECT 'series' AS type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview
      FROM series_cache
      WHERE release_date >= ? AND release_date <= ? AND poster IS NOT NULL AND poster <> ''
      ORDER BY rating DESC LIMIT 500`;
    const [rows] = await pool.query(query, [minDate, today, minDate, today]);
    apiCache.set('movies_catalog', rows, CACHE_TTL.movies);
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
    const cached = apiCache.get(cacheKey);
    if (cached) return res.json(cached);

    const query = `
      SELECT 'movies' AS type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview
      FROM movies_cache WHERE tmdb_id = ?
      UNION ALL
      SELECT 'series' AS type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview
      FROM series_cache WHERE tmdb_id = ?
      LIMIT 1`;
    const [rows] = await pool.query(query, [id, id]);
    if (rows.length) {
      apiCache.set(cacheKey, rows[0], CACHE_TTL.movie);
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
  const cacheKey = `search_${q.toLowerCase()}`;
  const cached = apiCache.get(cacheKey);
  if (cached) return res.json(cached);
  try {
    await ensureSchema();
    const query = `
      SELECT 'movies' AS type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview
      FROM movies_cache WHERE INSTR(LOWER(title), LOWER(?)) > 0
      UNION ALL
      SELECT 'series' AS type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview
      FROM series_cache WHERE INSTR(LOWER(title), LOWER(?)) > 0
      ORDER BY rating DESC LIMIT 24`;
    const [rows] = await pool.query(query, [q, q]);
    apiCache.set(cacheKey, rows, CACHE_TTL.search);
    res.json(rows);
  } catch (err) {
    console.error('search:', err.message);
    res.json([]);
  }
});

app.get('/api/categories', async (req, res) => {
  const cached = apiCache.get('categories');
  if (cached) return res.json(cached);
  try {
    await ensureSchema();
    const [rows] = await pool.query(`
      SELECT genre AS id, genre AS name FROM (
        SELECT genre FROM movies_cache
        UNION SELECT genre FROM series_cache
      ) g
      WHERE genre IS NOT NULL AND genre <> '' AND genre <> 'Unknown'
      ORDER BY name`);
    const result = [{ id: 'all', name: 'All' }, ...rows];
    apiCache.set('categories', result, CACHE_TTL.categories);
    res.json(result);
  } catch (err) {
    res.json([{ id: 'all', name: 'All' }]);
  }
});

/* ═══════════════ TYPE DETECTION ═══════════════ */
async function getItemType(id) {
  const [movies] = await pool.query('SELECT tmdb_id FROM movies_cache WHERE tmdb_id = ? LIMIT 1', [id]);
  if (movies.length) return 'movies';
  const [series] = await pool.query('SELECT tmdb_id FROM series_cache WHERE tmdb_id = ? LIMIT 1', [id]);
  if (series.length) return 'series';
  return null;
}

/* ═══════════════ SOURCES ═══════════════ */
app.get('/api/sources', async (req, res) => {
  try {
    const id = parseInt(req.query.id);
    const season = Math.max(1, parseInt(req.query.s) || 1);
    const episode = Math.max(1, parseInt(req.query.e) || 1);
    if (!id) return res.json([]);

    const cacheKey = `sources_${id}_${season}_${episode}`;
    const cached = apiCache.get(cacheKey);
    if (cached) return res.json(cached);

    let type = (req.query.type || '').toLowerCase();
    if (!['movies', 'films', 'series'].includes(type)) {
      type = (await getItemType(id)) || 'movies';
    }

    const isTV = type === 'series';
    const list = isTV ? getEnabledSeriesSources() : getEnabledMovieSources();

    const sources = list.map(s => ({
      name: s.name,
      url: isTV ? buildSeriesUrl(s.id, id, season, episode) : buildMovieUrl(s.id, id)
    })).filter(s => s.url && /^https?:\/\//.test(s.url));

    apiCache.set(cacheKey, sources, CACHE_TTL.sources);
    res.json(sources);
  } catch (err) {
    console.error('sources:', err.message);
    res.json([]);
  }
});

/* ═══════════════ SEASONS ═══════════════ */
app.get('/api/seasons/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.json([]);
  const cacheKey = `seasons_${id}`;
  const cached = apiCache.get(cacheKey);
  if (cached) return res.json(cached);
  try {
    const r = await axios.get(`${TMDB_BASE}/tv/${id}?api_key=${TMDB_KEY}`, { timeout: 12000 });
    const seasons = (r.data.seasons || [])
      .filter(s => s.season_number > 0 && s.episode_count > 0)
      .map(s => ({ name: s.name, season_number: s.season_number, episode_count: s.episode_count }));
    apiCache.set(cacheKey, seasons, CACHE_TTL.seasons);
    res.json(seasons);
  } catch (err) { res.json([]); }
});

/* ═══════════════ CREDITS (cast + runtime) ═══════════════ */
app.get('/api/credits/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.json({ cast: [], runtime: 0 });
  const cacheKey = `credits_${id}`;
  const cached = apiCache.get(cacheKey);
  if (cached) return res.json(cached);
  try {
    const type = (await getItemType(id)) === 'series' ? 'tv' : 'movie';
    const r = await axios.get(`${TMDB_BASE}/${type}/${id}?api_key=${TMDB_KEY}&append_to_response=credits`, { timeout: 12000 });
    const d = r.data || {};
    const runtime = type === 'movie' ? (d.runtime || 0) : ((d.episode_run_time && d.episode_run_time[0]) || 0);
    const out = {
      runtime,
      cast: ((d.credits && d.credits.cast) || []).slice(0, 14).map(c => ({
        name: c.name, character: c.character, profile_path: c.profile_path
      }))
    };
    apiCache.set(cacheKey, out, CACHE_TTL.credits);
    res.json(out);
  } catch (err) { res.json({ cast: [], runtime: 0 }); }
});

/* ═══════════════ WATCH PROVIDERS ═══════════════ */
app.get('/api/providers', async (req, res) => {
  const id = parseInt(req.query.id);
  const region = String(req.query.region || 'US').toUpperCase();
  if (!id) return res.json({ link_country: region, results: {} });
  const cacheKey = `providers_${id}`;
  const cached = apiCache.get(cacheKey);
  if (cached) return res.json(cached);
  try {
    const type = (await getItemType(id)) === 'series' ? 'tv' : 'movie';
    const r = await axios.get(`${TMDB_BASE}/${type}/${id}/watch/providers?api_key=${TMDB_KEY}`, { timeout: 12000 });
    const out = { link_country: region, results: (r.data && r.data.results) || {} };
    apiCache.set(cacheKey, out, CACHE_TTL.providers);
    res.json(out);
  } catch (err) { res.json({ link_country: region, results: {} }); }
});

/* ═══════════════ FRAMEABLE CHECK (the "frame-in-place" illusion) ═══════════════ */
app.get('/api/check-frameable', async (req, res) => {
  const url = String(req.query.url || '');
  if (!/^https?:\/\//i.test(url)) return res.json({ frameable: false, reason: 'bad url' });

  const cacheKey = 'frameable_' + url;
  const cached = apiCache.get(cacheKey);
  if (cached) return res.json(cached);

  let result;
  try {
    // Stream so we get headers immediately, then discard the body
    const r = await axios.get(url, {
      timeout: 8000,
      maxRedirects: 5,
      responseType: 'stream',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (r.data && typeof r.data.destroy === 'function') { try { r.data.destroy(); } catch (e) {} }

    const h = r.headers || {};
    const xfo = String(h['x-frame-options'] || '').trim().toLowerCase();
    const csp = String(h['content-security-policy'] || '');
    const faMatch = csp.match(/frame-ancestors\s+([^;]+)/i);

    let blocked = false;
    let reason = 'ok';
    if (xfo === 'deny' || xfo === 'sameorigin') {
      blocked = true;
      reason = 'x-frame-options: ' + xfo;
    } else if (faMatch) {
      const fa = faMatch[1].trim();
      // Any explicit frame-ancestors without a wildcard means we're likely not allowed
      if (!fa.split(/\s+/).includes('*')) {
        blocked = true;
        reason = 'csp frame-ancestors: ' + fa;
      }
    }
    result = { frameable: !blocked, reason };
  } catch (err) {
    // Provider blocks server-side requests (Cloudflare etc.) but usually still
    // embeds fine in a browser → give it the benefit of the doubt.
    result = { frameable: true, reason: 'unknown (headers unreachable — letting browser try)' };
  }

  apiCache.set(cacheKey, result, CACHE_TTL.frameable);
  res.json(result);
});

/* ═══════════════ CACHE CLEAR / ROOT / BOOT ═══════════════ */
app.post('/api/clear-cache', (req, res) => {
  apiCache.clear();
  res.json({ success: true, message: 'Cache cleared' });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🔥 Z-Stream listening on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
});
