const express = require('express');
const mysql = require('mysql2/promise');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// Load sources from sources.json
const sourcesConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf8'));

// --- Database Connection ---
const pool = mysql.createPool({
  host: process.env.TIDB_HOST,
  port: process.env.TIDB_PORT,
  user: process.env.TIDB_USER,
  password: process.env.TIDB_PASSWORD,
  database: process.env.TIDB_DATABASE,
  ssl: { rejectUnauthorized: true }
});

// --- Authentication Route ---
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE username = ? AND password = ?', [username, password]);
    if (rows.length > 0) {
      res.json({ success: true });
    } else {
      res.json({ success: false });
    }
  } catch (err) {
    console.error('Login DB Error:', err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

// --- TMDB API Routes ---
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w500';
const TMDB_BACKDROP = 'https://image.tmdb.org/t/p/original';

// Map TMDB Genre IDs to Readable Names
const genreMap = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  18: 'Drama', 14: 'Fantasy', 27: 'Horror', 9648: 'Mystery', 878: 'Sci-Fi', 
  53: 'Thriller', 10752: 'War', 37: 'Western', 10749: 'Romance', 10402: 'Music', 99: 'Documentary'
};

function formatMovie(m, type) {
  // Get the first genre ID from the array, default to null if empty
  const genreId = m.genre_ids && m.genre_ids.length > 0 ? m.genre_ids[0] : null;
  // Translate the ID to a readable name using our map
  const genreName = genreId ? (genreMap[genreId] || 'Unknown') : 'Unknown';
  
  return {
    id: m.id,
    type: type,
    title: m.title || m.name,
    year: new Date(m.release_date || m.first_air_date).getFullYear() || 'N/A',
    rating: m.vote_average ? m.vote_average.toFixed(1) : 'N/A',
    genre: genreName, // Send the readable name to the frontend
    poster: m.poster_path ? `${TMDB_IMG}${m.poster_path}` : '',
    backdrop: m.backdrop_path ? `${TMDB_BACKDROP}${m.backdrop_path}` : '',
    overview: m.overview || 'No overview available.'
  };
}

app.get('/api/movies', async (req, res) => {
  try {
    const response = await axios.get(`${TMDB_BASE}/trending/all/week?api_key=${process.env.TMDB_API_KEY}`);
    const movies = response.data.results.map(m => formatMovie(m, m.media_type));
    res.json(movies);
  } catch (err) {
    console.error('TMDB Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch movies' });
  }
});

app.get('/api/categories', async (req, res) => {
  res.json([
    {id: 'all', name: 'All'}, {id: 'Action', name: 'Action'}, {id: 'Adventure', name: 'Adventure'},
    {id: 'Animation', name: 'Animation'}, {id: 'Comedy', name: 'Comedy'}, {id: 'Crime', name: 'Crime'},
    {id: 'Drama', name: 'Drama'}, {id: 'Fantasy', name: 'Fantasy'}, {id: 'Horror', name: 'Horror'},
    {id: 'Mystery', name: 'Mystery'}, {id: 'Sci-Fi', name: 'Sci-Fi'}, {id: 'Thriller', name: 'Thriller'}
  ]);
});

// --- Dynamic Source Search Route ---
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

// Fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Z-Stream server running on port ${PORT}`);
});
