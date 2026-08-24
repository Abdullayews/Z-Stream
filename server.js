const express = require('express');
const mysql = require('mysql2/promise');
const axios = require('axios');
const path = require('path');
const helmet = require('helmet');
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
app.use(express.json());
app.use(express.static(__dirname));

// ── SECURITY: Helmet headers ──
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'https://image.tmdb.org', 'data:'],
      frameSrc: ["'self'", 'https:', 'http:'], // Allow iframes from streaming providers
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      connectSrc: ["'self'", 'https:', 'http:'] // Allow API calls to TMDB
    }
  },
  crossOriginEmbedderPolicy: false, // Needed for iframe embeds
  crossOriginResourcePolicy: { policy: 'cross-origin' } // Allow cross-origin loading
}));

// ── PERFORMANCE: Compression ──
app.use(compression({ 
  level: 5, // Balanced — higher levels melt your CPU on free tier
  threshold: 1024 // Only compress responses > 1KB
}));

// ── SECURITY: Rate limiting ──
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, error: 'rate_limited', message: 'Too many requests.' }
});
app.use('/api/', generalLimiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  message: { success: false, error: 'rate_limited', message: 'Too many login attempts. Try again in 15 minutes.' }
});

// ── CACHING: In-memory TTL cache to reduce TiDB RU usage ──
class TTLCache {
  constructor() { this.cache = new Map(); }
  
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }
  
  set(key, value, ttlMs) {
    // Prevent memory exhaustion
    if (this.cache.size > 500) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, { value, expiry: Date.now() + ttlMs });
  }
  
  clear() { this.cache.clear(); }
}

const apiCache = new TTLCache();

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
  keepAliveInitialDelay: 10000 // Prevents connection drops (TiDB 340s timeout)
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
    await pool.query('INSERT INTO users (username, password) VALUES (?, ?)', [au, ap]);
    console.log(`✓ Default user created: ${au} / ${ap}`);
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

// ── HEALTH CHECK ──
app.get('/api/health', async (req, res) => {
  const out = {
    ok: false,
    db: false,
    dbError: null,
    tables: {},
    userCount: null,
    tmdbKey: !!TMDB_KEY,
    cacheSize: apiCache.cache.size,
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
  // Delta sync: only fetch items from last 7 days if we've synced before
  const lastSyncDate = syncState.lastSyncAt 
    ? new Date(syncState.lastSyncAt).toISOString().slice(0, 10)
    : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

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

      while (hasMore && syncState.isSyncing && page <= 10) { // Limit to 10 pages per category
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
          } catch (e) { /* Skip bad row */ }
        }

        syncState.currentPage = page;
        page++;
        
        // Rate limiting for TMDB
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

// ── CATALOG (with caching) ──
app.get('/api/movies', async (req, res) => {
  try {
    // Check cache first (15 minute TTL)
    const cacheKey = 'movies_catalog';
    const cached = apiCache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

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
    
    // Cache for 15 minutes
    apiCache.set(cacheKey, rows, 15 * 60 * 1000);
    
    res.json(rows);
  } catch (err) {
    console.error('movies:', err.message);
    res.status(500).json([]);
  }
});

// ── SINGLE ITEM ──
app.get('/api/movie/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad id' });
    
    // Check cache
    const cacheKey = `movie_${id}`;
    const cached = apiCache.get(cacheKey);
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
      apiCache.set(cacheKey, rows[0], 60 * 60 * 1000); // 1 hour cache
      res.json(rows[0]);
    } else {
      res.status(404).json({ error: 'Not cached yet' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ── SEARCH (with caching) ──
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  
  try {
    // Cache search for 5 minutes
    const cacheKey = `search_${q.toLowerCase()}`;
    const cached = apiCache.get(cacheKey);
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
    
    apiCache.set(cacheKey, rows, 5 * 60 * 1000); // 5 min cache
    
    res.json(rows);
  } catch (err) {
    console.error('search:', err.message);
    res.json([]);
  }
});

// ── CATEGORIES (with caching) ──
app.get('/api/categories', async (req, res) => {
  try {
    const cacheKey = 'categories';
    const cached = apiCache.get(cacheKey);
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
    apiCache.set(cacheKey, result, 60 * 60 * 1000); // 1 hour cache
    
    res.json(result);
  } catch (err) {
    res.json([{ id: 'all', name: 'All' }]);
  }
});

// ── SOURCES (with type detection) ──
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
    
    // Check cache
    const cacheKey = `sources_${id}_${season}_${episode}`;
    const cached = apiCache.get(cacheKey);
    if (cached) return res.json(cached);

    let type = (req.query.type || '').toLowerCase();
    if (!['films', 'movies', 'series', 'anime'].includes(type)) {
      type = (await getItemType(id)) || 'films';
    }

    const isTV = type === 'series' || type === 'anime';
    const list = isTV ? getEnabledSeriesSources() : getEnabledMovieSources();

    const sources = list.map(s => ({
      name: s.name,
      url: isTV 
        ? buildSeriesUrl(s.id, id, season, episode) 
        : buildMovieUrl(s.id, id)
    })).filter(s => s.url && /^https?:\/\//.test(s.url));

    // Cache for 30 minutes
    apiCache.set(cacheKey, sources, 30 * 60 * 1000);
    
    res.json(sources);
  } catch (err) {
    console.error('sources:', err.message);
    res.json([]);
  }
});

// ── SEASONS (TMDB with caching) ──
app.get('/api/seasons/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.json([]);
  
  // Check cache
  const cacheKey = `seasons_${id}`;
  const cached = apiCache.get(cacheKey);
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
    
    // Cache for 1 hour
    apiCache.set(cacheKey, seasons, 60 * 60 * 1000);
    
    res.json(seasons);
  } catch (err) {
    res.json([]);
  }
});

// ── CACHE CLEAR (admin) ──
app.post('/api/clear-cache', (req, res) => {
  apiCache.clear();
  res.json({ success: true, message: 'Cache cleared' });
});

// ── ROOT ──
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🔥 Z-Stream listening on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
});
