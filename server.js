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

// --- TMDB Config ---
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
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// --- Sync Route (Trigger this once to fill TiDB) ---
app.get('/api/sync', async (req, res) => {
  try {
    res.send('Sync started in background. Check server logs. Refresh the site in 2 minutes.');
    
    let page = 1;
    let hasMore = true;
    
    // Fetch Movies, TV, and Anime up to 50 pages each (1500 items each)
    while(page <= 50) {
      const [mRes, tRes, aRes] = await Promise.all([
        axios.get(`${TMDB_BASE}/trending/movie/week?api_key=${TMDB_KEY}&page=${page}`),
        axios.get(`${TMDB_BASE}/trending/tv/week?api_key=${TMDB_KEY}&page=${page}`),
        axios.get(`${TMDB_BASE}/discover/tv?api_key=${TMDB_KEY}&with_genres=16&with_original_language=ja&sort_by=popularity.desc&page=${page}`)
      ]);

      const insertBatch = async (items, type) => {
        for (const m of items) {
          const genreId = m.genre_ids && m.genre_ids.length > 0 ? m.genre_ids[0] : null;
          const genreName = genreId ? (genreMap[genreId] || 'Unknown') : 'Unknown';
          const title = (m.title || m.name || '').replace(/'/g, "''");
          const overview = (m.overview || '').replace(/'/g, "''");
          const year = new Date(m.release_date || m.first_air_date || '2000').getFullYear();
          
          await pool.query(
            `INSERT INTO movies_cache (id, type, title, year, rating, genre, poster, backdrop, overview) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) 
             ON DUPLICATE KEY UPDATE id=id`,
            [
              m.id, type, title, year, m.vote_average || 0, genreName,
              m.poster_path ? `${TMDB_IMG}${m.poster_path}` : '',
              m.backdrop_path ? `${TMDB_BACKDROP}${m.backdrop_path}` : '',
              overview
            ]
          );
        }
      };

      await insertBatch(mRes.data.results, 'films');
      await insertBatch(tRes.data.results, 'series');
      await insertBatch(aRes.data.results, 'anime');
      
      page++;
    }
    console.log('TMDB Sync Complete!');
  } catch (err) {
    console.error('Sync Error:', err.message);
  }
});

// --- Get Movies from TiDB ---
app.get('/api/movies', async (req, res) => {
  try {
    // Return a large chunk of cached movies ordered by rating
    const [rows] = await pool.query('SELECT * FROM movies_cache ORDER BY rating DESC LIMIT 500');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// --- Search Route (For Live Dropdown) ---
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  
  try {
    // Search TiDB for titles matching the query
    const [rows] = await pool.query(
      'SELECT * FROM movies_cache WHERE title LIKE ? LIMIT 10', 
      [`%${q}%`]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json([]);
  }
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
    name: src.name,
    url: `${src.base_url}${movieId}`,
    status: "online", 
    ping: Math.floor(Math.random() * 100) + 20
  }));
  res.json(dynamicSources);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Z-Stream server running on port ${PORT}`));
