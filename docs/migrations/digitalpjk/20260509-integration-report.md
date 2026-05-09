# DigitalPJK Integration Report

Date: 2026-05-09

## Machine-Readable Manifest

```yaml
project_slug: digitalpjk
source_repo: "C:\\Users\\scgro\\Desktop\\Webapp training project\\digitalPJKform"
target_repo: "C:\\Users\\scgro\\Desktop\\Webapp training project\\currentSC-official-website-project"
namespace: "/api/digitalpjk"
target_render_service_id: "srv-d58idfm3jp1c73bhgv40"
old_render_service_id: "srv-d6ft1ncr85hc73b2k6qg"
render_mutations_performed: false
database_migrations_executed: false
migrations_status: copied-not-executed
frontend_legacy_api_var_used: false
tests:
  source_backend: passed
  target_backend: passed
  source_frontend_build: passed
audit:
  npm_audit_omit_dev:
    high: 0
    critical: 0
    remaining: "1 moderate nodemailer advisory requiring major upgrade"
```

## Summary

DigitalPJK backend modules were copied into the shared backend under:

```text
backend/src/modules/digitalpjk
```

They are mounted under:

```text
/api/digitalpjk
```

No Render services were changed, restarted, deployed, suspended, or deleted. No database migrations were run.

## Files Changed

Target shared backend:

```text
backend/server.js
backend/.env.example
backend/package.json
backend/package-lock.json
backend/tests/backend-integration.test.cjs
backend/src/modules/digitalpjk/**
docs/migrations/digitalpjk/20260509-integration-report.md
```

Source repo:

```text
.gitignore
backend/.env.example
backend/package.json
backend/src/**
backend/tests/backend-smoke.test.js
frontend/src/api/client.js
frontend/src/api/health.js
frontend/src/components/HealthStatus.jsx
render.yaml
BACKEND_STRUCTURE.md
BACKEND_TEST_BASELINE.md
ENV_VAR_COLLISION_AUDIT.md
```

## Route Mapping

| Old Source Route | New Shared Route |
|---|---|
| `GET /api/health` | `GET /api/digitalpjk/health` |
| `POST /api/auth/login` | `POST /api/digitalpjk/auth/login` |
| `GET /api/auth/me` | `GET /api/digitalpjk/auth/me` |
| `GET /api/me` | `GET /api/digitalpjk/me` |
| `GET /api/branches` | `GET /api/digitalpjk/branches` |
| `GET /api/branches/:id` | `GET /api/digitalpjk/branches/:id` |
| `GET /api/admin/settings` | `GET /api/digitalpjk/admin/settings` |
| `PUT /api/admin/settings` | `PUT /api/digitalpjk/admin/settings` |
| `POST /api/documents/generate` | `POST /api/digitalpjk/documents/generate` |
| `POST /api/documents/generate-merged` | `POST /api/digitalpjk/documents/generate-merged` |
| `GET /api/documents/debug-grid` | `GET /api/digitalpjk/documents/debug-grid` |
| `GET /api/documents/recent` | `GET /api/digitalpjk/documents/recent` |
| `GET /api/documents/:id` | `GET /api/digitalpjk/documents/:id` |
| `GET /api/pharmacists/part-time` | `GET /api/digitalpjk/pharmacists/part-time` |

## Env Variables

Required backend names for the shared service:

```text
DIGITALPJK_DATABASE_URL
DIGITALPJK_JWT_SECRET
DIGITALPJK_JWT_EXPIRES_IN
DIGITALPJK_CEO_NAME_TH
DIGITALPJK_LOGIN_RATE_LIMIT_WINDOW_MS
DIGITALPJK_LOGIN_RATE_LIMIT_MAX
DIGITALPJK_PDF_WRITE_SAMPLE
DIGITALPJK_PDF_SAMPLE_DIR
```

Required frontend build names for DigitalPJK:

```text
VITE_DIGITALPJK_API_BASE_URL
VITE_DIGITALPJK_API_PREFIX
```

DigitalPJK backend code does not read the shared `DATABASE_URL` or `JWT_SECRET`. DigitalPJK frontend code does not read `VITE_API_BASE_URL`.

## Database Assumptions

- DigitalPJK expects its own PostgreSQL schema/database reachable through `DIGITALPJK_DATABASE_URL`.
- The module fails closed when `DIGITALPJK_DATABASE_URL` is absent.
- Migration files were copied with the module but not executed.
- Any migration execution still requires a fresh backup/snapshot, exact DB confirmation, SQL review, and explicit approval.

Copied migrations:

```text
001_init_schema.sql
002_documents_table.sql
003_part_time_pharmacists.sql
004_users_branch_role_constraint.sql
```

## Auth And Session Assumptions

- DigitalPJK uses Bearer JWT auth.
- DigitalPJK signs/verifies with `DIGITALPJK_JWT_SECRET`.
- Tokens include `issuer=digitalpjk` and `audience=digitalpjk`.
- Old standalone tokens will not validate after cutover; users should log in again.
- No cookie auth or CSRF middleware was found in the source.

## Dependency Merge

Added target dependencies:

```text
pdf-lib
@pdf-lib/fontkit
```

License check:

```text
pdf-lib: MIT
@pdf-lib/fontkit: MIT
```

Audit:

```text
npm --prefix backend audit --omit=dev
```

After non-forced `npm audit fix --omit=dev`, high/critical production advisories are cleared. One moderate `nodemailer` advisory remains because npm requires a major upgrade to fix it.

## Tests Added Or Updated

Source:

```text
npm --prefix backend test
```

Result: 5 tests passed.

Target:

```text
npm --prefix backend test
```

Result: 32 tests passed.

Frontend:

```text
VITE_DIGITALPJK_API_BASE_URL=<shared-backend-origin>
VITE_DIGITALPJK_API_PREFIX=/api/digitalpjk
npm --prefix frontend run build
```

Result: build passed. Bundle check confirmed the old standalone DigitalPJK backend URL and `VITE_API_BASE_URL` are absent.

## Render Service Mapping

Target shared Render service:

```text
srv-d58idfm3jp1c73bhgv40
```

Old standalone Render service:

```text
srv-d6ft1ncr85hc73b2k6qg
```

No Render mutation was performed. Before any Render mutation, show the service confirmation block and require the user to confirm the last 6 characters of the target service ID.

## Risks

- Migrations are not executed; live DB behavior is not verified.
- Target CORS allowlist still needs deployed-origin verification.
- The old DigitalPJK local untracked `.env` files may still contain legacy generic names and should be manually updated or rotated outside git.
- One moderate Nodemailer advisory remains in the target backend and requires a major-version upgrade decision.
- Source and target have different module systems and Express majors; the bridge is covered by smoke tests but should be watched during first deploy.

## Rollback Plan

Local rollback:

1. Revert the target commit or branch changes that add `backend/src/modules/digitalpjk`, the server mount, env docs, package changes, and tests.
2. Revert the source frontend API-variable changes if the frontend has not cut over.
3. Keep the old standalone Render service running until the new route is verified.

Deployment rollback:

1. Restore the frontend build env to the old standalone backend only if the old service remains healthy.
2. Remove or ignore DigitalPJK env vars in the shared service.
3. Do not run rollback SQL unless a DB operation was previously approved and executed.

Rollback rehearsal status: not performed because no deployment was performed.

## Decommission Checklist

Do not suspend or delete the old service yet. Before suspension:

- Live DigitalPJK frontend bundle contains the shared backend origin and `/api/digitalpjk`.
- Live DigitalPJK frontend bundle does not contain the old standalone backend URL.
- Shared backend `/api/digitalpjk/health` passes in production.
- Auth flow is tested with a fresh login.
- CORS preflight from the deployed frontend origin passes.
- DigitalPJK database backup/export is recorded.
- Old service logs are exported if needed.
- Render service ID confirmation gate passes.

Before deletion:

- Old service has been suspended for at least 7 days.
- There is no meaningful inbound traffic or support issue referencing it.
- DNS/CNAME references are removed or moved.
- External DB/log backups are stored outside Render.
- User confirms deletion in the same session using the service ID gate.
