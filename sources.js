// ─────────────────────────────────────────────────────────────
// sources.js — Central embed-provider configuration
// To add / remove / rename a provider, just edit the arrays.
//   method 'path'  → placeholders {tmdbId} {season} {episode} in baseUrl
//   method 'query' → placeholders in param VALUES, appended to baseUrl
// If a provider changes its domain, update baseUrl here only.
// ─────────────────────────────────────────────────────────────

const movieSources = [
  { id: 'primesrc',  name: 'PrimeSrc',      enabled: true, method: 'query', baseUrl: 'https://vidsrc.xyz/embed/movie', params: { tmdb: '{tmdbId}' } },
  { id: 'vidsrc',    name: 'VidSrc.to',     enabled: true, method: 'path',  baseUrl: 'https://vidsrc.to/embed/movie/{tmdbId}' },
  { id: 'vidlink',   name: 'VidLink',       enabled: true, method: 'path',  baseUrl: 'https://vidlink.pro/movie/{tmdbId}' },
  { id: '2embed',    name: '2Embed',        enabled: true, method: 'path',  baseUrl: 'https://www.2embed.cc/embed/{tmdbId}' },
  { id: 'smashy',    name: 'SmashyStream',  enabled: true, method: 'path',  baseUrl: 'https://player.smashy.stream/movie/{tmdbId}' },
  { id: 'embedsu',   name: 'Embed.su',      enabled: true, method: 'path',  baseUrl: 'https://embed.su/embed/movie/{tmdbId}' },
  { id: 'vidfast',   name: 'VidFast',       enabled: true, method: 'path',  baseUrl: 'https://vidfast.pro/movie/{tmdbId}' },
  { id: 'moviesapi', name: 'MoviesAPI',     enabled: true, method: 'path',  baseUrl: 'https://moviesapi.club/movie/{tmdbId}' }
];

const seriesSources = [
  { id: 'primesrc',  name: 'PrimeSrc',      enabled: true, method: 'query', baseUrl: 'https://vidsrc.xyz/embed/tv', params: { tmdb: '{tmdbId}', season: '{season}', episode: '{episode}' } },
  { id: 'vidsrc',    name: 'VidSrc.to',     enabled: true, method: 'path',  baseUrl: 'https://vidsrc.to/embed/tv/{tmdbId}/{season}/{episode}' },
  { id: 'vidlink',   name: 'VidLink',       enabled: true, method: 'path',  baseUrl: 'https://vidlink.pro/tv/{tmdbId}/{season}/{episode}' },
  { id: '2embed',    name: '2Embed',        enabled: true, method: 'path',  baseUrl: 'https://www.2embed.cc/embedtv/{tmdbId}&s={season}&e={episode}' },
  { id: 'smashy',    name: 'SmashyStream',  enabled: true, method: 'path',  baseUrl: 'https://player.smashy.stream/tv/{tmdbId}?s={season}&e={episode}' },
  { id: 'embedsu',   name: 'Embed.su',      enabled: true, method: 'path',  baseUrl: 'https://embed.su/embed/tv/{tmdbId}/{season}/{episode}' },
  { id: 'vidfast',   name: 'VidFast',       enabled: true, method: 'path',  baseUrl: 'https://vidfast.pro/tv/{tmdbId}/{season}/{episode}' },
  { id: 'moviesapi', name: 'MoviesAPI',     enabled: true, method: 'path',  baseUrl: 'https://moviesapi.club/tv/{tmdbId}/{season}/{episode}' }
];

function getEnabledMovieSources()  { return movieSources.filter(s => s.enabled); }
function getEnabledSeriesSources() { return seriesSources.filter(s => s.enabled); }

// ── Movie URL builder (handles BOTH methods — this was the PrimeSrc bug) ──
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

// ── Series URL builder ──
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

module.exports = { getEnabledMovieSources, buildMovieUrl, getEnabledSeriesSources, buildSeriesUrl };
