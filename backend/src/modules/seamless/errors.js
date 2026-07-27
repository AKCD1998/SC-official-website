class ApiError extends Error {
  constructor(statusCode, message, code = "REQUEST_FAILED", details = null) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function badRequest(message, details = null) {
  return new ApiError(400, message, "BAD_REQUEST", details);
}

function notFound(message, details = null) {
  return new ApiError(404, message, "NOT_FOUND", details);
}

function conflict(message, details = null) {
  return new ApiError(409, message, "CONFLICT", details);
}

function unauthorized(message, details = null) {
  return new ApiError(401, message, "UNAUTHORIZED", details);
}

function serviceUnavailable(message, details = null) {
  return new ApiError(503, message, "SERVICE_UNAVAILABLE", details);
}

module.exports = {
  ApiError,
  badRequest,
  conflict,
  notFound,
  serviceUnavailable,
  unauthorized,
};
