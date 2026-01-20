# templatemo_516_known

## Run (legacy frontend)
1) Serve the repo root on port 5500 (matches default CORS):
   python -m http.server 5500
2) Open http://localhost:5500/index.html
3) If you want local backend, set API_BASE to http://localhost:3000 in:
   - js/loginForm.js
   - js/signupForm.js

## Run (React frontend)
1) cd frontend-react
2) npm install
3) npm run dev
4) Open http://localhost:5173/index.html

Notes:
- Vite proxy: /api -> http://localhost:3000
- Legacy pages (login/signup) are embedded via iframe pointing to http://localhost:5500
  - Override with env var: VITE_LEGACY_BASE_URL=http://localhost:5500

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

## API contract and parity
- `api-contract.md` documents all backend endpoints and payloads.
- `behavior-parity.md` is the golden test checklist for login/signup/forgot/logout/contact/auth.

## Assumptions used
- Legacy frontend keeps running on port 5500 during migration.
- React routes mirror legacy URLs; login/signup remain legacy until migrated.
