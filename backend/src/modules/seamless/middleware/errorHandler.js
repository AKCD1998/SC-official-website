function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error && error.name === "MulterError") {
    res.status(400).json({
      error: {
        message:
          error.code === "LIMIT_FILE_SIZE"
            ? "The uploaded workbook is too large."
            : error.message,
        code: error.code || "UPLOAD_ERROR",
      },
    });
    return;
  }

  const statusCode = Number(error.statusCode || error.status || 500);
  const safeStatusCode = statusCode >= 400 && statusCode < 600 ? statusCode : 500;

  res.status(safeStatusCode).json({
    error: {
      message: safeStatusCode === 500 ? "Internal server error" : error.message,
      code: error.code || "REQUEST_FAILED",
      details: error.details || undefined,
    },
  });
}

module.exports = { errorHandler };
