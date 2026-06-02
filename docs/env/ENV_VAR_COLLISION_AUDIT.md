# Env Var Collision Audit

Values are intentionally omitted. This report lists env names only.

## Tooling Availability

- `dotenv-linter`: not found
- `gitleaks`: not found
- `trufflehog`: not found

## Repos Scanned

| Repo | Prefix | Path |
|---|---|---|
| `PaaSRTSM-project` | `PAASRTSM` | `C:\Users\scgro\Desktop\Webapp training project\PaaSRTSM-project` |
| `currentSC-official-website-project` | `CURRENTSC` | `C:\Users\scgro\Desktop\Webapp training project\currentSC-official-website-project` |

## Tracked Env Files

- None detected.

## Tracked Env Templates

- `PaaSRTSM-project` tracks template `apps/admin-api/.env.example`
- `PaaSRTSM-project` tracks template `apps/admin-web/.env.example`
- `currentSC-official-website-project` tracks template `backend/.env.example`

## Duplicate Keys Inside Env Files

- None detected.

## Duplicate Names Across Repos

| Severity | Name | Repos | Reason |
|---|---|---|---|
| P1 | `AUTH_JWT_SECRET` | `PaaSRTSM-project`, `currentSC-official-website-project` | Sensitive backend env name is duplicated and not project-scoped |
| P0 | `DATABASE_URL` | `PaaSRTSM-project`, `currentSC-official-website-project` | Known dangerous backend secret/config name duplicated across repos |
| P2 | `NODE_ENV` | `PaaSRTSM-project`, `currentSC-official-website-project` | Common runtime config duplicated; verify shared-service behavior |
| P2 | `PORT` | `PaaSRTSM-project`, `currentSC-official-website-project` | Common runtime config duplicated; verify shared-service behavior |

## Sample Occurrences

### `AUTH_JWT_SECRET`

- `PaaSRTSM-project` `apps/admin-api/.env:11` (env-file)
- `PaaSRTSM-project` `apps/admin-api/.env.example:11` (env-file)
- `currentSC-official-website-project` `.claude/worktrees/awesome-pare-ca96e3/backend/src/modules/rx1011/controllers/authController.js:9` (process.env)
- `currentSC-official-website-project` `.claude/worktrees/awesome-pare-ca96e3/backend/src/modules/rx1011/middleware/authMiddleware.js:7` (process.env)

### `DATABASE_URL`

- `PaaSRTSM-project` `apps/admin-api/.env:7` (env-file)
- `PaaSRTSM-project` `apps/admin-api/.env.example:7` (env-file)
- `currentSC-official-website-project` `.claude/worktrees/awesome-pare-ca96e3/backend/.env.example:3` (env-file)
- `currentSC-official-website-project` `.claude/worktrees/awesome-pare-ca96e3/backend/db.js:4` (process.env)

### `NODE_ENV`

- `PaaSRTSM-project` `apps/admin-api/.env:2` (env-file)
- `PaaSRTSM-project` `apps/admin-api/.env.example:2` (env-file)
- `currentSC-official-website-project` `.claude/worktrees/awesome-pare-ca96e3/backend/db.js:5` (process.env)
- `currentSC-official-website-project` `.claude/worktrees/awesome-pare-ca96e3/backend/server.js:122` (process.env)

### `PORT`

- `PaaSRTSM-project` `apps/admin-api/.env:3` (env-file)
- `PaaSRTSM-project` `apps/admin-api/.env.example:3` (env-file)
- `currentSC-official-website-project` `.claude/worktrees/awesome-pare-ca96e3/backend/.env.example:1` (env-file)
- `currentSC-official-website-project` `.claude/worktrees/awesome-pare-ca96e3/backend/server.js:33` (process.env)

## Recommended Follow-Up

- Rename P0/P1 backend secrets to project-scoped names before sharing one runtime.
- For one frontend app calling multiple modules, replace generic API prefix vars with `VITE_<PROJECT>_API_PREFIX`.
- Run `dotenv-linter` on `.env*` files when available.
- Run `gitleaks` or `trufflehog` before committing or deploying.
- Update code, workflows, env examples, deployment docs, and Render/GitHub variables together.
