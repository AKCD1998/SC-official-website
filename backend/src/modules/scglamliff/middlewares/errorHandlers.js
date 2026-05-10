export function notFoundHandler(req, res) {
  res.status(404).json({ ok: false, error: 'Not found' });
}

export function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  // Log for debugging without leaking internals to clients
  console.error(err);
  res.status(500).json({ ok: false, error: 'Server error' });
}
