export function notFoundHandler(_req, res) {
  return res.status(404).json({ error: "Not found" });
}

export function errorHandler(err, _req, res, _next) {
  console.error(err);
  const status = Number(err?.statusCode || err?.status || 500);
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  const message = safeStatus >= 500 ? "Internal server error" : err.message;
  return res.status(safeStatus).json({ error: message });
}
