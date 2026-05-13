---
name: scope-currentsc-work
description: Use this skill when working in currentSC-official-website-project, touching backend behavior, any /api/* route, or files under backend/src/modules/, especially rx1011, digitalpjk, scglamliff, or reactnjob in the shared host repo. Do NOT use when working only in the standalone sibling repos, doing migration parity audits, or handling unrelated frontend-only or CI/infra tasks.
---

- Treat `currentSC-official-website-project` as the host repo and the source of truth for live runtime behavior.
- Read `docs/backend-architecture.md` before making any backend change in `currentSC-official-website-project`.
- Use `RX1011_INTEGRATION_REPORT.md` only for module integration context, route remapping, and copied-module boundaries.
- Change the code in the host repo that actually runs. Do not assume the original source repo still defines production behavior.

- For `/api/rx1011` work, inspect `backend/src/modules/rx1011/*` inside `currentSC-official-website-project` first.
- For `/api/digitalpjk` work, inspect `backend/src/modules/digitalpjk/*` inside `currentSC-official-website-project` first.
- For `/api/scglamliff` work, inspect `backend/src/modules/scglamliff/*` inside `currentSC-official-website-project` first.
- For `/api/reactnjob` work, inspect `backend/src/modules/reactnjob/*` inside `currentSC-official-website-project` first.
- For any module mounted under `backend/src/modules/`, trace the mount from `backend/server.js` into the in-repo module before looking anywhere else.
- Read only the files needed for the task. Use the architecture docs as the map, then open the narrowest relevant code path.
- Trust current host-repo code over copied documentation when they differ.

- Do NOT start in `..\Rx1011`, `..\digitalPJKform`, `..\scGlamLiff-reception`, or `..\ReactNJobApplicWeb` for routine fixes, endpoint changes, bug investigation, or refactors inside currentSC.
- Do NOT treat the standalone sibling repos as the live runtime for requests handled by `currentSC-official-website-project`.
- Do NOT widen scope from one broken route or module into the whole shared backend unless the task requires it.
- Do NOT re-read broad unrelated backend areas once the responsible route, controller, middleware, or module has been identified.

- Cross-repo lookup into `..\Rx1011`, `..\digitalPJKform`, `..\scGlamLiff-reception`, or `..\ReactNJobApplicWeb` is allowed only for:
- migration comparison
- parity checking against the original implementation
- missing-history lookup when the copied module in currentSC is unclear

- If you use a sibling repo, pull only the minimum context needed to answer the narrow question.
- If currentSC code and sibling-repo docs disagree, follow currentSC code.
- If currentSC code and standalone sibling-repo code disagree, follow currentSC code unless the task is explicitly a parity or migration task.
- Prefer paths referenced by `docs/backend-architecture.md` over exploratory repo-wide reading.

- For host-backend changes, check:
- route mount location
- local middleware on that path
- database/env assumptions used by that module
- tests closest to the changed behavior

- Keep the task framed around the active repo. Historical repos are reference material, not the execution target.

## When this skill does NOT apply

- Frontend-only work that does not affect backend behavior or `/api/*` integration.
- Infra, deployment, CI, or workspace-wide automation changes with no backend routing/module impact.
- Pure standalone sibling-repo work where `currentSC-official-website-project` is not the execution target.
- Explicit migration parity audits whose main purpose is comparing currentSC against the original sibling source repos.
