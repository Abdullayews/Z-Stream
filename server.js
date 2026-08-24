const express = require('express');
const mysql = require('mysql2/promise');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const { getEnabledMovieSources, buildMovieUrl, getEnabledSeriesSources, buildSeriesUrl } = require('./sources');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

/* ───────────────────────── Database ───────────────────────── */
const pool = mysql.createPool({
  host: process.env.TIDB_HOST,
  port: process.env.TIDB_PORT || 4000,
  user: process.env.TIDB_USER,
  password: process.env.TIDB_PASSWORD,
  database: process.env.TIDB_DATABASE,
  ssl: { rejectUnauthorized: true },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w500';
const TMDB_BACKDROP = 'https://image.tmdb.org/t/p/original';
const TMDB_KEY = process.env.TMDB_API_KEY;

const genreMap = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary',
  18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music',
  9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi', 10770: 'TV Movie', 53: 'Thriller',
  10752: 'War', 37: 'Western'
};

const tableMap = { movies: 'movies_cache', series: 'series_cache', anime: 'anime_cache' };

/* ─────────────── Schema bootstrap (auto-creates the exact structure) ─────────────── */
async function ensureSchema() {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS users (
       id INT AUTO_INCREMENT PRIMARY KEY,
       username VARCHAR(64) NOT NULL UNIQUE,
       password VARCHAR(255) NOT NULL
     )`,
    ...Object.values(tableMap).map(t => `
      CREATE TABLE IF NOT EXISTS ${t} (
        tmdb_id INT NOT NULL PRIMARY KEY,
        title VARCHAR(255),
        release_date VARCHAR(10),
        rating DECIMAL(4,2) DEFAULT 0,
        genre VARCHAR(64),
        poster VARCHAR(300),
        backdrop VARCHAR(300),
        overview TEXT,
        KEY idx_release (release_date)
      )`)
  ];
  for (const q of ddl) await pool.query(q);

  const [[{ c }]] = await pool.query('SELECT COUNT(*) AS c FROM users');
  if (c === 0) {
    await pool.query('INSERT INTO users (username, password) VALUES (?, ?)', ['admin', 'admin']);
    console.log('✓ Default user created → admin / admin');
  }
}
ensureSchema()
  .then(() => console.log('✓ Database schema ready'))
  .catch(e => console.error('Schema init failed (is the DB up?):', e.message));

/* ───────────────────────── Auth ───────────────────────── */
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ success: false });
  try {
    const [rows] = await pool.query('SELECT id FROM users WHERE username = ? AND password = ? LIMIT 1', [username, password]);
    res.json({ success: rows.length > 0 });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ success: false });
  }
});

/* ───────────────────────── TMDB Sync Engine ───────────────────────── */
let syncState = { isSyncing: false, currentPage: 0, totalItems: 0, category: 'idle' };

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    let total = 0;
    for (const t of Object.values(tableMap)) {
      const [[row]] = await pool.query(`SELECT COUNT(*) AS c FROM ${t}`);
      total += row.c;
    }
    syncState = { isSyncing: true, currentPage: 0, totalItems: total, category: 'movies' };
    runSync();
    res.json({ msg: 'Sync started', ...syncState });
  } catch (err) {
    res.status(500).json({ msg: 'Database error', isSyncing: false, currentPage: 0, totalItems: 0, category: 'idle' });
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

        // Early-stop: newest-first ordering means a fully cached page = nothing new left
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
          const genreName = genreId ? (genreMap[genreId] || 'Unknown') : 'Unknown';
          try {
            const [result] = await pool.query(
              `INSERT INTO ${tableName} (tmdb_id, title, release_date, rating, genre, poster, backdrop, overview)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON DUPLICATE KEY UPDATE tmdb_id = tmdb_id`,
              [
                m.id,
                m.title || m.name || 'Untitled',
                m.release_date || m.first_air_date || null,   // NULL (not 'Unknown') so date filters work
                m.vote_average || 0,
                genreName,
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

/* ───────────────────────── Catalog (≤ 2 years old,
