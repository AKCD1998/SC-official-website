# templatemo_516_known

## Run (frontend)
1) Serve the repo root on port 5500 (matches default CORS):
   python -m http.server 5500
2) Open http://localhost:5500/index.html
3) If you want local backend, set API_BASE to http://localhost:3000 in:
   - js/loginForm.js
   - js/signupForm.js

## Run (backend)
1) cd backend
2) npm install
3) Create backend/.env with at least:
   PORT=3000
   CORS_ORIGIN=http://localhost:5500
   DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/DBNAME
   JWT_SECRET=your_jwt_secret
   OTP_SECRET=your_otp_secret
   OTP_TTL_MINUTES=10
   SENDGRID_API_KEY=your_sendgrid_key
   MAIL_USER=verified_sender@example.com
   MAIL_TO=receiver@example.com
4) npm start

## DB
PostgreSQL tables/columns used by the backend:
- users: id, email, password_hash, full_name, is_verified, verified_at
- email_verifications: id, email, code_hash, created_at, expires_at, used_at, attempt_count
- password_resets: email, otp_hash, expires_at, attempts, reset_token_hash, reset_token_expires_at

## Smoke test checklist
- Login with a valid user; navbar shows email and token saved in localStorage.
- List/Create/Edit: not implemented in current backend; skip or define once endpoints exist.
- Logout from navbar; token removed and UI resets.
- Permissions: call GET /api/auth/me without token (should fail) and with token (should pass).
