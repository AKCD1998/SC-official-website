# ReactNJob Backend Integration Report

Generated: 2026-05-09

## Manifest

```yaml
project_slug: "reactnjob"
source_repo: "C:\\Users\\scgro\\Desktop\\Webapp training project\\ReactNJobApplicWeb"
target_repo: "C:\\Users\\scgro\\Desktop\\Webapp training project\\currentSC-official-website-project"
namespace: "/api/reactnjob"
routes_old_to_new:
  - old: "/health"
    new: "/api/reactnjob/health"
  - old: "/api/line/webhook"
    new: "/api/reactnjob/line/webhook"
  - old: "/api/notify/line/job-application"
    new: "/api/reactnjob/notify/line/job-application"
  - old: "/api/line/notify"
    new: "/api/reactnjob/line/notify"
  - old: "/api/apply/cv"
    new: "/api/reactnjob/apply/cv"
  - old: "/api/submit-application"
    new: "/api/reactnjob/submit-application"
  - old: "/api/resume"
    new: "/api/reactnjob/resume"
env_required:
  - "REACTNJOB_SUBMIT_URL or SUBMIT_URL"
  - "REACTNJOB_QUICK_CV_SUBMIT_URL or QUICK_CV_SUBMIT_URL"
  - "REACTNJOB_SENDGRID_API_KEY"
  - "REACTNJOB_FROM_EMAIL or FROM_EMAIL or MAIL_USER"
  - "REACTNJOB_HR_EMAIL or HR_EMAIL or HR_TO_EMAIL or MAIL_TO"
  - "REACTNJOB_LINE_CHANNEL_SECRET or LINE_CHANNEL_SECRET"
  - "REACTNJOB_LINE_CHANNEL_ACCESS_TOKEN or LINE_CHANNEL_ACCESS_TOKEN"
  - "REACTNJOB_LINE_NOTIFY_MODE or LINE_NOTIFY_MODE"
  - "REACTNJOB_LINE_NOTIFY_USER_IDS or LINE_NOTIFY_USER_IDS"
  - "CORS_ORIGIN"
  - "VITE_API_BASE_URL"
  - "VITE_REACTNJOB_API_PREFIX"
services_touched:
  - id: "srv-d58idfm3jp1c73bhgv40"
    role: "target shared Render web service"
    mutated: false
  - id: "srv-d5r06lnfte5s73c12pt0"
    role: "old standalone ReactNJob Render web service"
    mutated: false
migrations_copied: []
migrations_executed: []
dependencies_added:
  - "multer@^2.1.1"
security_checks:
  - "generated docs scanned with targeted rg secret patterns"
  - ".env files are ignored, not git-tracked"
  - "LINE webhook raw-body preservation tested"
  - "no database migration or database write performed"
  - "Render services not mutated"
tests_run:
  - "source: npm --prefix backend test"
  - "target: npm --prefix backend test"
  - "source frontend: npm --prefix sc-pharm-form run build with shared API env"
rollback_steps:
  - "revert source frontend workflow/API config changes"
  - "remove target /api/reactnjob mount and module"
  - "remove target multer dependency if no other module needs it"
  - "keep old standalone Render service active until live frontend cutover is verified"
```

## Summary

The ReactNJob backend has been integrated into the target shared backend under:

```text
/api/reactnjob
```

The old standalone Render service was not changed, suspended, deleted, or redeployed. The target Render service was not changed through Render tooling. This report covers local code changes only.

## Files Changed

Source repo:

```text
BACKEND_STRUCTURE.md
BACKEND_TEST_BASELINE.md
backend/package.json
backend/tests/backend-smoke.test.cjs
.github/workflows/deploy.yml
sc-pharm-form/src/components/constants/options.jsx
```

Target repo:

```text
backend/package.json
backend/package-lock.json
backend/server.js
backend/src/modules/reactnjob/index.js
backend/tests/backend-integration.test.cjs
docs/migrations/reactnjob/20260509-integration-report.md
```

## Route Mapping

| Old standalone path | New shared path | Notes |
| --- | --- | --- |
| `/health` | `/api/reactnjob/health` | Namespaced health route |
| `/api/line/webhook` | `/api/reactnjob/line/webhook` | Requires raw request body for LINE signature verification |
| `/api/notify/line/job-application` | `/api/reactnjob/notify/line/job-application` | Sends LINE notification when token/user IDs are configured |
| `/api/line/notify` | `/api/reactnjob/line/notify` | CV notification route |
| `/api/apply/cv` | `/api/reactnjob/apply/cv` | PDF CV upload, 10 MB limit |
| `/api/submit-application` | `/api/reactnjob/submit-application` | Full application form and optional resume upload |
| `/api/resume` | `/api/reactnjob/resume` | JSON/base64 resume email path |

## Architecture Notes

The target backend is CommonJS and Express 5. ReactNJob source backend is also CommonJS and Express 5, so no ESM/CommonJS bridge was needed.

The target app now mounts ReactNJob before the target's global `express.json()`:

```text
app.use('/api', cors(...))
app.use('/api/reactnjob', reactNJobRoutes())
app.use(express.json())
```

Reason: the LINE webhook must capture the raw request body before JSON parsing. The ReactNJob module owns its own `express.json({ limit: "15mb", verify })` parser so signature verification is preserved without broadening JSON body limits for existing target routes.

## Environment Variables

No secret values were copied into code or docs.

Preferred project-scoped env vars:

```text
REACTNJOB_SUBMIT_URL
REACTNJOB_QUICK_CV_SUBMIT_URL
REACTNJOB_SENDGRID_API_KEY
REACTNJOB_FROM_EMAIL
REACTNJOB_HR_EMAIL
REACTNJOB_LINE_CHANNEL_SECRET
REACTNJOB_LINE_CHANNEL_ACCESS_TOKEN
REACTNJOB_LINE_NOTIFY_MODE
REACTNJOB_LINE_NOTIFY_USER_IDS
```

Compatibility fallbacks supported by the module:

```text
SUBMIT_URL
QUICK_CV_SUBMIT_URL
FROM_EMAIL
MAIL_USER
HR_EMAIL
HR_TO_EMAIL
MAIL_TO
LINE_CHANNEL_SECRET
LINE_CHANNEL_ACCESS_TOKEN
LINE_NOTIFY_MODE
LINE_NOTIFY_USER_IDS
```

Frontend build env:

```text
VITE_API_BASE_URL=https://sc-official-website.onrender.com
VITE_REACTNJOB_API_PREFIX=/api/reactnjob
VITE_ENABLE_LINE_NOTIFY=true
VITE_LINE_NOTIFY_ENDPOINT=/notify/line/job-application
VITE_LINE_CV_NOTIFY_ENDPOINT=/line/notify
```

Target CORS:

```text
CORS_ORIGIN
```

Production must include the GitHub Pages origin, for example `https://akcd1998.github.io`. Do not include the path `/ReactNJobApplicWeb` in the CORS origin.

## Database And Migrations

The ReactNJob source backend has no database layer and no migrations.

No migrations were copied.
No migrations were executed.
No database writes were performed.

The migrated module does not read `DATABASE_URL`.

## Frontend API Target

The source frontend now supports `VITE_REACTNJOB_API_PREFIX`.

The GitHub Pages workflow now builds with:

```text
VITE_API_BASE_URL=https://sc-official-website.onrender.com
VITE_REACTNJOB_API_PREFIX=/api/reactnjob
```

A workflow guard was added to fail the Pages build if the generated bundle still contains:

```text
reactnjobapplicweb.onrender.com
```

Local build verification:

```text
npm --prefix sc-pharm-form run build
```

Result:

- New local bundle contains `sc-official-website.onrender.com`.
- New local bundle contains `/api/reactnjob`.
- New local bundle does not contain `reactnjobapplicweb.onrender.com`.
- No `.map` files were generated in `sc-pharm-form/dist`.

## Render Service Mapping

Target shared service:

```text
srv-d58idfm3jp1c73bhgv40
```

Old standalone service:

```text
srv-d5r06lnfte5s73c12pt0
```

Render status:

- No Render CLI was available locally.
- No `render.yaml` exists in either repo.
- Dashboard settings were not mutated.
- Dashboard versus Blueprint diff is pending because there is no local Blueprint and no Render service read was performed.

Before any Render mutation, use the service ID confirmation gate and ask for the last 6 characters of the service ID.

## Dependency Changes

Added to target backend:

```text
multer@^2.1.1
```

Reason: ReactNJob handles PDF CV and resume uploads with `multer.memoryStorage()`.

Production audit:

```text
npm --prefix backend audit --omit=dev
```

Result:

```text
5 vulnerabilities: 1 low, 2 moderate, 2 high
```

High advisories reported for:

- `axios`
- `path-to-regexp`

The audit output did not report `multer`. These findings appear tied to existing target dependency tree risk rather than the new upload dependency, but they should be reviewed before production deployment. No `npm audit fix` was run because it could change unrelated behavior.

## Tests Added And Run

Source backend:

```text
npm --prefix backend test
```

Result:

```text
6 tests passed
```

Target backend:

```text
npm --prefix backend test
```

Result:

```text
20 tests passed
```

Coverage added:

- ReactNJob module imports safely.
- `/api/reactnjob/` and `/api/reactnjob/health` are mounted.
- Unknown ReactNJob routes return JSON 404.
- LINE webhook rejects unsigned requests when secret is configured.
- LINE notification routes fail safely without external tokens.
- CV upload validates missing and non-PDF files.
- Application route validates malformed payload JSON.
- Resume route validates missing attachment data.
- Existing target routes still pass.
- Existing Rx1011 tests still pass.

## Security Checklist

- Secrets were not hardcoded.
- Env docs list names only.
- `.env` files are ignored and not git-tracked.
- ReactNJob has no database and does not read `DATABASE_URL`.
- LINE webhook raw-body signature path is preserved and tested.
- File uploads remain memory-backed with 10 MB CV and 15 MB full resume limits.
- No real PII fixtures were added.
- Generated docs were checked with targeted secret patterns.
- Targeted scan found expected code/test placeholders and an existing hardcoded Google Apps Script endpoint in the source frontend. The endpoint was not changed in this migration and should be reviewed separately.
- CORS still depends on target `CORS_ORIGIN`; production should use an explicit allowlist.
- No Render services were mutated.
- No old service was suspended or deleted.

Remaining security risks:

- Source frontend still logs applicant PII to browser console in `logPayloadDiagnostics`.
- Source frontend contains a hardcoded Google Apps Script endpoint URL.
- ReactNJob public submission routes have no rate limiter in the shared backend.
- The target service allows all CORS origins if `CORS_ORIGIN` is empty.
- Production LINE webhook signature verification is skipped if `REACTNJOB_LINE_CHANNEL_SECRET` or `LINE_CHANNEL_SECRET` is missing.
- Target production dependency audit has high findings requiring review.

## Rollback Plan

Local rollback before deploy:

1. Revert source changes to `.github/workflows/deploy.yml` and `sc-pharm-form/src/components/constants/options.jsx`.
2. Remove source `backend/tests/backend-smoke.test.cjs` and the `test` script if desired.
3. Remove target `app.use('/api/reactnjob', reactNJobRoutes())`.
4. Remove `require("./src/modules/reactnjob")` from target `backend/server.js`.
5. Delete target `backend/src/modules/reactnjob`.
6. Remove `multer` from target `backend/package.json` and restore `backend/package-lock.json`.
7. Keep old Render service `srv-d5r06lnfte5s73c12pt0` active.

Post-deploy rollback:

1. Repoint GitHub Pages build env back to the old backend URL.
2. Redeploy the source frontend.
3. Confirm the live frontend bundle references the old backend again.
4. Disable or revert the target `/api/reactnjob` mount.
5. Keep both services running until user workflows are manually verified.

Rollback rehearsal:

- Not performed against a deployed preview environment.
- Local target tests passed after integration.

## Decommission Checklist

Do not suspend the old standalone Render service yet.

Before suspension:

1. Live GitHub Pages bundle no longer contains `reactnjobapplicweb.onrender.com`.
2. Live GitHub Pages bundle contains `sc-official-website.onrender.com`.
3. Live GitHub Pages bundle contains `/api/reactnjob`.
4. Target shared backend `/api/health` passes.
5. Target shared backend `/api/reactnjob/health` passes.
6. CORS preflight from `https://akcd1998.github.io` passes for `/api/reactnjob/*`.
7. A fresh form submission and CV upload are manually verified.
8. LINE notification and SendGrid delivery are verified with production env vars.
9. Old service data/log export requirements are explicitly waived or completed.
10. User confirms old service ID by the last 6 characters before any suspension.

Before deletion:

- Suspend for at least 7 days first.
- Confirm no support issues or meaningful traffic use the old service.
- Export required logs/data outside Render.
- Confirm no DNS/custom domains point at the old service.
- Require explicit same-session deletion confirmation with service ID.
