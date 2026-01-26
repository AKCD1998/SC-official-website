# API Contract

Base URL (prod): https://sc-official-website.onrender.com
Base URL (local): http://localhost:3000

Auth
- Auth is token-based via `Authorization: Bearer <jwt>` header for protected routes.
- No cookies are used by the current backend.

## Auth

### POST /api/auth/start-signup
Request body:
```json
{ "email": "user@example.com" }
```
Responses:
- 200 `{ "ok": true }`
- 400 `{ "error": "Email is required." | "Invalid email." }`
- 409 `{ "error": "Email already registered." }`
- 429 `{ "error": "Please wait a bit before requesting another code." }`
- 500 `{ "error": "Internal server error." }`

### POST /api/auth/verify-email
Request body:
```json
{ "email": "user@example.com", "code": "123456" }
```
Responses:
- 200 `{ "ok": true }`
- 400 `{ "error": "Email and code are required." | "Invalid email." | "No valid code. Request a new one." | "Invalid code." }`
- 429 `{ "error": "Too many attempts. Request a new code." }`
- 500 `{ "error": "Internal server error." }`

### POST /api/auth/finish-signup
Request body:
```json
{ "fullName": "Full Name", "email": "user@example.com", "password": "Password123" }
```
Responses:
- 200 `{ "ok": true }`
- 400 `{ "error": "Full name, email, and password are required." | "Invalid email." | "Password must be at least 8 characters long." }`
- 403 `{ "error": "Email not verified." }`
- 409 `{ "error": "Email already registered." }`
- 500 `{ "error": "Internal server error." }`

### POST /api/auth/login
Request body:
```json
{ "email": "user@example.com", "password": "Password123" }
```
Responses:
- 200 `{ "token": "<jwt>" }`
- 400 `{ "error": "Email and password are required." | "Invalid email or password." }`
- 500 `{ "error": "JWT secret not configured." | "Internal server error." }`

### GET /api/auth/me
Headers:
```
Authorization: Bearer <jwt>
```
Responses:
- 200 `{ "ok": true, "user": { "userId": 1, "email": "user@example.com", "fullName": "Full Name" } }`
- 401/403 `{ "error": "Unauthorized" }` (from auth middleware)
- 500 `{ "error": "Internal server error." }`

### POST /api/auth/forgot-password
Request body:
```json
{ "email": "user@example.com" }
```
Responses:
- 200 `{ "ok": true }`
- 400 `{ "error": "Email is required." | "Invalid email." }`
- 403 `{ "error": "?????????????????????????????" }`
- 404 `{ "error": "???????????????????" }`
- 500 `{ "error": "Internal server error." }`

### POST /api/auth/verify-reset-otp
Request body:
```json
{ "email": "user@example.com", "otp": "123456" }
```
Responses:
- 200 `{ "ok": true, "resetToken": "<token>" }`
- 400 `{ "error": "Email and otp are required." | "Invalid email." | "??????????????? OTP" | "OTP ??????????? ???????????" | "OTP ??????????" }`
- 429 `{ "error": "??????????????? ??????? OTP ????" }`
- 500 `{ "error": "Internal server error." }`

### POST /api/auth/reset-password
Request body:
```json
{ "email": "user@example.com", "resetToken": "<token>", "newPassword": "NewPassword123" }
```
Responses:
- 200 `{ "ok": true }`
- 400 `{ "error": "Email, resetToken, and newPassword are required." | "Invalid email." | "Password must be at least 8 chars." | "???????????????????????" | "??????????????????? OTP" | "resetToken ??????? ???????????" | "Invalid reset token" }`
- 500 `{ "error": "Internal server error." }`

## Contact

### POST /api/contact
Request body:
```json
{ "name": "Full Name", "email": "user@example.com", "message": "Hello" }
```
Responses:
- 200 `{ "ok": true }`
- 400 `{ "error": "All fields are required." | "Invalid email." }`
- 500 `{ "error": "Failed to send message." }`

## Health

### GET /
Response: `Server is running`

### GET /health
Response:
```json
{ "ok": true }
```

### GET /api/health
Response:
```json
{ "ok": true }
```

### GET /api/auth/ping
Response:
```json
{ "ok": true }
```
