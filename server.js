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
app.set('trust proxy', 1); // REQUIRED on Render

app.use(express.json());
app.use(express.static(__dirname));
app.use(compression({ level: 5, threshold: 1024 }));

const REQUIRED_ENV = ['TIDB_HOST', 'TIDB_USER', 'TIDB_PASSWORD', 'TIDB_DATABASE'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) console.error('❌ MISSING ENV VARS: ' + missingEnv.join(', '));
if (!process.env.TMDB_API_KEY) console.warn('⚠️  TMDB_API_KEY missing — sync/seasons/credits/providers will fail.');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w342';
const TMDB_BACKDROP = 'https://image.tmdb.org/t/p/w780';
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
  10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News', 10764: 'Reality',
  10765: 'Sci-Fi & Fantasy', 10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics'
};

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

/* ═══════════════ SCHEMA ═══════════════ */
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

  // Small meta table so the sync engine can persist its last-completion time
  // across Render restarts (in-memory state dies on every deploy/sleep).
  await pool.query(`CREATE TABLE IF NOT EXISTS sync_meta (
    k VARCHAR(32) NOT NULL PRIMARY KEY,
    v VARCHAR(128)
  )`);

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

async function getMeta(k) {
  try {
    const [[r]] = await pool.query('SELECT v FROM sync_meta WHERE k = ?', [k]);
    return r ? r.v : null;
  } catch (e) { return null; }
}
async function setMeta(k, v) {
  try {
    await pool.query('INSERT INTO sync_meta (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [k, v]);
  } catch (e) {}
}

/* ═══════════════ HEALTH ═══════════════ */
app.get('/api/health', async (req, res) => {
  const out = {
    ok: false, db: false, dbError: null, tables: {}, userCount: null,
    tmdbKey: !!TMDB_KEY, cacheEntries: apiCache.cache.size,
    sync: { isSyncing: syncState.isSyncing, category: syncState.category, year: syncState.year },
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

/* ═══════════════════════════════════════════════════════════
   SYNC ENGINE v3 — ALWAYS-ON, FULL LIBRARY
   • Walks every year (current → SYNC_FLOOR_YEAR) per category
   • Splits years that exceed TMDB's 500-page query cap into halves
   • Batch inserts with existence pre-checks (cheap re-syncs)
   • Auto-runs on boot (if stale) and every SYNC_INTERVAL_HOURS
   • Stoppable via POST /api/stop-sync
   ═══════════════════════════════════════════════════════════ */
const SYNC_FLOOR_YEAR = parseInt(process.env.SYNC_FLOOR_YEAR) || 1900;
const SYNC_INTERVAL_HOURS = Math.max(1, parseInt(process.env.SYNC_INTERVAL_HOURS) || 6);
const PAGE_DELAY_MS = 400;   // ~2.5 req/s — far under TMDB's ~50 req/s limit
const TMDB_MAX_PAGES = 500;  // TMDB hard cap per discover query

let syncState = {
  isSyncing: false,
  category: 'idle',
  year: null,
  page: 0,
  currentPage: 0,   // frontend compat
  totalItems: 0,
  lastRunAt: null,
  nextRunAt: null
};

async function fetchWithRetry(url, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try { return await axios.get(url, { timeout: 15000 }); }
    catch (err) { lastErr = err; await sleep(2500 * (i + 1)); }
  }
  throw lastErr;
}

function yearParams(category, year) {
  return category === 'movies'
    ? `primary_release_year=${year}`
    : `first_air_date_year=${year}`;
}

function dateParams(category, from, to) {
  return category === 'movies'
    ? `primary_release_date.gte=${from}&primary_release_date.lte=${to}`
    : `first_air_date.gte=${from}&first_air_date.lte=${to}`;
}

function discoverUrl(category, params, page) {
  const p = category === 'movies' ? 'movie' : 'tv';
  return `${TMDB_BASE}/discover/${p}?api_key=${TMDB_KEY}&include_adult=false&sort_by=popularity.desc&${params}&page=${page}`;
}

/* Batch insert — checks which IDs already exist first, so re-sync passes
   cost one tiny SELECT per page instead of re-writing every row. */
async function insertBatch(tableName, items) {
  items = (items || []).filter(m => m && m.id);
  if (!items.length) return 0;

  const ids = items.map(m => m.id);
  let existing = new Set();
  try {
    const [rows] = await pool.query(`SELECT tmdb_id FROM ${tableName} WHERE tmdb_id IN (?)`, [ids]);
    for (const r of rows) existing.add(r.tmdb_id);
  } catch (e) { /* on error, fall through and insert everything */ }

  const fresh = items.filter(m => !existing.has(m.id));
  if (!fresh.length) return 0;

  const values = [];
  const params = [];
  for (const m of fresh) {
    const genreId = (m.genre_ids && m.genre_ids[0]) || null;
    params.push(
      m.id,
      m.title || m.name || 'Untitled',
      m.release_date || m.first_air_date || null,
      m.vote_average || 0,
      genreId ? (genreMap[genreId] || 'Unknown') : 'Unknown',
      m.poster_path ? TMDB_IMG + m.poster_path : null,
      m.backdrop_path ? TMDB_BACKDROP + m.backdrop_path : null,
      m.overview || ''
    );
    values.push('(?,?,?,?,?,?,?,?)');
  }

  try {
    const [result] = await pool.query(
      `INSERT INTO ${tableName} (tmdb_id, title, release_date, rating, genre, poster, backdrop, overview)
       VALUES ${values.join(',')}
       ON DUPLICATE KEY UPDATE tmdb_id = tmdb_id`,
      params
    );
    return result.affectedRows || fresh.length;
  } catch (e) {
    console.error(`Insert batch into ${tableName} failed: ${e.message}`);
    return 0;
  }
}

/* Page through one discover query (a year, or a half-year date range) */
async function syncQueryRange(category, tableName, params, label, startPage = 1, knownTotalPages = null) {
  let page = startPage;
  let totalPages = knownTotalPages || 1;
  let failures = 0;

  while (page <= totalPages && syncState.isSyncing) {
    let response;
    try {
      response = await fetchWithRetry(discoverUrl(category, params, page));
      failures = 0;
    } catch (err) {
      failures++;
      console.error(`Sync ${label} p${page}: ${err.message}`);
      if (failures >= 3) { console.warn(`Sync: skipping rest of ${label}`); return; }
      await sleep(5000);
      continue;
    }

    const items = response.data.results || [];
    const rawTotal = response.data.total_pages || 0;
    totalPages = Math.min(rawTotal, TMDB_MAX_PAGES);
    if (!items.length) return;

    syncState.totalItems += await insertBatch(tableName, items);

    syncState.page = page;
    syncState.currentPage = page; // frontend compat
    page++;
    await sleep(PAGE_DELAY_MS);
  }
}

/* Sync one year. If the year exceeds TMDB's 500-page window, re-query it
   as two half-year date ranges so nothing is missed. */
async function syncYear(category, tableName, year) {
  let probe;
  try {
    probe = await fetchWithRetry(discoverUrl(category, yearParams(category, year), 1));
  } catch (err) {
    console.error(`Sync ${category} ${year}: probe failed (${err.message}) — skipping year`);
    await sleep(5000);
    return;
  }

  const rawTotal = probe.data.total_pages || 0;
  const items = probe.data.results || [];
  if (!items.length) return;

  syncState.totalItems += await insertBatch(tableName, items);
  syncState.page = 1;
  syncState.currentPage = 1;
  await sleep(PAGE_DELAY_MS);

  if (rawTotal > TMDB_MAX_PAGES) {
    console.log(`Sync: ${category} ${year} has ${rawTotal} pages — splitting into half-years`);
    await syncQueryRange(category, tableName, dateParams(category, `${year}-01-01`, `${year}-06-30`), `${category} ${year} H1`);
    await syncQueryRange(category, tableName, dateParams(category, `${year}-07-01`, `${year}-12-31`), `${category} ${year} H2`);
    return;
  }

  if (rawTotal > 1) {
    await syncQueryRange(category, tableName, yearParams(category, year), `${category} ${year}`, 2, rawTotal);
  }
}

async function runSync() {
  let crashed = false;
  try {
    for (const category of ['movies', 'series']) {
      if (!syncState.isSyncing) break;
      syncState.category = category;
      const tableName = tableMap[category];
      const thisYear = new Date().getFullYear();

      for (let year = thisYear; year >= SYNC_FLOOR_YEAR; year--) {
        if (!syncState.isSyncing) break;
        syncState.year = year;
        await syncYear(category, tableName, year);
        await sleep(150);
      }
    }
  } catch (err) {
    crashed = true;
    console.error('Sync crashed:', err.message);
  }

  const stopped = !syncState.isSyncing; // stop endpoint sets this mid-run
  syncState.isSyncing = false;
  apiCache.clear();
  try {
    const [[m]] = await pool.query('SELECT COUNT(*) AS c FROM movies_cache');
    const [[s]] = await pool.query('SELECT COUNT(*) AS c FROM series_cache');
    syncState.totalItems = m.c + s.c;
  } catch (e) {}

  if (!stopped && !crashed) {
    await setMeta('lastCompletedAt', new Date().toISOString());
    console.log(`✓ TMDB sync pass completed — ${syncState.totalItems} items in DB.`);
  } else {
    console.log(stopped
      ? '⏹ Sync stopped early — will resume on next trigger.'
      : '⚠️ Sync pass crashed — will retry on next trigger.');
  }
}

async function startSyncJob() {
  if (syncState.isSyncing) return false;
  if (!TMDB_KEY) { console.warn('Sync skipped: no TMDB_API_KEY'); return false; }
  try {
    await ensureSchema();
    let existing = 0;
    try {
      const [[m]] = await pool.query('SELECT COUNT(*) AS c FROM movies_cache');
      const [[s]] = await pool.query('SELECT COUNT(*) AS c FROM series_cache');
      existing = m.c + s.c;
    } catch (e) {}
    syncState = {
      isSyncing: true,
      category: 'movies',
      year: new Date().getFullYear(),
      page: 0,
      currentPage: 0,
      totalItems: existing,
      lastRunAt: new Date().toISOString(),
      nextRunAt: syncState.nextRunAt || null
    };
    console.log(`▶ Sync started (floor year ${SYNC_FLOOR_YEAR}) — DB currently holds ${existing} items`);
    runSync(); // background — never awaited
    return true;
  } catch (err) {
    console.error('Failed to start sync:', err.message);
    syncState.isSyncing = false;
    return false;
  }
}

let autoSyncTimer = null;
function scheduleAutoSync() {
  if (!TMDB_KEY) return;
  clearInterval(autoSyncTimer);
  const intervalMs = SYNC_INTERVAL_HOURS * 60 * 60 * 1000;
  autoSyncTimer = setInterval(() => {
    syncState.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    if (!syncState.isSyncing) {
      startSyncJob().then(started => { if (started) console.log('⏰ Scheduled auto-sync started.'); });
    }
  }, intervalMs);
  syncState.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
  console.log(`✓ Auto-sync armed: every ${SYNC_INTERVAL_HOURS}h (floor year ${SYNC_FLOOR_YEAR})`);
}

app.get('/api/start-sync', async (req, res) => {
  if (syncState.isSyncing) return res.json({ msg: 'Already syncing', ...syncState });
  const ok = await startSyncJob();
  if (ok) return res.json({ msg: 'Sync started', ...syncState });
  return res.status(503).json({ msg: 'Could not start (missing TMDB key or DB down)', ...syncState });
});

app.get('/api/sync-status', (req, res) =>
  res.json({ ...syncState, autoIntervalHours: SYNC_INTERVAL_HOURS, floorYear: SYNC_FLOOR_YEAR }));

app.post('/api/stop-sync', (req, res) => {
  if (!syncState.isSyncing) return res.json({ success: false, msg: 'Not currently syncing', ...syncState });
  syncState.isSyncing = false; // loops exit after the current page
  return res.json({ success: true, msg: 'Stopping — will halt after the current page.', ...syncState });
});

/* ── Boot: connect DB, then start a pass ONLY if the library is stale ── */
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

bootDb().then(async () => {
  if (!TMDB_KEY) return console.warn('⚠️ TMDB_API_KEY missing — sync disabled.');
  scheduleAutoSync();
  // Only auto-run on boot if the last completed pass is older than the interval
  // (prevents every Render wake-up from launching a full re-scan)
  const last = await getMeta('lastCompletedAt');
  const stale = !last || (Date.now() - new Date(last).getTime()) > SYNC_INTERVAL_HOURS * 3600 * 1000;
  if (stale) {
    setTimeout(() => {
      if (!syncState.isSyncing) {
        startSyncJob().then(s => { if (s) console.log('▶ Boot sync started (stale library).'); });
      }
    }, 5000);
  } else {
    console.log('✓ Library fresh — skipping boot sync.');
  }
});

/* ═══════════════ CATALOG ═══════════════ */
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

/* ═══════════════ CREDITS ═══════════════ */
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

/* ═══════════════ FRAMEABLE CHECK ═══════════════ */
app.get('/api/check-frameable', async (req, res) => {
  const url = String(req.query.url || '');
  if (!/^https?:\/\//i.test(url)) return res.json({ frameable: false, reason: 'bad url' });

  const cacheKey = 'frameable_' + url;
  const cached = apiCache.get(cacheKey);
  if (cached) return res.json(cached);

  let result;
  try {
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
      if (!fa.split(/\s+/).includes('*')) {
        blocked = true;
        reason = 'csp frame-ancestors: ' + fa;
      }
    }
    result = { frameable: !blocked, reason };
  } catch (err) {
    result = { frameable: true, reason: 'unknown (headers unreachable — letting browser try)' };
  }

  apiCache.set(cacheKey, result, CACHE_TTL.frameable);
  res.json(result);
});

/* ═══════════════ CACHE CLEAR / DB CLEAR ═══════════════ */
app.post('/api/clear-cache', (req, res) => {
  apiCache.clear();
  res.json({ success: true, message: 'Cache cleared' });
});

app.post('/api/clear-db', async (req, res) => {
  try {
    await ensureSchema();
    syncState.isSyncing = false; // halt any in-flight sync
    await pool.query('TRUNCATE TABLE movies_cache');
    await pool.query('TRUNCATE TABLE series_cache');
    await setMeta('lastCompletedAt', null); // force a fresh full pass on next boot
    apiCache.clear();
    syncState.totalItems = 0;
    console.log('✓ Cache tables truncated — sync will repopulate automatically.');
    res.json({ success: true, message: 'movies_cache and series_cache cleared. Sync will repopulate automatically.' });
  } catch (err) {
    res.status(503).json({ success: false, message: classifyDbError(err) });
  }
});

/* ═══════════════ ROOT & BOOT ═══════════════ */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🔥 Z-Stream listening on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
});
