const express = require('express');
const mysql = require('mysql2/promise');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const { getEnabledMovieSources, buildMovieUrl, getEnabledSeriesSources, buildSeriesUrl } = require('./sources');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

/* ══════════════════ ENV VALIDATION — fail loudly, not silently ══════════════════ */
const REQUIRED_ENV = ['TIDB_HOST', 'TIDB_USER', 'TIDB_PASSWORD', 'TIDB_DATABASE'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) {
  console.error('❌ MISSING ENVIRONMENT VARIABLES: ' + missingEnv.join(', '));
  console.error('   Add them in Render → Environment:');
  console.error('   TIDB_HOST, TIDB_PORT (=4000), TIDB_USER, TIDB_PASSWORD, TIDB_DATABASE, TMDB_API_KEY');
  console.error('   TiDB Cloud Serverless usernames look like "3pTAoTNhsYdNL4E.root" — copy exactly.');
}
if (!process.env.TMDB_API_KEY) {
  console.warn('⚠️  TMDB_API_KEY missing — login still works, but sync & seasons will fail.');
}

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w500';
const TMDB_BACKDROP = 'https://image.tmdb.org/t/p/original';
const TMDB_KEY = process.env.TMDB_API_KEY;

const pool = mysql.createPool({
  host: process.env.TIDB_HOST,
  port: parseInt(process.env.TIDB_PORT) || 4000,
  user: process.env.TIDB_USER,
  password: process.env.TIDB_PASSWORD,
  database: process.env.TIDB_DATABASE,
  ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true }, // TiDB Cloud requires TLS
  waitForConnections: true,
  connectionLimit: 8,
  queueLimit: 0,
  connectTimeout: 15000,
  enableKeepAlive: true
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

const genreMap = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary',
  18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music',
  9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi', 10770: 'TV Movie', 53: 'Thriller',
  10752: 'War', 37: 'Western'
};

const tableMap = { movies: 'movies_cache', series: 'series_cache', anime: 'anime_cache' };

/* ══════════════════ DB ERROR CLASSIFIER (human-readable causes) ══════════════════ */
function classifyDbError(err) {
  const code = err && err.code;
  const m = (err && err.message) || '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Host not found — TIDB_HOST is wrong (must be hostname only, no https://, no port).';
  if (code === 'ETIMEDOUT' || /timeout/i.test(m)) return 'Connection timed out — wrong host/port, or your TiDB IP Access List blocks Render (Dedicated tier: allow 0.0.0.0/0).';
  if (code === 'ECONNREFUSED') return 'Connection refused — check TIDB_HOST and TIDB_PORT (should be 4000).';
  if (code === 'ER_ACCESS_DENIED_ERROR' || /access denied/i.test(m)) return 'Access denied — check TIDB_USER / TIDB_PASSWORD (Serverless user looks like "xxxxx.root").';
  if (code === 'ER_BAD_DB_ERROR' || /unknown database/i.test(m)) return 'Unknown database — check TIDB_DATABASE (Serverless default is "test").';
  if (code === 'ER_NO_DB_ERROR') return 'No database selected — set TIDB_DATABASE (Serverless default is "test").';
  if (/ssl|certificate|tls|handshake/i.test(m)) return 'TLS error — this build enables TLSv1.2; check that you are using the correct TiDB Cloud host.';
  return `Database error (${code || 'unknown'}) — see Render logs.`;
}

/* ══════════════════ SCHEMA (lazy, self-healing, race-safe) ══════════════════ */
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

  // Repair very old/mismatched users tables (TiDB supports IF NOT EXISTS; errors swallowed on plain MySQL)
  try {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(64)');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS password VARCHAR(255)');
  } catch (e) { /* ignore */ }

  // Seed a guaranteed login
  const [[{ c }]] = await pool.query('SELECT COUNT(*) AS c FROM users');
  if (c === 0) {
    const au = process.env.ADMIN_USER || 'admin';
    const ap = process.env.ADMIN_PASS || 'admin';
    try {
      await pool.query('INSERT INTO users (username, password) VALUES (?, ?)', [au, ap]);
      console.log(`✓ Users table was empty — created login: ${au} / ${ap}`);
    } catch (e) { /* race with a concurrent login — fine */ }
  }
  // Env override ALWAYS guarantees a known login, even over existing rows
  if (process.env.ADMIN_USER && process.env.ADMIN_PASS) {
    await pool.query(
      'INSERT INTO users (username, password) VALUES (?, ?) ON DUPLICATE KEY UPDATE password = VALUES(password)',
      [process.env.ADMIN_USER, process.env.ADMIN_PASS]
    );
    console.log(`✓ Admin login ensured from env: ${process.env.ADMIN_USER}`);
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
bootDb(); // non-blocking: server starts even if DB is briefly down

/* ══════════════════ HEALTH / DIAGNOSTICS ══════════════════ */
app.get('/api/health', async (req, res) => {
  const out = {
    ok: false,
    uptimeSec: Math.floor(process.uptime()),
    db: false,
    dbError: null,
    tables: {},
    userCount: null,
    tmdbKey: !!TMDB_KEY,
    env: {
      TIDB_HOST: !!process.env.TIDB_HOST,
      TIDB_PORT: process.env.TIDB_PORT || '4000 (default)',
      TIDB_USER: !!process.env.TIDB_USER,
      TIDB_PASSWORD: !!process.env.TIDB_PASSWORD,
      TIDB_DATABASE: process.env.TIDB_DATABASE || null
    }
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
    out.userCount = out.tables.users;
    out.ok = out.db && out.tables.users !== 'MISSING';
  } catch (err) {
    out.dbError = classifyDbError(err);
  }
  res.json(out); // always 200 so Render health checks don't kill the service while you debug
});

/* ══════════════════ AUTH ══════════════════ */
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ success: false, error: 'bad_request', message: 'Enter both username and password.' });
  try {
    await ensureSchema(); // lazy self-heal: works even if boot-time init failed
    const [rows] = await pool.query('SELECT id FROM users WHERE username = ? AND password = ? LIMIT 1', [username, password]);
    if (rows.length) return res.json({ success: true });
    return res.status(401).json({ success: false, error: 'bad_credentials', message: 'Invalid username or password. Default is admin/admin (or your ADMIN_USER env var).' });
  } catch (err) {
    console.error('Login DB error:', err.code || '', err.message);
    return res.status(503).json({ success: false, error: 'db_down', message: classifyDbError(err) });
  }
});

/* ══════════════════ TMDB SYNC ENGINE ══════════════════ */
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
    { name: 'series', url: `${TMDB_BASE}/discover/tv?api_key=${TMDB_KEY}&sort_by=first_air_date.desc&include_adult=false&first_air_date.lte=${today}&page=` },
    { name: 'anime',  url: `${TMDB_BASE}/discover/tv?api_key=${TMDB_KEY}&with_genres=16&with_original_language=ja&sort_by=first_air_date.desc&include_adult=false&first_air_date.lte=${today}&page=` }
  ];

  try {
    for (const category of categories) {
      if (!syncState.isSyncing) break;
      syncState.category = category.name;
      const tableName = tableMap[category.name];
      let page = 1, hasMore = true;

      while (hasMore && syncState.isSyncing) {
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
            console.log(`Sync: ${category.name} page ${page} fully cached — skipping rest of category.`);
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
                m.poster_path ? TMDB_IMG + m.poster_path : null,
                m.backdrop_path ? TMDB_BACKDROP + m.backdrop_path : null,
                m.overview || ''
              ]
            );
            if (result.affectedRows === 1) syncState.totalItems++;
          } catch (e) { /* skip bad row */ }
        }

        syncState.currentPage = page;
        page++;
        await sleep(page % 40 === 0 ? 15000 : 300);
      }
    }
    console.log('TMDB sync finished.');
  } catch (err) {
    console.error('Sync crashed:', err.message);
  } finally {
    syncState.isSyncing = false;
  }
}

/* ══════════════════ CATALOG (≤ 2 years old, released, with poster) ══════════════════ */
app.get('/api/movies', async (req, res) => {
  try {
    await ensureSchema();
    const year = new Date().getFullYear();
    const minDate = `${year - 2}-01-01`;
    const today = new Date().toISOString().slice(0, 10);
    const query = `
      SELECT 'films' AS type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview
      FROM movies_cache WHERE release_date >= ? AND release_date <= ? AND poster IS NOT NULL AND poster <> ''
      UNION ALL
      SELECT 'series' AS type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview
      FROM series_cache WHERE release_date >= ? AND release_date <= ? AND poster IS NOT NULL AND poster <> ''
      UNION ALL
      SELECT 'anime' AS type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview
      FROM anime_cache WHERE release_date >= ? AND release_date <= ? AND poster IS NOT NULL AND poster <> ''
      ORDER BY rating DESC LIMIT 500`;
    const [rows] = await pool.query(query, [minDate, today, minDate, today, minDate, today]);
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
    const query = `
      SELECT 'films' AS type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview FROM movies_cache WHERE tmdb_id = ?
      UNION ALL
      SELECT 'series' AS type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview FROM series_cache WHERE tmdb_id = ?
      UNION ALL
      SELECT 'anime' AS type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview FROM anime_cache WHERE tmdb_id = ?
      LIMIT 1`;
    const [rows] = await pool.query(query, [id, id, id]);
    if (rows.length) res.json(rows[0]);
    else res.status(404).json({ error: 'Not cached yet' });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

/* ══════════════════ SEARCH (entire DB, case-insensitive, injection-safe) ══════════════════ */
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  try {
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
    res.json(rows);
  } catch (err) {
    console.error('search:', err.message);
    res.json([]);
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    await ensureSchema();
    const [rows] = await pool.query(`
      SELECT genre AS id, genre AS name FROM (
        SELECT genre FROM movies_cache
        UNION SELECT genre FROM series_cache
        UNION SELECT genre FROM anime_cache
      ) g
      WHERE genre IS NOT NULL AND genre <> '' AND genre <> 'Unknown'
      ORDER BY name`);
    res.json([{ id: 'all', name: 'All' }, ...rows]);
  } catch (err) {
    res.json([{ id: 'all', name: 'All' }]);
  }
});

/* ══════════════════ SOURCES ══════════════════ */
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

    let type = (req.query.type || '').toLowerCase();
    if (!['films', 'movies', 'series', 'anime'].includes(type)) {
      type = (await getItemType(id)) || 'films';
    }

    const isTV = type === 'series' || type === 'anime';
    const list = isTV ? getEnabledSeriesSources() : getEnabledMovieSources();

    const sources = list.map(s => ({
      name: s.name,
      url: isTV ? buildSeriesUrl(s.id, id, season, episode) : buildMovieUrl(s.id, id)
    })).filter(s => s.url && /^https?:\/\//.test(s.url));

    res.json(sources);
  } catch (err) {
    console.error('sources:', err.message);
    res.json([]);
  }
});

/* ══════════════════ SEASONS (TMDB, 1h cache) ══════════════════ */
const seasonsCache = new Map();
app.get('/api/seasons/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.json([]);
  const cached = seasonsCache.get(id);
  if (cached && Date.now() - cached.t < 3600000) return res.json(cached.data);
  try {
    const r = await axios.get(`${TMDB_BASE}/tv/${id}?api_key=${TMDB_KEY}`, { timeout: 12000 });
    const seasons = (r.data.seasons || [])
      .filter(s => s.season_number > 0 && s.episode_count > 0)
      .map(s => ({ name: s.name, season_number: s.season_number, episode_count: s.episode_count }));
    seasonsCache.set(id, { t: Date.now(), data: seasons });
    res.json(seasons);
  } catch (err) {
    res.json([]);
  }
});

/* ══════════════════ BOOT ══════════════════ */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔥 Z-Stream listening on port ${PORT}`));
