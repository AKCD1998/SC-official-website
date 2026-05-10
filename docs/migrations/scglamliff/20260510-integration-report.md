# scGlamLiff Integration Report

Generated: 2026-05-10

## Manifest

```yaml
project_slug: "scglamliff"
source_repo: "C:/Users/scgro/Desktop/Webapp training project/scGlamLiff-reception"
target_repo: "C:/Users/scgro/Desktop/Webapp training project/currentSC-official-website-project"
namespace: "/api/scglamliff"
routes_old_to_new:
  - old: "/api/health"
    new: "/api/scglamliff/health"
  - old: "/api/auth/*"
    new: "/api/scglamliff/auth/*"
  - old: "/api/appointments/*"
    new: "/api/scglamliff/appointments/*"
  - old: "/api/appointment-drafts/*"
    new: "/api/scglamliff/appointment-drafts/*"
  - old: "/api/admin/*"
    new: "/api/scglamliff/admin/*"
  - old: "/api/branch-device-registrations/*"
    new: "/api/scglamliff/branch-device-registrations/*"
  - old: "/api/reporting/*"
    new: "/api/scglamliff/reporting/*"
  - old: "/api/customers/*"
    new: "/api/scglamliff/customers/*"
  - old: "/api/visits/*"
    new: "/api/scglamliff/visits/*"
  - old: "/api/sheet-visits/*"
    new: "/api/scglamliff/sheet-visits/*"
env_required:
  - "SCGLAMLIFF_DATABASE_URL"
  - "SCGLAMLIFF_JWT_SECRET"
  - "SCGLAMLIFF_COOKIE_SAMESITE"
  - "SCGLAMLIFF_COOKIE_SECURE"
  - "SCGLAMLIFF_GAS_APPOINTMENTS_URL"
  - "SCGLAMLIFF_GAS_SECRET"
  - "SCGLAMLIFF_LINE_CHANNEL_ID"
  - "SCGLAMLIFF_DEFAULT_BRANCH_ID"
  - "SCGLAMLIFF_LEGACY_SHEET_MODE"
  - "SCGLAMLIFF_PIN_FINGERPRINT_SECRET"
services_touched:
  - "target backend local code only"
  - "no Render service mutation"
migrations_copied: []
migrations_executed: []
dependencies_added:
  - "bcryptjs"
  - "cookie-parser"
security_checks:
  - "project-scoped database env"
  - "project-scoped JWT env"
  - "scoped auth cookie"
  - "destructive appointment routes require auth and admin"
  - "OCR/upload routes not mounted"
tests_run:
  - "npm --prefix backend test"
  - "npm ls --omit=dev"
  - "npm audit --omit=dev"
  - "generated-doc secret scan"
  - "git diff --check"
rollback_steps:
  - "remove /api/scglamliff mount from backend/server.js"
  - "remove backend/src/modules/scglamliff"
  - "remove SCGLAMLIFF_* examples from backend/.env.example"
  - "remove scGlamLiff test cases"
  - "remove unused bcryptjs/cookie-parser dependency changes if no other module uses them"
```

## Files Changed

- Added `backend/src/modules/scglamliff/` with the active Express API code copied from the source backend.
- Added `backend/src/modules/scglamliff/lazyRouter.cjs` so the CommonJS target server can lazy-load the ESM module.
- Added `backend/src/modules/scglamliff/config/env.js` to centralize project-scoped env reads.
- Updated `backend/server.js` to mount `/api/scglamliff`.
- Updated `backend/.env.example` with names-only `SCGLAMLIFF_*` placeholders.
- Updated backend integration tests for scGlamLiff smoke coverage.

## Route Mapping

The copied module is mounted under `/api/scglamliff`. Source route paths that previously began with `/api` now mount relative to the namespace.

The separate OCR/upload endpoint is intentionally not mounted in v1:

- excluded: `/api/ocr/health`
- excluded: `/api/ocr/receipt`
- excluded: `/api/internal/receipt-uploads/*`
- excluded: `backend/services/ocr_python`

## Env Vars

No secret values were copied.

Required or supported names:

- `SCGLAMLIFF_DATABASE_URL`
- `SCGLAMLIFF_PGSSLMODE`
- `SCGLAMLIFF_JWT_SECRET`
- `SCGLAMLIFF_COOKIE_SAMESITE`
- `SCGLAMLIFF_COOKIE_SECURE`
- `SCGLAMLIFF_COOKIE_DOMAIN`
- `SCGLAMLIFF_GAS_APPOINTMENTS_URL`
- `SCGLAMLIFF_GAS_SECRET`
- `SCGLAMLIFF_LINE_CHANNEL_ID`
- `SCGLAMLIFF_DEFAULT_BRANCH_ID`
- `SCGLAMLIFF_LEGACY_SHEET_MODE`
- `SCGLAMLIFF_PIN_FINGERPRINT_SECRET`
- `SCGLAMLIFF_DEBUG_QUEUE_PHONE_FRAGMENT`
- `SCGLAMLIFF_DEBUG_TREATMENT_CATALOG_PREVIEW`

Frontend follow-up names:

- `VITE_SCGLAMLIFF_API_BASE_URL`
- `VITE_SCGLAMLIFF_API_PREFIX`

Render names from the standalone app that are not read by the v1 shared module:

- `SCGLAMLIFF_FRONTEND_ORIGINS`: CORS remains centralized in the shared backend. Add the scGlamLiff frontend origin to shared `CORS_ORIGIN` instead.
- `SCGLAMLIFF_ADMIN_USERNAME`, `SCGLAMLIFF_ADMIN_PASSWORD`, `SCGLAMLIFF_ADMIN_DISPLAY_NAME`: seed/admin scripts were not copied or executed.
- `SCGLAMLIFF_SEED_USERNAME`, `SCGLAMLIFF_SEED_PASSWORD`, `SCGLAMLIFF_SEED_DISPLAY_NAME`, `SCGLAMLIFF_SEED_ROLE`: seed scripts were not copied or executed.
- `SCGLAMLIFF_BASE_URL`, `SCGLAMLIFF_PORT`, `SCGLAMLIFF_NODE_ENV`: the shared web service owns base URL, port, and process runtime mode globally.
- `SCGLAMLIFF_LINE_CHANNEL_SECRET`: the copied LIFF verification path uses the channel ID only.
- `SCGLAMLIFF_OMISE_SECRET_KEY`: no Omise payment path is mounted in this v1 module.
- `SCGLAMLIFF_R2_ACCESS_KEY_ID`, `SCGLAMLIFF_R2_BUCKET`, `SCGLAMLIFF_R2_ENDPOINT`, `SCGLAMLIFF_R2_KEY_PREFIX`, `SCGLAMLIFF_R2_SECRET_ACCESS_KEY`, `SCGLAMLIFF_RECEIPT_UPLOAD_STORAGE_DIR`: receipt upload/OCR/storage routes are intentionally excluded from v1.

## Database And Migrations

- The migrated module does not read shared `DATABASE_URL`.
- The module requires `SCGLAMLIFF_DATABASE_URL` for database operations.
- The DB pool is lazy so imports and route registration do not open a database connection.
- No migration, seed, repair, cleanup, or backfill script was run.
- Source migration scripts were not copied in this v1 HTTP integration. They remain in the source repo and require a separate database gate before use.

## Auth And Security

- JWT signing and verification use `SCGLAMLIFF_JWT_SECRET`.
- New tokens include audience `scglamliff`.
- The auth cookie is `scglamliff_token`, not the source generic `token`.
- Cookie options use `SCGLAMLIFF_COOKIE_*`.
- `POST /appointments/delete-hard` and `DELETE /appointments/:id` now require staff auth and admin role in the migrated module.
- CORS remains centralized in target `backend/server.js` under `/api`.
- OCR/upload routes were not mounted to avoid storage and resource risk in this first pass.

## Render And Deployment

- Target shared Render service ID: `srv-d58idfm3jp1c73bhgv40`.
- Old standalone Render service ID: `srv-d5tl61coud1c7397hpv0`.
- No Render config, env var, restart, deploy trigger, suspend, or delete operation was performed.
- Auto-deploy behavior was not changed.

## Verification

- `npm --prefix backend test`: passed, 41 tests.
- `npm ls --omit=dev`: passed.
- `npm audit --omit=dev`: reported one existing moderate `nodemailer` advisory; this migration did not add `nodemailer`.
- Generated-doc/test secret scan: passed after removing dummy DSN-shaped strings from tests.
- `git diff --check`: passed with line-ending warnings only.

## Rollback

Rollback is code-only for this phase:

1. Revert the commit that adds the scGlamLiff module and mount.
2. Confirm `/api/scglamliff/health` returns 404 again.
3. Re-run target backend tests.
4. Leave old standalone Render service untouched.

No database restore is required because no database operation was executed.

## Remaining Risks

- Production needs `SCGLAMLIFF_*` env vars set on the shared Render service before using DB-backed routes.
- Frontend build variables still need to be updated separately to call `/api/scglamliff`.
- Existing source sessions will not carry over because the cookie name and JWT audience changed.
- A deployed CORS/cookie login test is still required after deployment.
- OCR/upload behavior remains intentionally excluded from v1.
