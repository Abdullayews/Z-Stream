const express = require('express');
const mysql = require('mysql2/promise');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

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

// Helper function to format TMDB data for our frontend
function formatMovie(m, type) {
  return {
    id: m.id,
    type: type,
    title: m.title || m.name,
    year: new Date(m.release_date || m.first_air_date).getFullYear() || 'N/A',
    rating: m.vote_average ? m.vote_average.toFixed(1) : 'N/A',
    genre: m.genre_ids && m.genre_ids.length > 0 ? m.genre_ids[0] : 'Unknown', // Note: TMDB returns IDs, we'll map these later if needed
    poster: m.poster_path ? `${TMDB_IMG}${m.poster_path}` : '',
    backdrop: m.backdrop_path ? `${TMDB_BACKDROP}${m.backdrop_path}` : '',
    overview: m.overview || 'No overview available.'
  };
}

// Get Trending Movies
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

// Get Categories (Genres)
app.get('/api/categories', async (req, res) => {
  // For simplicity, we return standard categories. TMDB uses genre IDs.
  res.json([
    {id: 'all', name: 'All'},
    {id: '28', name: 'Action'},
    {id: '12', name: 'Adventure'},
    {id: '16', name: 'Animation'},
    {id: '35', name: 'Comedy'},
    {id: '80', name: 'Crime'},
    {id: '18', name: 'Drama'},
    {id: '14', name: 'Fantasy'},
    {id: '27', name: 'Horror'},
    {id: '9648', name: 'Mystery'},
    {id: '878', name: 'Sci-Fi'},
    {id: '53', name: 'Thriller'}
  ]);
});

// Fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Z-Stream server running on port ${PORT}`);
});
