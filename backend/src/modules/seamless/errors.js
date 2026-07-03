class ApiError extends Error {
  constructor(statusCode, message, details = null) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

function badRequest(message, details = null) {
  return new ApiError(400, message, details);
}

function notFound(message, details = null) {
  return new ApiError(404, message, details);
}

module.exports = {
  ApiError,
  badRequest,
  notFound,
};
