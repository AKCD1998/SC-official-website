# currentSC-official-website-project

## Overview
- Frontend: React (Vite) in `frontend-react/`
- Backend: Node/Express API in `backend/`
- Legacy static files are archived in `legacy/` and are no longer served.

## Run (frontend - dev)
1) cd frontend-react
2) npm install
3) npm run dev
4) Open http://localhost:5173

Notes:
- Vite proxy: `/api` -> `http://localhost:3000` (see `frontend-react/vite.config.js`)
- Optional (prod only): set `VITE_API_BASE_URL` if the frontend should call a different API host
  - Example: `VITE_API_BASE_URL=https://api.yourdomain.com`
  - Use the API host root (no trailing `/api`) to avoid double paths
  - If unset, frontend falls back to same-origin (`/api`), which uses the Vite proxy in dev

## Run (backend - dev)
1) cd backend
2) npm install
3) Create `backend/.env` with at least:
   PORT=3000
   CORS_ORIGIN=http://localhost:5173,https://<your-gh-username>.github.io,https://<custom-domain>
   DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/DBNAME
   JWT_SECRET=your_jwt_secret
   OTP_SECRET=your_otp_secret
   OTP_TTL_MINUTES=10
   SENDGRID_API_KEY=your_sendgrid_key
   MAIL_USER=verified_sender@example.com
   MAIL_TO=receiver@example.com
4) npm start

## Build + serve (production)
1) Build frontend:
   - cd frontend-react
   - npm run build
2) Serve from backend:
   - Set `NODE_ENV=production`
   - Backend will serve `frontend-react/dist` by default
   - Optional: `CLIENT_BUILD_DIR=/absolute/path/to/dist`
   - cd backend
   - npm start

## Deploy (Backend API)
- Set env vars: `PORT`, `DATABASE_URL`, `JWT_SECRET`, `OTP_SECRET`, `OTP_TTL_MINUTES`, `SENDGRID_API_KEY`, `MAIL_USER`, `MAIL_TO`
- Set `CORS_ORIGIN` to include all frontend origins (example):
  - `https://<your-gh-username>.github.io,https://<custom-domain>`
- Verify health: `GET https://<your-api-domain>/api/health` -> `{ "ok": true }`

### Alternative deploy (frontend separate from backend)
- Frontend: deploy the Vite build to a static host (Netlify/Vercel/S3)
- Backend: deploy API separately
- Pros: independent scaling, CDN caching
- Cons: need CORS config and separate deployments
- Set `VITE_API_BASE_URL=https://your-api.example.com` in the frontend build

## Deploy (GitHub Pages)
This app supports both repo subpath deploys and custom-domain root deploys via `VITE_BASE`.

### A) GitHub Pages subpath (repo pages)
- Target URL: `https://akcd1998.github.io/SC-official-website/`
- Build:
  - PowerShell:
    - `$env:VITE_BASE="/SC-official-website/"`
    - `$env:VITE_API_BASE_URL="https://your-api.example.com"` (only if backend is separate)
    - `npm --prefix frontend-react run build`
- Expected URLs:
  - Home: `https://akcd1998.github.io/SC-official-website/`
  - Login: `https://akcd1998.github.io/SC-official-website/login`

### B) GitHub Pages custom domain (root)
- Target URL (example): `https://scdrug.com/`
- Build:
  - PowerShell:
    - `$env:VITE_BASE="/"`
    - `$env:VITE_API_BASE_URL="https://your-api.example.com"` (only if backend is separate)
    - `npm --prefix frontend-react run build`
- Expected URLs:
  - Home: `https://scdrug.com/`
  - Login: `https://scdrug.com/login`

### CNAME file (custom domain)
When the domain is ready, create `frontend-react/public/CNAME` with the domain name (one line).
Vite will copy it into the build output so GitHub Pages can use it.

### SPA refresh on GitHub Pages
The build includes a `404.html` entry so refresh on `/login`, `/signup`, etc. works on Pages.

## Health check
- Backend: `GET /api/health` -> `{ "ok": true }`

## Convenience scripts (repo root)
- `npm run dev:frontend`
- `npm run build:frontend`
- `npm run preview:frontend`
- `npm run start:backend`

## DB
PostgreSQL tables/columns used by the backend:
- users: id, email, password_hash, full_name, is_verified, verified_at
- email_verifications: id, email, code_hash, created_at, expires_at, used_at, attempt_count
- password_resets: email, otp_hash, expires_at, attempts, reset_token_hash, reset_token_expires_at

## API contract and parity
- `api-contract.md` documents all backend endpoints and payloads.
- `behavior-parity.md` is the golden test checklist for login/signup/forgot/logout/contact/auth.
