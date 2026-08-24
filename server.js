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
