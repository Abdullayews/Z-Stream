// ─────────────────────────────────────────────────────────────
// sources.js — Embed providers with IMDb ID support
// Some providers need IMDb IDs (vidsrc.cc), others use TMDB IDs (primesrc.me)
// The server handles the conversion automatically
// ─────────────────────────────────────────────────────────────

const movieSources = [
  // PrimeSrc — accepts TMDB IDs directly
  { 
    id: 'primesrc', 
    name: 'PrimeSrc', 
    enabled: true, 
    method: 'query', 
    baseUrl: 'https://primesrc.me/embed/movie',
    params: { 
      tmdb: '{tmdbId}',
      fallback: 'true',
      serverOrder: 'PrimeVid,Voe,Dood'
    },
    idType: 'tmdb'
  },
  // VidSrc — requires IMDb IDs (vidsrc.cc format)
  { 
    id: 'vidsrc', 
    name: 'VidSrc', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://vidsrc.cc/v2/embed/movie/{imdbId}?poster=true&autoPlay=false',
    idType: 'imdb'
  },
  // VidSrc alternate domain
  { 
    id: 'vidsrc-alt', 
    name: 'VidSrc Alt', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://vidsrc.to/embed/movie/{imdbId}',
    idType: 'imdb'
  },
  // 2Embed — accepts TMDB IDs
  { 
    id: '2embed', 
    name: '2Embed', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://www.2embed.cc/embed/{tmdbId}',
    idType: 'tmdb'
  },
  // VidLink — accepts TMDB IDs
  { 
    id: 'vidlink', 
    name: 'VidLink', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://vidlink.pro/movie/{tmdbId}',
    idType: 'tmdb'
  },
  // Embed.su — accepts TMDB IDs
  { 
    id: 'embedsu', 
    name: 'Embed.su', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://embed.su/embed/movie/{tmdbId}',
    idType: 'tmdb'
  },
  // VidFast — accepts TMDB IDs
  { 
    id: 'vidfast', 
    name: 'VidFast', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://vidfast.pro/movie/{tmdbId}',
    idType: 'tmdb'
  },
  // CineSrc — accepts TMDB IDs
  { 
    id: 'cinesrc', 
    name: 'CineSrc', 
    enabled: true, 
    method: 'query',
    baseUrl: 'https://cinesrc.st/embed',
    params: { tmdb: '{tmdbId}' },
    idType: 'tmdb'
  }
];

const seriesSources = [
  // PrimeSrc — accepts TMDB IDs directly
  { 
    id: 'primesrc', 
    name: 'PrimeSrc', 
    enabled: true, 
    method: 'query', 
    baseUrl: 'https://primesrc.me/embed/tv',
    params: { 
      tmdb: '{tmdbId}', 
      season: '{season}', 
      episode: '{episode}',
      fallback: 'true'
    },
    idType: 'tmdb'
  },
  // VidSrc — requires IMDb IDs
  { 
    id: 'vidsrc', 
    name: 'VidSrc', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://vidsrc.cc/v2/embed/tv/{imdbId}/{season}/{episode}?poster=true&autoPlay=false',
    idType: 'imdb'
  },
  // VidSrc alternate
  { 
    id: 'vidsrc-alt', 
    name: 'VidSrc Alt', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://vidsrc.to/embed/tv/{imdbId}/{season}/{episode}',
    idType: 'imdb'
  },
  // 2Embed — accepts TMDB IDs
  { 
    id: '2embed', 
    name: '2Embed', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://www.2embed.cc/embedtv/{tmdbId}&s={season}&e={episode}',
    idType: 'tmdb'
  },
  // VidLink — accepts TMDB IDs
  { 
    id: 'vidlink', 
    name: 'VidLink', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://vidlink.pro/tv/{tmdbId}/{season}/{episode}',
    idType: 'tmdb'
  },
  // Embed.su — accepts TMDB IDs
  { 
    id: 'embedsu', 
    name: 'Embed.su', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://embed.su/embed/tv/{tmdbId}/{season}/{episode}',
    idType: 'tmdb'
  },
  // VidFast — accepts TMDB IDs
  { 
    id: 'vidfast', 
    name: 'VidFast', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://vidfast.pro/tv/{tmdbId}/{season}/{episode}',
    idType: 'tmdb'
  },
  // CineSrc — accepts TMDB IDs
  { 
    id: 'cinesrc', 
    name: 'CineSrc', 
    enabled: true, 
    method: 'query',
    baseUrl: 'https://cinesrc.st/embed',
    params: { 
      tmdb: '{tmdbId}', 
      season: '{season}', 
      episode: '{episode}' 
    },
    idType: 'tmdb'
  }
];

function getEnabledMovieSources() { 
  return movieSources.filter(s => s.enabled); 
}

function getEnabledSeriesSources() { 
  return seriesSources.filter(s => s.enabled); 
}

// buildMovieUrl now accepts either TMDB ID or IMDb ID
// The server passes the appropriate ID based on the source's idType
function buildMovieUrl(sourceId, idOrImdbId, tmdbId) {
  const source = movieSources.find(s => s.id === sourceId && s.enabled);
  if (!source) return '';
  
  // Use the right ID based on what the provider expects
  const idToUse = source.idType === 'imdb' ? idOrImdbId : (tmdbId || idOrImdbId);
  
  if (!idToUse) return '';
  
  if (source.method === 'path') {
    return source.baseUrl
      .replace(/\{imdbId\}/g, encodeURIComponent(String(idToUse)))
      .replace(/\{tmdbId\}/g, encodeURIComponent(String(idToUse)));
  }
  
  if (source.method === 'query') {
    const params = new URLSearchParams();
    Object.entries(source.params || {}).forEach(([key, value]) => {
      params.append(key, String(value)
        .replace(/\{imdbId\}/g, String(idToUse))
        .replace(/\{tmdbId\}/g, String(idToUse)));
    });
    return `${source.baseUrl}?${params.toString()}`;
  }
  
  return '';
}

function buildSeriesUrl(sourceId, idOrImdbId, season, episode, tmdbId) {
  const source = seriesSources.find(s => s.id === sourceId && s.enabled);
  if (!source) return '';
  
  const s = parseInt(season) || 1;
  const e = parseInt(episode) || 1;
  
  // Use the right ID based on what the provider expects
  const idToUse = source.idType === 'imdb' ? idOrImdbId : (tmdbId || idOrImdbId);
  
  if (!idToUse) return '';
  
  if (source.method === 'path') {
    return source.baseUrl
      .replace(/\{imdbId\}/g, encodeURIComponent(String(idToUse)))
      .replace(/\{tmdbId\}/g, encodeURIComponent(String(idToUse)))
      .replace(/\{season\}/g, s)
      .replace(/\{episode\}/g, e);
  }
  
  if (source.method === 'query') {
    const params = new URLSearchParams();
    Object.entries(source.params || {}).forEach(([key, value]) => {
      params.append(key, String(value)
        .replace(/\{imdbId\}/g, String(idToUse))
        .replace(/\{tmdbId\}/g, String(idToUse))
        .replace(/\{season\}/g, s)
        .replace(/\{episode\}/g, e));
    });
    return `${source.baseUrl}?${params.toString()}`;
  }
  
  return '';
}

module.exports = { 
  getEnabledMovieSources, 
  buildMovieUrl, 
  getEnabledSeriesSources, 
  buildSeriesUrl 
};
