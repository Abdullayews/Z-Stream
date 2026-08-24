// sources.js - Video Embed Sources Configuration
const sources = {
  movies: [
    { id: "primesrc", name: "PrimeSrc", enabled: true, priority: 1, baseUrl: "https://primesrc.me/embed/movie", method: "query", params: { tmdb: "{tmdbId}", fallback: "true" }, requiresTmdb: true },
    { id: "vidsrc_to", name: "VidSrc.to", enabled: true, priority: 2, baseUrl: "https://vidsrc.to/embed/movie/{tmdbId}", method: "path" },
    { id: "embed_su", name: "Embed.su", enabled: true, priority: 3, baseUrl: "https://embed.su/embed/movie/{tmdbId}", method: "path" },
    { id: "autoembed", name: "AutoEmbed", enabled: true, priority: 4, baseUrl: "https://autoembed.cc/embed/movie/{tmdbId}", method: "path" },
    { id: "multiembed", name: "MultiEmbed", enabled: true, priority: 5, baseUrl: "https://multiembed.mov/", method: "query", params: { video_id: "{tmdbId}", tmdb: "1" } },
    { id: "smashystream", name: "SmashyStream", enabled: true, priority: 6, baseUrl: "https://embed.smashystream.com/playere.php", method: "query", params: { tmdb: "{tmdbId}" } },
    { id: "superembed", name: "SuperEmbed", enabled: true, priority: 7, baseUrl: "https://se.bingetime.eu.org/embedmovie/{tmdbId}", method: "path" },
    { id: "twoembed_cc", name: "2Embed.cc", enabled: true, priority: 8, baseUrl: "https://www.2embed.cc/embed/{tmdbId}", method: "path" },
    { id: "twoembed_to", name: "2Embed.to", enabled: true, priority: 9, baseUrl: "https://www.2embed.to/embed/{tmdbId}", method: "path" }
  ],
  series: [
    { id: "primesrc_series", name: "PrimeSrc", enabled: true, priority: 1, baseUrl: "https://primesrc.me/embed/tv", method: "query", params: { tmdb: "{tmdbId}", season: "{season}", episode: "{episode}", fallback: "true" }, pattern: "{baseUrl}?tmdb={tmdbId}&season={season}&episode={episode}&fallback=true" },
    { id: "vidsrc_to_series", name: "VidSrc.to", enabled: true, priority: 2, baseUrl: "https://vidsrc.to/embed/tv", method: "path", pattern: "{baseUrl}/{tmdbId}/{season}/{episode}" },
    { id: "embed_su_series", name: "Embed.su", enabled: true, priority: 3, baseUrl: "https://embed.su/embed/tv", method: "path", pattern: "{baseUrl}/{tmdbId}/{season}/{episode}" },
    { id: "autoembed_series", name: "AutoEmbed", enabled: true, priority: 4, baseUrl: "https://autoembed.cc/embed/tv", method: "path", pattern: "{baseUrl}/{tmdbId}/{season}/{episode}" },
    { id: "multiembed_series", name: "MultiEmbed", enabled: true, priority: 5, baseUrl: "https://multiembed.mov/", method: "query", params: { video_id: "{tmdbId}", tmdb: "1", season: "{season}", episode: "{episode}" }, pattern: "{baseUrl}?video_id={tmdbId}&tmdb=1&season={season}&episode={episode}" },
    { id: "smashystream_series", name: "SmashyStream", enabled: true, priority: 6, baseUrl: "https://embed.smashystream.com/playere.php", method: "query", params: { tmdb: "{tmdbId}", season: "{season}", episode: "{episode}" }, pattern: "{baseUrl}?tmdb={tmdbId}&season={season}&episode={episode}" },
    { id: "superembed_series", name: "SuperEmbed", enabled: true, priority: 7, baseUrl: "https://se.bingetime.eu.org/embedtv", method: "path", pattern: "{baseUrl}/{tmdbId}/{season}/{episode}" },
    { id: "twoembed_cc_series", name: "2Embed.cc", enabled: true, priority: 8, baseUrl: "https://www.2embed.cc/embedtv", method: "path", pattern: "{baseUrl}/{tmdbId}&s={season}&e={episode}" },
    { id: "twoembed_to_series", name: "2Embed.to", enabled: true, priority: 9, baseUrl: "https://www.2embed.to/embedtvfull", method: "path", pattern: "{baseUrl}/{tmdbId}&s={season}&e={episode}" }
  ]
};

function buildMovieUrl(sourceId, tmdbId) {
  const source = sources.movies.find(s => s.id === sourceId);
  if (!source) return "";
  if (source.method === "path") return source.baseUrl.replace("{tmdbId}", tmdbId);
  if (source.method === "query") {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(source.params)) {
      params.append(key, value.replace("{tmdbId}", tmdbId));
    }
    return `${source.baseUrl}?${params.toString()}`;
  }
  return "";
}

function buildSeriesUrl(sourceId, tmdbId, season, episode) {
  const source = sources.series.find(s => s.id === sourceId);
  if (!source) return "";
  if (source.pattern) {
    return source.pattern
      .replace("{baseUrl}", source.baseUrl)
      .replace("{tmdbId}", tmdbId)
      .replace("{season}", season)
      .replace("{episode}", episode);
  }
  if (source.method === "path") return `${source.baseUrl}/${tmdbId}/${season}/${episode}`;
  return "";
}

function getEnabledMovieSources() {
  return sources.movies.filter(s => s.enabled).sort((a, b) => a.priority - b.priority);
}

function getEnabledSeriesSources() {
  return sources.series.filter(s => s.enabled).sort((a, b) => a.priority - b.priority);
}

module.exports = {
  sources,
  buildMovieUrl,
  buildSeriesUrl,
  getEnabledMovieSources,
  getEnabledSeriesSources
};
