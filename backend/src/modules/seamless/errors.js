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

// Distinct from unauthorized (401, "no valid session at all") — this is "you have a valid
// session but it's the wrong role for this action" (e.g. a regular-user session hitting an
// admin-only route).
function forbidden(message, details = null) {
  return new ApiError(403, message, "FORBIDDEN", details);
}

function serviceUnavailable(message, details = null) {
  return new ApiError(503, message, "SERVICE_UNAVAILABLE", details);
}

module.exports = {
  ApiError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  serviceUnavailable,
  unauthorized,
};
