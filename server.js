const express = require('express');
const mysql = require('mysql2/promise');
const axios = require('axios');
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

app.get('/api/sync-status', (req, res) => {
  res.json(syncState);
});

async function runSync() {
  const categories = [
    { name: 'movies', url: `${TMDB_BASE}/discover/movie?api_key=${TMDB_KEY}&sort_by=popularity.desc&page=` },
    { name: 'series', url: `${TMDB_BASE}/discover/tv?api_key=${TMDB_KEY}&sort_by=popularity.desc&page=` },
    { name: 'anime', url: `${TMDB_BASE}/discover/tv?api_key=${TMDB_KEY}&with_genres=16&with_original_language=ja&sort_by=popularity.desc&page=` }
  ];

  for (const cat of categories) {
    if (!syncState.isSyncing) break; // Stop if user halted
    
    syncState.category = cat.name;
    let page = 1;
    let hasMore = true;
    
    while(hasMore && syncState.isSyncing) {
      try {
        const response = await axios.get(`${cat.url}${page}`);
        const items = response.data.results;
        if (items.length === 0) { hasMore = false; break; }

        // --- SMART STOP LOGIC ---
        // Get all IDs from the fetched TMDB page
        const pageIds = items.map(m => m.id);
        
        // Check TiDB to see how many of these IDs are already cached
        const [existingRows] = await pool.query('SELECT id FROM movies_cache WHERE id IN (?)', [pageIds]);
        
        // If the number of cached items matches the page size, the page is fully cached
        if (existingRows.length === items.length) {
          console.log(`Page ${page} of ${cat.name} is fully cached. Stopping sync for this category.`);
          hasMore = false; // Break the while loop, move to next category
          break;
        }
        // ------------------------

        for (const m of items) {
          const genreId = m.genre_ids && m.genre_ids.length > 0 ? m.genre_ids[0] : null;
          const genreName = genreId ? (genreMap[genreId] || 'Unknown') : 'Unknown';
          const title = (m.title || m.name || '').replace(/'/g, "''");
          const overview = (m.overview || '').replace(/'/g, "''");
          const year = new Date(m.release_date || m.first_air_date || '2000').getFullYear();
          const type = cat.name === 'movies' ? 'films' : cat.name;
          
          await pool.query(
            `INSERT INTO movies_cache (id, type, title, year, rating, genre, poster, backdrop, overview) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) 
             ON DUPLICATE KEY UPDATE id=id`,
            [m.id, type, title, year, m.vote_average || 0, genreName, m.poster_path ? `${TMDB_IMG}${m.poster_path}` : '', m.backdrop_path ? `${TMDB_BACKDROP}${m.backdrop_path}` : '', overview]
          );
          syncState.totalItems++;
        }
        
        syncState.currentPage = page;
        page++;
        
        // TMDB Limit Handler: 30 pages per 20 seconds
        if (page % 30 === 0) {
          await new Promise(resolve => setTimeout(resolve, 20000)); // Wait 20 sec
        } else {
          await new Promise(resolve => setTimeout(resolve, 250)); // Small delay
        }
      } catch (err) {
        console.error(`Error on ${cat.name} page ${page}:`, err.message);
        hasMore = false; // Stop if error
      }
    }
  }
  
  // Mark sync as finished
  syncState.isSyncing = false;
  console.log('TMDB Sync Complete or Stopped early due to full cache!');
}

// --- Get Movies from TiDB ---
app.get('/api/movies', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM movies_cache ORDER BY rating DESC LIMIT 500');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

// --- Get Single Movie Details by ID from TiDB ---
app.get('/api/movie/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM movies_cache WHERE id = ?', [req.params.id]);
    if (rows.length > 0) res.json(rows[0]);
    else res.status(404).json({ error: 'Not cached yet' });
  } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

// --- Search Route ---
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  try {
    const [rows] = await pool.query('SELECT * FROM movies_cache WHERE title LIKE ? LIMIT 10', [`%${q}%`]);
    res.json(rows);
  } catch (err) { res.status(500).json([]); }
});

// --- Categories ---
app.get('/api/categories', async (req, res) => {
  res.json([
    {id: 'all', name: 'All'}, {id: 'Action', name: 'Action'}, {id: 'Adventure', name: 'Adventure'},
    {id: 'Animation', name: 'Animation'}, {id: 'Comedy', name: 'Comedy'}, {id: 'Crime', name: 'Crime'},
    {id: 'Drama', name: 'Drama'}, {id: 'Fantasy', name: 'Fantasy'}, {id: 'Horror', name: 'Horror'},
    {id: 'Mystery', name: 'Mystery'}, {id: 'Sci-Fi', name: 'Sci-Fi'}, {id: 'Thriller', name: 'Thriller'}
  ]);
});

// --- Sources ---
app.get('/api/sources', async (req, res) => {
  const movieId = req.query.id;
  const dynamicSources = sourcesConfig.map(src => ({
    name: src.name, url: `${src.base_url}${movieId}`, status: "online", ping: Math.floor(Math.random() * 100) + 20
  }));
  res.json(dynamicSources);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Z-Stream server running on port ${PORT}`));
