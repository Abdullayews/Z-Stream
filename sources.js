// sources.js — Clean embed provider URLs, no Helmet interference

const movieSources = [
  {
    id: 'primesrc',
    name: 'PrimeSrc',
    enabled: true,
    method: 'query',
    baseUrl: 'https://primesrc.me/embed/movie',
    params: { tmdb: '{tmdbId}' }
  },
  {
    id: 'cinesrc',
    name: 'CineSrc',
    enabled: true,
    method: 'path',
    baseUrl: 'https://cinesrc.st/embed/movie/{tmdbId}'
  },
  {
    id: 'vidsrc',
    name: 'VidSrc',
    enabled: true,
    method: 'path',
    baseUrl: 'https://vidsrc.cc/v2/embed/movie/{tmdbId}'
  },
  {
    id: 'vidlink',
    name: 'VidLink',
    enabled: true,
    method: 'path',
    baseUrl: 'https://vidlink.pro/movie/{tmdbId}'
  },
  {
    id: 'embedsu',
    name: 'Embed.su',
    enabled: true,
    method: 'path',
    baseUrl: 'https://embed.su/embed/movie/{tmdbId}'
  },
  {
    id: 'filmu',
    name: 'FilmU',
    enabled: true,
    method: 'path',
    baseUrl: 'https://embed.filmu.in/movie/{tmdbId}'
  }
];

const seriesSources = [
  {
    id: 'primesrc',
    name: 'PrimeSrc',
    enabled: true,
    method: 'query',
    baseUrl: 'https://primesrc.me/embed/tv',
    params: { tmdb: '{tmdbId}', season: '{season}', episode: '{episode}' }
  },
  {
    id: 'cinesrc',
    name: 'CineSrc',
    enabled: true,
    method: 'path',
    baseUrl: 'https://cinesrc.st/embed/tv/{tmdbId}?s={season}&e={episode}'
  },
  {
    id: 'vidsrc',
    name: 'VidSrc',
    enabled: true,
    method: 'path',
    baseUrl: 'https://vidsrc.cc/v2/embed/tv/{tmdbId}/{season}/{episode}'
  },
  {
    id: 'vidlink',
    name: 'VidLink',
    enabled: true,
    method: 'path',
    baseUrl: 'https://vidlink.pro/tv/{tmdbId}/{season}/{episode}'
  },
  {
    id: 'embedsu',
    name: 'Embed.su',
    enabled: true,
    method: 'path',
    baseUrl: 'https://embed.su/embed/tv/{tmdbId}/{season}/{episode}'
  },
  {
    id: 'filmu',
    name: 'FilmU',
    enabled: true,
    method: 'path',
    baseUrl: 'https://embed.filmu.in/tv/{tmdbId}/{season}/{episode}'
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
