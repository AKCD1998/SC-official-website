# Backend Architecture

Last reviewed against source on 2026-05-12.

## Purpose

This document describes the backend that powers `currentSC-official-website-project` as it exists in code today. It is intended to be the practical starting point for backend changes, especially when deciding where a new feature should live.

## High-Level Shape

- Runtime: Node.js
- Web framework: Express 5
- Module system at the top level: CommonJS
- Primary backend entrypoint: `backend/server.js`
- Main database client: `pg` via `backend/db.js`
- Main deployment shape: one shared Express server that mounts several feature modules under different `/api/*` prefixes

This is not a microservice architecture. It is one backend process with multiple route groups.

## Topology

```text
frontend-react (Vite/React)
        |
        |  /api requests
        v
backend/server.js
        |
        |-- /api/auth       -> backend/routes/auth.js
        |-- /api/contact    -> inline route in backend/server.js
        |-- /api/slider     -> backend/routes/slider.js
        |-- /api/rx1011     -> backend/src/modules/rx1011/lazyRouter.cjs
        |-- /api/reactnjob  -> backend/src/modules/reactnjob/index.js
        |-- /api/digitalpjk -> backend/src/modules/digitalpjk/lazyRouter.cjs
        |-- /api/scglamliff -> backend/src/modules/scglamliff/lazyRouter.cjs
        |
        |-- shared static serving in production
        |-- shared CORS handling
        |-- shared JSON parsing
```

## Main Backend Responsibilities

### 1. Core website backend

Owned by the top-level `backend/` files:

- `backend/server.js`
- `backend/routes/auth.js`
- `backend/routes/slider.js`
- `backend/middleware/requireAuth.js`
- `backend/db.js`

Current responsibilities:

- user signup with email OTP
- login with JWT
- current-user lookup via JWT
- forgot-password and reset-password flows
- contact form email delivery
- homepage slider config and admin image upload
- production serving of the built React app

### 2. Namespaced integrated modules

These are mounted into the same server but are logically separate feature areas:

- `rx1011`
- `reactnjob`
- `digitalpjk`
- `scglamliff`

Important architectural point:
some modules are loaded through lazy router bridges because the host backend is CommonJS while some imported modules expose ESM entrypoints. The bridge files are:

- `backend/src/modules/rx1011/lazyRouter.cjs`
- `backend/src/modules/digitalpjk/lazyRouter.cjs`
- `backend/src/modules/scglamliff/lazyRouter.cjs`

`reactnjob` is mounted directly as a router factory and does not use the same lazy bridge pattern.

## Request Lifecycle

Typical request flow for website APIs:

1. The React frontend sends a request to `/api/...`.
2. In development, Vite proxies `/api` to `http://localhost:3000`.
3. `backend/server.js` applies CORS rules for `/api`.
4. The request is dispatched to the matching route group.
5. Route code may:
   - validate input
   - check JWT auth
   - query PostgreSQL
   - send email through SendGrid
   - upload assets to Cloudflare R2
6. JSON responses are returned to the frontend.

## Cross-Cutting Concerns

### CORS

Defined in `backend/server.js`.

- Allowed origins come from `CORS_ORIGIN`, comma-separated.
- Local backend origins are auto-added for convenience.
- If `CORS_ORIGIN` is empty, the server effectively allows all origins.
- `OPTIONS /api/*` preflight is handled explicitly for Express 5 compatibility.

### Auth

Main website auth uses:

- JWT in `Authorization: Bearer <token>`
- verification in `backend/middleware/requireAuth.js`
- JWT secret from `JWT_SECRET`

No cookie-based session layer is used for the main website auth routes documented in `api-contract.md`.

### Database

Main website database access is centralized in `backend/db.js`.

- Preferred env var: `SC_OFFICIAL_DATABASE_URL`
- Legacy fallback: `DATABASE_URL`
- Driver: `pg`
- SSL in production: enabled with `rejectUnauthorized: false`

Main website tables currently documented in `README.md`:

- `users`
- `email_verifications`
- `password_resets`
- `slider_config`

The slider table is created from SQL on route import using:

- `backend/migrations/slider_config_table.sql`

### Email

The core website backend uses SendGrid through `@sendgrid/mail`.

Main env vars:

- `SENDGRID_API_KEY`
- `MAIL_USER`
- `MAIL_TO`

Used for:

- contact form delivery
- signup verification codes
- password reset OTP

### File Storage

Slider image uploads use:

- Cloudflare R2 when configured
- local disk fallback in development when R2 is not configured

Relevant files:

- `backend/lib/r2Storage.js`
- `backend/routes/slider.js`

## Current Route Ownership

### Core website routes

Defined directly in top-level backend files:

- `POST /api/contact`
- `GET /api/health`
- `GET /api/auth/ping`
- `POST /api/auth/start-signup`
- `POST /api/auth/verify-email`
- `POST /api/auth/finish-signup`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/forgot-password`
- `POST /api/auth/verify-reset-otp`
- `POST /api/auth/reset-password`
- `GET /api/slider/config`
- `POST /api/slider/upload/:slideId`

### Integrated module prefixes

- `/api/rx1011`
- `/api/reactnjob`
- `/api/digitalpjk`
- `/api/scglamliff`

Module-specific endpoint details are spread across:

- `RX1011_INTEGRATION_REPORT.md`
- module source folders under `backend/src/modules/*`

## Production Serving Behavior

In production mode:

- the backend serves `frontend-react/dist`
- `index.html` is marked non-cacheable
- direct requests for missing asset files return `404`
- non-API SPA routes fall back to `index.html`

This means the backend currently acts as both:

- API server
- static frontend host

## Testing and Safety Nets

Observed test coverage is mostly baseline and integration smoke coverage, not exhaustive feature coverage.

Key test files:

- `backend/tests/backend-integration.test.cjs`
- `backend/tests/slider.test.cjs`

Current test intent includes:

- server startup validation
- import safety for integrated modules
- some route-level smoke checks
- some env-isolation checks for imported modules

## What Is Missing From The Current Documentation

The repo already has useful partial docs, but not one complete current backend architecture document:

- `README.md` explains setup and deployment at a high level.
- `api-contract.md` documents the core website endpoints.
- `behavior-parity.md` is a checklist, not an architecture guide.
- `RX1011_INTEGRATION_REPORT.md` is detailed, but only for the Rx1011 integration.

Before this file was added, there was no single up-to-date markdown that explained:

- the complete top-level backend structure
- which routes belong to which area
- how shared concerns are handled
- where a new backend feature should be added

## Best Place To Add "Chat With Us"

### Current reality

There is no existing live-chat infrastructure in this repo right now.

Not present in the current codebase:

- WebSocket server
- Socket.IO
- chat database schema
- operator/admin live inbox
- persistent conversation model
- rate limiting for chat traffic
- notification or assignment workflow for chat agents

### Recommendation

For this project, building a full real-time customer support system from scratch inside this backend is usually not the best first move unless chat is a core product requirement.

The wiser options are:

1. Embed a reliable hosted chat product.
2. Build a simple message-based "contact us chat-style" feature in this repo.
3. Build a full custom live chat system only if you truly need ownership of everything.

### Recommended order

#### Option A: Hosted chat service

Best if you want something dependable quickly.

Examples of the kind of product to evaluate:

- Crisp
- Tidio
- Intercom
- Zendesk messaging

Why this is usually best:

- faster to launch
- already handles agent inboxes
- already handles notifications
- already handles conversation storage
- lower engineering risk
- easier for a non-programmer owner to operate

Tradeoff:

- monthly cost
- third-party dependency
- less custom behavior

#### Option B: Simple in-repo message system

Best if your real need is just:
"customers can send us a message in a chat-like box and staff can read it later."

This can be added safely to the current backend by creating a new route group such as:

- `/api/chat`

Likely first version:

- `POST /api/chat/messages`
- optional `GET /api/chat/messages` for admin only

Backed by a simple table such as:

- `chat_messages`

Columns would likely include:

- `id`
- `name`
- `email`
- `message`
- `status`
- `created_at`
- `assigned_to`

This is much simpler than real live chat and fits the current architecture well.

#### Option C: Full custom live chat

Best only if you need:

- real-time visitor and staff messaging
- operator presence
- multi-agent handling
- admin dashboards
- typing indicators
- conversation history
- assignment rules

For this repo, that would mean adding at least:

- a websocket layer or Socket.IO
- chat tables
- admin interface
- authentication/authorization rules for staff
- rate limiting and abuse protection
- delivery state and reconnection logic

That is a materially larger project than the existing contact form.

## Practical Recommendation For This Repo

If you are an outsider to programming and want the best result with the lowest risk:

1. Use a hosted chat provider if you want real live chat.
2. If you only need a customer inquiry box that looks like chat, build a simple `/api/chat` feature in this repo instead of copying a random GitHub chat server.
3. Do not paste in a large third-party GitHub chat codebase unless you are prepared to maintain its auth, security, data model, deployment, and updates.

## If We Build It Inside This Repo

The safest insertion point is:

- backend: add a new route module under `backend/routes/chat.js`
- server mount: register it from `backend/server.js` at `/api/chat`
- database: create a dedicated migration under `backend/migrations/`
- frontend: replace or extend the current contact form area in `frontend-react/src/routes/Home.jsx`

That approach matches the current architecture better than forcing chat into one of the unrelated imported modules.

## Related Files

- `README.md`
- `api-contract.md`
- `behavior-parity.md`
- `backend/server.js`
- `backend/db.js`
- `backend/routes/auth.js`
- `backend/routes/slider.js`
- `backend/middleware/requireAuth.js`
- `backend/tests/backend-integration.test.cjs`
- `backend/.env.example`
- `RX1011_INTEGRATION_REPORT.md`
