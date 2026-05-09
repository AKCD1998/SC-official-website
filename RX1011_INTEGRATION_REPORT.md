# Rx1011 Integration Report

Last updated: 2026-05-09

## Summary

Rx1011 backend runtime code has been integrated into `currentSC-official-website-project` as an isolated backend module mounted under:

```text
/api/rx1011
```

The existing currentSC website backend routes remain in place. No source repo files were deleted, no deployment was triggered, and no database migrations were run.

## Integration Structure

Target module path:

```text
backend/src/modules/rx1011/
  package.json
  index.js
  lazyRouter.cjs
  controllers/
  db/
  middleware/
  migrations/
  routes/
  utils/
  data/patients_rows.csv
```

Decision:

- The target backend is CommonJS.
- The Rx1011 backend is ESM.
- To avoid converting the large Rx1011 codebase, the module has its own `package.json` with `"type": "module"`.
- `backend/src/modules/rx1011/lazyRouter.cjs` bridges the CommonJS target server to the ESM Rx1011 router with dynamic `import()`.
- `backend/server.js` mounts the lazy router at `/api/rx1011`.

## Files Copied

Copied from `Rx1011/REACTjs-Project/server`:

- `controllers/*`
- `routes/*`
- `db/pool.js`
- `middleware/authMiddleware.js`
- `utils/*`

Copied from `Rx1011/REACTjs-Project`:

- `migrations/*`
- `patients_rows.csv` into `backend/src/modules/rx1011/data/patients_rows.csv`

## Files Added

- `backend/src/modules/rx1011/package.json`
- `backend/src/modules/rx1011/index.js`
- `backend/src/modules/rx1011/lazyRouter.cjs`
- `backend/src/modules/rx1011/data/patients_rows.csv`
- `backend/.env.example`
- `backend/jest.config.cjs`
- `backend/tests/backend-integration.test.cjs`
- `RX1011_INTEGRATION_REPORT.md`

## Files Changed

- `backend/server.js`
  - Requires `./src/modules/rx1011/lazyRouter.cjs`.
  - Mounts Rx1011 at `/api/rx1011`.

- `backend/package.json`
  - Adds `test` script.
  - Adds dependency `csv-parse`.
  - Adds dev dependencies `jest` and `supertest`.

- `backend/package-lock.json`
  - Updated by npm install.

- `README.md`
  - Documents Rx1011 module mount point and env variables.

- `backend/src/modules/rx1011/db/pool.js`
  - Uses `RX1011_DATABASE_URL` first, with `DATABASE_URL` as compatibility fallback.

- `backend/src/modules/rx1011/controllers/authController.js`
  - Uses `RX1011_JWT_SECRET` first, then `JWT_SECRET`, then `AUTH_JWT_SECRET`.

- `backend/src/modules/rx1011/middleware/authMiddleware.js`
  - Uses `RX1011_JWT_SECRET` first, then `JWT_SECRET`, then `AUTH_JWT_SECRET`.

## Route Mapping

All original Rx1011 backend routes are namespaced under `/api/rx1011`.

| Old route | New route |
|---|---|
| `GET /api/health` | `GET /api/rx1011/health` |
| `GET /api/patients` | `GET /api/rx1011/patients` |
| `POST /api/auth/login` | `POST /api/rx1011/auth/login` |
| `POST /api/auth/logout` | `POST /api/rx1011/auth/logout` |
| `GET /api/products` | `GET /api/rx1011/products` |
| `GET /api/products/generic-names` | `GET /api/rx1011/products/generic-names` |
| `GET /api/products/unit-types` | `GET /api/rx1011/products/unit-types` |
| `GET /api/products/report-groups` | `GET /api/rx1011/products/report-groups` |
| `GET /api/products/snapshot` | `GET /api/rx1011/products/snapshot` |
| `GET /api/products/version` | `GET /api/rx1011/products/version` |
| `GET /api/products/:id/unit-levels` | `GET /api/rx1011/products/:id/unit-levels` |
| `GET /api/products/:id/lot-whitelists` | `GET /api/rx1011/products/:id/lot-whitelists` |
| `POST /api/products` | `POST /api/rx1011/products` |
| `PUT /api/products/:id` | `PUT /api/rx1011/products/:id` |
| `PUT /api/products/:id/lots/:lotId/whitelist` | `PUT /api/rx1011/products/:id/lots/:lotId/whitelist` |
| `POST /api/products/:id/lots/normalize` | `POST /api/rx1011/products/:id/lots/normalize` |
| `PUT /api/products/:id/lots/:lotId/metadata` | `PUT /api/rx1011/products/:id/lots/:lotId/metadata` |
| `DELETE /api/products/:id` | `DELETE /api/rx1011/products/:id` |
| `GET /api/active-ingredients` | `GET /api/rx1011/active-ingredients` |
| `POST /api/inventory/receive` | `POST /api/rx1011/inventory/receive` |
| `POST /api/inventory/transfer` | `POST /api/rx1011/inventory/transfer` |
| `POST /api/inventory/movements` | `POST /api/rx1011/inventory/movements` |
| `POST /api/inventory/movements/batch` | `POST /api/rx1011/inventory/movements/batch` |
| `GET /api/inventory/transfer-requests` | `GET /api/rx1011/inventory/transfer-requests` |
| `POST /api/inventory/transfer-requests/:id/accept` | `POST /api/rx1011/inventory/transfer-requests/:id/accept` |
| `POST /api/inventory/transfer-requests/:id/reject` | `POST /api/rx1011/inventory/transfer-requests/:id/reject` |
| `PATCH /api/inventory/movements/:id/occurred-at-correction` | `PATCH /api/rx1011/inventory/movements/:id/occurred-at-correction` |
| `DELETE /api/inventory/movements/:id` | `DELETE /api/rx1011/inventory/movements/:id` |
| `GET /api/stock/on-hand` | `GET /api/rx1011/stock/on-hand` |
| `GET /api/stock/deliver-search-products` | `GET /api/rx1011/stock/deliver-search-products` |
| `GET /api/movements` | `GET /api/rx1011/movements` |
| `GET /api/locations` | `GET /api/rx1011/locations` |
| `GET /api/dispense/history` | `GET /api/rx1011/dispense/history` |
| `POST /api/dispense` | `POST /api/rx1011/dispense` |
| `GET /api/patients/:pid/dispense` | `GET /api/rx1011/patients/:pid/dispense` |
| `GET /api/reports/organic-dispense-ledger/activity-products` | `GET /api/rx1011/reports/organic-dispense-ledger/activity-products` |
| `GET /api/reports/organic-dispense-ledger` | `GET /api/rx1011/reports/organic-dispense-ledger` |
| `GET /api/incidents/:id` | `GET /api/rx1011/incidents/:id` |
| `GET /api/admin/patients` | `GET /api/rx1011/admin/patients` |
| `GET /api/admin/incidents` | `GET /api/rx1011/admin/incidents` |
| `GET /api/admin/incidents/:id` | `GET /api/rx1011/admin/incidents/:id` |
| `POST /api/admin/incidents` | `POST /api/rx1011/admin/incidents` |
| `PATCH /api/admin/incidents/:id` | `PATCH /api/rx1011/admin/incidents/:id` |
| `POST /api/admin/incidents/:id/resolution` | `POST /api/rx1011/admin/incidents/:id/resolution` |
| `PATCH /api/admin/incidents/:id/status` | `PATCH /api/rx1011/admin/incidents/:id/status` |
| `DELETE /api/admin/incidents/:id` | `DELETE /api/rx1011/admin/incidents/:id` |
| `GET /api/admin/db/schema` | `GET /api/rx1011/admin/db/schema` |
| `GET /api/admin/db/tables/:tableName/rows` | `GET /api/rx1011/admin/db/tables/:tableName/rows` |
| `POST /api/admin/sql/execute` | `POST /api/rx1011/admin/sql/execute` |

Existing currentSC routes remain unchanged, including:

- `GET /`
- `GET /health`
- `GET /api/health`
- `GET /api/auth/ping`
- `POST /api/contact`
- `POST /api/auth/*`

## Environment Variables Needed

Existing currentSC variables remain:

- `PORT`
- `CORS_ORIGIN`
- `DATABASE_URL`
- `JWT_SECRET`
- `OTP_SECRET`
- `OTP_TTL_MINUTES`
- `SENDGRID_API_KEY`
- `MAIL_USER`
- `MAIL_TO`
- `CLIENT_BUILD_DIR`

Rx1011 module variables:

- `RX1011_DATABASE_URL`
  - Preferred database URL for the Rx1011 module.
  - Falls back to `DATABASE_URL` for standalone compatibility.

- `RX1011_JWT_SECRET`
  - Preferred JWT secret for Rx1011 tokens.
  - Falls back to `JWT_SECRET` and `AUTH_JWT_SECRET`.

- `RX1011_PATIENTS_CSV_PATH`
  - Optional override for the patient CSV fallback.
  - Defaults to `backend/src/modules/rx1011/data/patients_rows.csv`.

- `ADMIN_SQL_EXECUTOR_MAX_SQL_LENGTH`
- `ADMIN_SQL_EXECUTOR_TIMEOUT_MS`
- `ADMIN_SQL_EXECUTOR_ROW_CAP`
- `ADMIN_TABLE_BROWSER_ROW_CAP`
  - Admin SQL/table browser guardrails used by the copied Rx1011 admin controller.

## Database Assumptions

- The target currentSC website database and the Rx1011 database may be different PostgreSQL databases.
- Shared deployments should set `RX1011_DATABASE_URL` so Rx1011 does not accidentally use the currentSC website `DATABASE_URL`.
- Rx1011 migrations were copied for manual review only.
- No migrations are run automatically by this integration.
- The copied Rx1011 migration directory still includes duplicate migration prefixes and a reference-only SQL file, so any future migration runner must use an explicit curated plan.

## Tests Added

Test file:

```text
backend/tests/backend-integration.test.cjs
```

Test command:

```bash
cd backend
npm test
```

Coverage:

- Rx1011 ESM module import smoke checks.
- Target backend starts as a real child process.
- Existing currentSC health and auth-ping routes still work.
- Existing target validation behavior for `/api/contact`, `/api/auth/login`, and `/api/auth/me` still works.
- Rx1011 routes are mounted under `/api/rx1011`.
- Rx1011 no-database baseline behavior is preserved:
  - `/api/rx1011/health` returns `503`.
  - `/api/rx1011/patients` uses CSV fallback.
  - Unknown Rx1011 routes return JSON `404`.
  - Auth-protected Rx1011 routes return unauthenticated `401`.
  - Public DB-backed Rx1011 routes return current no-database JSON `500`.

Verification run:

```text
npm test
Test Suites: 1 passed, 1 total
Tests: 15 passed, 15 total
```

Additional syntax check:

```text
Checked syntax: 30 backend JS/CJS files
```

## Risks

- Rx1011 was copied as an isolated module, not deeply refactored. Large controllers remain mostly as-is.
- The target backend uses Express 5 while the original Rx1011 backend used Express 4. Baseline smoke tests pass, but deeper route behavior still needs feature-level testing.
- Rx1011 and currentSC both originally used `DATABASE_URL` and `JWT_SECRET`; namespaced Rx1011 env vars were added to reduce shared-service collision risk.
- `GET /api/rx1011/patients` and `GET /api/rx1011/patients/:pid/dispense` preserve the original public behavior. Review auth policy before production exposure.
- The Rx1011 admin SQL executor remains a sensitive admin feature. Keep it behind strict auth and review before production use.
- The Rx1011 migration set is not automation-safe as-is because it has duplicate numeric prefixes and one reference-only SQL file.
- No live database schema was verified during this integration.
- No successful authenticated Rx1011 write flows were tested because that would require a safe isolated test database.

## Rollback Plan

To rollback this integration without touching existing currentSC features:

1. Remove the Rx1011 mount from `backend/server.js`:
   - `const rx1011Routes = require("./src/modules/rx1011/lazyRouter.cjs");`
   - `app.use('/api/rx1011', rx1011Routes);`
2. Remove `backend/src/modules/rx1011/`.
3. Remove `csv-parse` from `backend/package.json` if no other backend code uses it.
4. Remove or keep dev dependencies `jest` and `supertest` depending on whether the new tests should remain.
5. Remove `backend/tests/backend-integration.test.cjs` or update it to exclude Rx1011 assertions.
6. Remove Rx1011 env entries from `backend/.env.example` and README if desired.
7. Run:
   ```bash
   cd backend
   npm install
   npm test
   ```
8. Confirm existing currentSC routes:
   - `GET /`
   - `GET /health`
   - `GET /api/health`
   - `GET /api/auth/ping`
   - `POST /api/contact`
