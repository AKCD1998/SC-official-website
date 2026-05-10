export const AUTH_NO_STORE_CACHE_CONTROL =
  'no-store, no-cache, must-revalidate, private, max-age=0';

export function applyAuthNoStore(req, res, next) {
  // Staff auth/session responses must never participate in browser or
  // intermediary caching. If `/api/auth/me` gets revalidated with an ETag,
  // Express can emit `304 Not Modified`, which breaks the LIFF startup gate
  // because fetch treats 304 as a non-OK response.
  res.setHeader('Cache-Control', AUTH_NO_STORE_CACHE_CONTROL);
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  // Strip conditional request headers so auth routes always return a fresh
  // body instead of an accidental 304 when the client replays a cached ETag.
  delete req.headers['if-none-match'];
  delete req.headers['if-modified-since'];

  return next();
}

export default applyAuthNoStore;
