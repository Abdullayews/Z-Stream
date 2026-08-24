// ─────────────────────────────────────────────────────────────
// sources.js — FIXED embed provider URLs
// PrimeSrc: was vidsrc.xyz (DEAD) → now primesrc.me
// VidSrc: vidsrc.to may be dead → using vidsrc.cc (confirmed working)
// SmashyStream: removed "player." prefix causing SSL mismatch
// MoviesAPI: kept moviesapi.club (redirects to w1.moviesapi.to internally)
// ─────────────────────────────────────────────────────────────

const movieSources = [
  // PrimeSrc — CORRECTED: was vidsrc.xyz (dead), now primesrc.me
  { 
    id: 'primesrc', 
    name: 'PrimeSrc', 
    enabled: true, 
    method: 'query', 
    baseUrl: 'https://primesrc.me/embed/movie',
    params: { 
      tmdb: '{tmdbId}',
      fallback: 'true' 
    }
  },
  // VidSrc — Using vidsrc.cc (confirmed working via multiple sources)
  { 
    id: 'vidsrc', 
    name: 'VidSrc', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://vidsrc.cc/v2/embed/movie/{tmdbId}'
  },
  // VidSrc alternate domain (in case vidsrc.cc goes down)
  { 
    id: 'vidsrc-alt', 
    name: 'VidSrc Alt', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://vidsrc.me/embed/movie/{tmdbId}'
  },
  // VidLink
  { 
    id: 'vidlink', 
    name: 'VidLink', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://vidlink.pro/movie/{tmdbId}'
  },
  // 2Embed
  { 
    id: '2embed', 
    name: '2Embed', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://www.2embed.cc/embed/{tmdbId}'
  },
  // SmashyStream — FIXED: removed "player." prefix causing SSL_ERROR_BAD_CERT_DOMAIN
  { 
    id: 'smashy', 
    name: 'SmashyStream', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://smashy.stream/movie/{tmdbId}'
  },
  // Embed.su — alternate domain that works
  { 
    id: 'embedsu', 
    name: 'Embed.su', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://embed.su/embed/movie/{tmdbId}'
  },
  // VidFast — kept, confirmed safe (94/100 trust score)
  { 
    id: 'vidfast', 
    name: 'VidFast', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://vidfast.pro/movie/{tmdbId}'
  },
  // MoviesAPI — kept, redirects to w1.moviesapi.to internally
  { 
    id: 'moviesapi', 
    name: 'MoviesAPI', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://moviesapi.club/movie/{tmdbId}'
  },
  // CineSrc — new alternative found during research
  { 
    id: 'cinesrc', 
    name: 'CineSrc', 
    enabled: true, 
    method: 'query',
    baseUrl: 'https://cinesrc.st/embed',
    params: { tmdb: '{tmdbId}' }
  }
];

const seriesSources = [
  // PrimeSrc — CORRECTED for TV
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
    }
  },
  // VidSrc for TV
  { 
    id: 'vidsrc', 
    name: 'VidSrc', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://vidsrc.cc/v2/embed/tv/{tmdbId}/{season}/{episode}'
  },
  // VidSrc alternate
  { 
    id: 'vidsrc-alt', 
    name: 'VidSrc Alt', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://vidsrc.me/embed/tv/{tmdbId}/{season}/{episode}'
  },
  // VidLink for TV
  { 
    id: 'vidlink', 
    name: 'VidLink', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://vidlink.pro/tv/{tmdbId}/{season}/{episode}'
  },
  // 2Embed for TV
  { 
    id: '2embed', 
    name: '2Embed', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://www.2embed.cc/embedtv/{tmdbId}&s={season}&e={episode}'
  },
  // SmashyStream for TV — FIXED domain
  { 
    id: 'smashy', 
    name: 'SmashyStream', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://smashy.stream/tv/{tmdbId}?s={season}&e={episode}'
  },
  // Embed.su for TV
  { 
    id: 'embedsu', 
    name: 'Embed.su', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://embed.su/embed/tv/{tmdbId}/{season}/{episode}'
  },
  // VidFast for TV
  { 
    id: 'vidfast', 
    name: 'VidFast', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://vidfast.pro/tv/{tmdbId}/{season}/{episode}'
  },
  // MoviesAPI for TV
  { 
    id: 'moviesapi', 
    name: 'MoviesAPI', 
    enabled: true, 
    method: 'path', 
    baseUrl: 'https://moviesapi.club/tv/{tmdbId}-{season}-{episode}'
  },
  // CineSrc for TV
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
    }
  }
];

function getEnabledMovieSources() { 
  return movieSources.filter(s => s.enabled); 
}

function getEnabledSeriesSources() { 
  return seriesSources.filter(s => s.enabled); 
}

function buildMovieUrl(sourceId, tmdbId) {
  const source = movieSources.find(s => s.id === sourceId && s.enabled);
  if (!source || !tmdbId) return '';

  if (source.method === 'path') {
    return source.baseUrl.replace(/\{tmdbId\}/g, encodeURIComponent(String(tmdbId)));
  }

  if (source.method === 'query') {
    const params = new URLSearchParams();
    Object.entries(source.params || {}).forEach(([key, value]) => {
      params.append(key, String(value).replace(/\{tmdbId\}/g, String(tmdbId)));
    });
    return `${source.baseUrl}?${params.toString()}`;
  }

  return '';
}

function buildSeriesUrl(sourceId, tmdbId, season, episode) {
  const source = seriesSources.find(s => s.id === sourceId && s.enabled);
  if (!source || !tmdbId) return '';

  const s = parseInt(season) || 1;
  const e = parseInt(episode) || 1;

  if (source.method === 'path') {
    return source.baseUrl
      .replace(/\{tmdbId\}/g, encodeURIComponent(String(tmdbId)))
      .replace(/\{season\}/g, s)
      .replace(/\{episode\}/g, e);
  }

  if (source.method === 'query') {
    const params = new URLSearchParams();
    Object.entries(source.params || {}).forEach(([key, value]) => {
      params.append(key, String(value)
        .replace(/\{tmdbId\}/g, String(tmdbId))
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
