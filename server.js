const express = require('express');
const mysql = require('mysql2/promise');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const sourcesConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf8'));

const pool = mysql.createPool({
  host: process.env.TIDB_HOST,
  port: process.env.TIDB_PORT,
  user: process.env.TIDB_USER,
  password: process.env.TIDB_PASSWORD,
  database: process.env.TIDB_DATABASE,
  ssl: { rejectUnauthorized: true }
});

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w500';
const TMDB_BACKDROP = 'https://image.tmdb.org/t/p/original';
const TMDB_KEY = process.env.TMDB_API_KEY;

const genreMap = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  18: 'Drama', 14: 'Fantasy', 27: 'Horror', 9648: 'Mystery', 878: 'Sci-Fi', 
  53: 'Thriller', 10752: 'War', 37: 'Western', 10749: 'Romance', 10402: 'Music', 
  99: 'Documentary', 10751: 'Family'
};

const tableMap = {
  'movies': 'movies_cache',
  'series': 'series_cache',
  'anime': 'anime_cache'
};

// --- Auth Route ---
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE username = ? AND password = ?', [username, password]);
    res.json({ success: rows.length > 0 });
  } catch (err) { res.status(500).json({ success: false }); }
});

// --- Sync Engine State ---
let syncState = { isSyncing: false, currentPage: 0, totalItems: 0, category: 'movies' };

app.get('/api/start-sync', async (req, res) => {
  if (syncState.isSyncing) return res.json({ msg: 'Already syncing', ...syncState });
  syncState.isSyncing = true;
  syncState.currentPage = 0;
  syncState.totalItems = 0;
  runSync();
  res.json({ msg: 'Sync started', ...syncState });
});

app.get('/api/sync-status', (req, res) => res.json(syncState));

async function runSync() {
  const categories = [
    { name: 'movies', url: `${TMDB_BASE}/discover/movie?api_key=${TMDB_KEY}&sort_by=primary_release_date.desc&page=` },
    { name: 'series', url: `${TMDB_BASE}/discover/tv?api_key=${TMDB_KEY}&sort_by=first_air_date.desc&page=` },
    { name: 'anime', url: `${TMDB_BASE}/discover/tv?api_key=${TMDB_KEY}&with_genres=16&with_original_language=ja&sort_by=first_air_date.desc&page=` }
  ];

  for (const cat of categories) {
    // ... rest of your runSync code remains exactly the same

  for (const cat of categories) {
    if (!syncState.isSyncing) break;
    syncState.category = cat.name;
    const tableName = tableMap[cat.name];
    let page = 1, hasMore = true;
    
    while(hasMore && syncState.isSyncing) {
      try {
        const response = await axios.get(`${cat.url}${page}`);
        const items = response.data.results;
        if (items.length === 0) { hasMore = false; break; }

        const pageIds = items.map(m => m.id);
        const [existingRows] = await pool.query(`SELECT tmdb_id FROM ${tableName} WHERE tmdb_id IN (?)`, [pageIds]);
        
        if (existingRows.length === items.length) {
          console.log(`Page ${page} of ${cat.name} is fully cached. Stopping sync.`);
          hasMore = false; break;
        }

        for (const m of items) {
          const genreId = m.genre_ids && m.genre_ids.length > 0 ? m.genre_ids[0] : null;
          const genreName = genreId ? (genreMap[genreId] || 'Unknown') : 'Unknown';
          const title = (m.title || m.name || '').replace(/'/g, "''");
          const overview = (m.overview || '').replace(/'/g, "''");
          const release_date = m.release_date || m.first_air_date || 'Unknown';
          
          await pool.query(
            `INSERT INTO ${tableName} (tmdb_id, title, release_date, rating, genre, poster, backdrop, overview) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) 
             ON DUPLICATE KEY UPDATE tmdb_id=tmdb_id`,
            [m.id, title, release_date, m.vote_average || 0, genreName, m.poster_path ? `${TMDB_IMG}${m.poster_path}` : '', m.backdrop_path ? `${TMDB_BACKDROP}${m.backdrop_path}` : '', overview]
          );
          syncState.totalItems++;
        }
        
        syncState.currentPage = page;
        page++;
        if (page % 30 === 0) await new Promise(resolve => setTimeout(resolve, 20000));
        else await new Promise(resolve => setTimeout(resolve, 250));
      } catch (err) {
        console.error(`Sync error on ${cat.name} page ${page}:`, err.message);
        hasMore = false;
      }
    }
  }
  syncState.isSyncing = false;
  console.log('TMDB Sync Complete!');
}

// --- Get Movies (Only items <= 2 years old) ---
app.get('/api/movies', async (req, res) => {
  try {
    const currentYear = new Date().getFullYear();
    const minDate = `${currentYear - 2}-01-01`;
    
    const query = `
      SELECT 'films' as type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview FROM movies_cache WHERE release_date >= ?
      UNION ALL
      SELECT 'series' as type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview FROM series_cache WHERE release_date >= ?
      UNION ALL
      SELECT 'anime' as type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview FROM anime_cache WHERE release_date >= ?
      ORDER BY rating DESC LIMIT 500
    `;
    const [rows] = await pool.query(query, [minDate, minDate, minDate]);
    res.json(rows);
  } catch (err) { 
    console.error(err);
    res.status(500).json({ error: 'Database error' }); 
  }
});

// --- Get Single Item Details ---
app.get('/api/movie/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const query = `
      SELECT 'films' as type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview FROM movies_cache WHERE tmdb_id = ?
      UNION ALL
      SELECT 'series' as type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview FROM series_cache WHERE tmdb_id = ?
      UNION ALL
      SELECT 'anime' as type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview FROM anime_cache WHERE tmdb_id = ?
    `;
    const [rows] = await pool.query(query, [id, id, id]);
    if (rows.length > 0) res.json(rows[0]);
    else res.status(404).json({ error: 'Not cached yet' });
  } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

// --- Perfected Search System ---
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  try {
    const query = `
      SELECT 'films' as type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview FROM movies_cache WHERE title LIKE ?
      UNION ALL
      SELECT 'series' as type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview FROM series_cache WHERE title LIKE ?
      UNION ALL
      SELECT 'anime' as type, tmdb_id AS id, title, release_date, rating, genre, poster, backdrop, overview FROM anime_cache WHERE title LIKE ?
      LIMIT 20
    `;
    const [rows] = await pool.query(query, [`%${q}%`, `%${q}%`, `%${q}%`]);
    res.json(rows);
  } catch (err) { res.status(500).json([]); }
});

app.get('/api/categories', (req, res) => {
  res.json([
    {id: 'all', name: 'All'}, {id: 'Action', name: 'Action'}, {id: 'Adventure', name: 'Adventure'},
    {id: 'Animation', name: 'Animation'}, {id: 'Comedy', name: 'Comedy'}, {id: 'Crime', name: 'Crime'},
    {id: 'Drama', name: 'Drama'}, {id: 'Fantasy', name: 'Fantasy'}, {id: 'Horror', name: 'Horror'},
    {id: 'Mystery', name: 'Mystery'}, {id: 'Sci-Fi', name: 'Sci-Fi'}, {id: 'Thriller', name: 'Thriller'}
  ]);
});

// --- Advanced Deep Search + API Sources Engine ---
app.get('/api/sources', async (req, res) => {
  const movieId = req.query.id;
  let mediaType = 'movie';

  try {
    const [rows] = await pool.query(`
      SELECT 'movie' as type FROM movies_cache WHERE tmdb_id = ?
      UNION ALL
      SELECT 'series' as type FROM series_cache WHERE tmdb_id = ?
      UNION ALL
      SELECT 'anime' as type FROM anime_cache WHERE tmdb_id = ?
    `, [movieId, movieId, movieId]);
    
    if (rows.length > 0) {
      mediaType = rows[0].type;
      if (mediaType === 'series' || mediaType === 'anime') mediaType = 'tv';
    }
  } catch (e) {}

  const isTV = mediaType === 'tv';
  const tmdbEndpoint = isTV ? 'tv' : 'movie';

  let imdbId = null;
  try {
    const tmdbRes = await axios.get(`${TMDB_BASE}/${tmdbEndpoint}/${movieId}/external_ids?api_key=${TMDB_KEY}`, { timeout: 5000 });
    imdbId = tmdbRes.data.imdb_id;
  } catch (e) { console.error("Failed to fetch IMDb ID"); }

  const rawSources = [];
  const searchPromises = [];

  const getCleanName = (url) => {
    try {
      const hostname = new URL(url).hostname.replace('www.', '');
      const parts = hostname.split('.');
      return parts.length > 2 ? parts[parts.length - 2] : parts[0];
    } catch { return 'Unknown Server'; }
  };

  // SEARCH ENGINE 1: 2Embed.cc API
  if (imdbId) {
    searchPromises.push(
      axios.get(`https://www.2embed.cc/ajax/embed/list?id=${imdbId}${isTV ? '&s=1&e=1' : ''}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.2embed.cc/' },
        timeout: 5000
      }).then(response => {
        if (response.data?.status === 1 && response.data?.result) {
          response.data.result.forEach(src => {
            rawSources.push({ name: src.providerName || getCleanName(src.source), url: src.source, status: "online" });
          });
        }
      }).catch(() => {})
    );
  }

  // SEARCH ENGINE 2: VidSrc.to API
  searchPromises.push(
    axios.get(`https://vidsrc.to/ajax/embed/list?id=${movieId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://vidsrc.to/' },
      timeout: 5000
    }).then(response => {
      const $ = cheerio.load(response.data);
      $('.server').each((i, el) => {
        const url = $(el).attr('data-embed') || '';
        if (url) rawSources.push({ name: `VidSrc - ${getCleanName(url)}`, url: url, status: "online" });
      });
    }).catch(() => {})
  );

  // SEARCH ENGINE 3: VidSrc.xyz API
  searchPromises.push(
    axios.get(`https://vidsrc.xyz/ajax/embed/list?id=${movieId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://vidsrc.xyz/' },
      timeout: 5000
    }).then(response => {
      const $ = cheerio.load(response.data);
      $('.server').each((i, el) => {
        const url = $(el).attr('data-embed') || '';
        if (url) rawSources.push({ name: `VidSrc.xyz - ${getCleanName(url)}`, url: url, status: "online" });
      });
    }).catch(() => {})
  );

  // SEARCH ENGINE 4: SmashyStream API
  searchPromises.push(
    axios.get(`https://embed.smashystream.com/api/fetch/${tmdbEndpoint}?id=${movieId}${isTV ? '&s=1&e=1' : ''}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://embed.smashystream.com/' },
      timeout: 5000
    }).then(response => {
      if (response.data?.status === 1 && response.data?.result) {
        response.data.result.flat().forEach(src => {
          if (src.url) {
            const randSuffix = Math.floor(Math.random() * 99);
            rawSources.push({ name: `Smashy - ${src.provider || getCleanName(src.url)} ${randSuffix}`, url: src.url, status: "online" });
          }
        });
      }
    }).catch(() => {})
  );

  // Wait for all search engines, but force a maximum 6-second limit so the frontend never hangs
  await Promise.race([
    Promise.all(searchPromises),
    new Promise(resolve => setTimeout(resolve, 6000))
  ]);

  // Add Static Meta-Aggregators from sources.json (Including PrimeSrc)
  sourcesConfig.forEach(src => {
    let url = `${src.base_url}${movieId}`;
    
    // Handle PrimeSrc Query Parameter Format
    if (src.format === 'query') {
      if (isTV) {
        url = `https://primesrc.me/embed/tv?tmdb=${movieId}&season=1&episode=1`;
      } else {
        url = `https://primesrc.me/embed/movie?tmdb=${movieId}`;
      }
    } 
    // Handle Standard TV Formats
    else if (isTV) {
      if (src.name === 'VidSrc') url = `https://vidsrc.to/embed/tv/${movieId}/1/1`;
      else if (src.name === 'VidSrc.xyz') url = `https://vidsrc.xyz/embed/tv/${movieId}/1/1`;
      else if (src.name === '2Embed.cc') url = `https://www.2embed.cc/embedtv/${movieId}&s=1&e=1`;
      else if (src.name === '2Embed.to') url = `https://www.2embed.to/embedtv/${movieId}&s=1&e=1`;
      else if (src.name === 'MultiEmbed') url = `https://multiembed.mov/?video_id=${movieId}&tmdb=1&s=1&e=1`;
      else if (src.name === 'SuperEmbed') url = `https://se.bingetime.eu.org/embedtv/${movieId}/1/1`;
      else if (src.name === 'Embed.su') url = `https://embed.su/embed/tv/${movieId}/1/1`;
      else if (src.name === 'AutoEmbed') url = `https://autoembed.cc/embed/tv/${movieId}/1/1`;
    }
    
    rawSources.push({ name: src.name, url: url, status: "online" });
  });

  // DEDUPLICATION FILTER
  const dynamicSources = [];
  const seenUrls = new Set();
  
  rawSources.forEach(src => {
    if (!seenUrls.has(src.url)) {
      seenUrls.add(src.url);
      dynamicSources.push({ ...src, ping: Math.floor(Math.random() * 100) + 20 });
    }
  });

  res.json(dynamicSources);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Z-Stream server running on port ${PORT}`));
