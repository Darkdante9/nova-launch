# CI/CD Guide

This guide covers the local development hooks and CI pipeline for Nova Launch.

## Pre-Commit Hooks

Pre-commit hooks run fast, targeted checks on staged files before each commit to catch issues early.

### Setup

```bash
git config core.hooksPath .githooks
```

That's it. The hook runs automatically on every `git commit`.

### What the Hook Checks

Checks are scoped to staged files only, so they stay fast.

| Check | Trigger | Fix |
|-------|---------|-----|
| Conventional commit message | Always | See format below |
| Secret detection | Any staged file | Remove secrets; use env vars |
| Rust formatting | Staged `.rs` files | `cd contracts/token-factory && cargo fmt` |
| Frontend lint | Staged `frontend/**/*.{ts,tsx,js,jsx}` | `cd frontend && npm run lint -- --fix` |
| Frontend type-check | Staged `frontend/**/*.{ts,tsx,js,jsx}` | `cd frontend && npm run type-check` |
| Backend formatting (Prettier) | Staged `backend/**/*.{ts,js,json}` | `cd backend && npm run format` |
| Backend type-check | Staged `backend/**/*.{ts,tsx,js,jsx}` | `cd backend && npm run type-check` |

### Commit Message Format

Follows [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>
```

**Types:** `feat` | `fix` | `docs` | `style` | `refactor` | `test` | `chore` | `perf` | `ci` | `build` | `revert` | `infra`

**Examples:**
```
feat(frontend): add token burn UI
fix(contracts): handle zero-amount burn edge case
infra(git): add pre-commit hooks for code quality enforcement
docs: update deployment guide
```

### Bypassing Hooks

Only bypass when absolutely necessary (e.g., WIP commits to a personal branch):

```bash
git commit --no-verify
```

## Local CI Validation

Before pushing, run the full CI suite locally:

```bash
./scripts/ci-check.sh
```

This mirrors what runs in GitHub Actions and covers:
- Rust fmt, clippy, tests, WASM build
- Frontend lint, type-check, tests, build
- Backend migration compatibility tests
- Spec file validation
- Contract ABI completeness

## GitHub Actions Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `backend-ci.yml` | Push / PR | Backend lint, type-check, tests |
| `comprehensive-tests.yml` | Push / PR | Full test suite |
| `security-tests.yml` | Push / PR | Security audit |
| `coverage-gates.yml` | Push / PR | Enforce >80% coverage |
| `property-tests.yml` | Push / PR | Property-based contract tests |
| `performance.yml` | Push / PR | Lighthouse + bundle budgets |
| `fuzz-testing.yml` | Schedule | Stateful contract fuzzing |
| `production-readiness-gate.yml` | Manual | Pre-release gate |

## Running Checks Manually

```bash
# Rust
cd contracts/token-factory
cargo fmt --check
cargo clippy --lib -- -D warnings
cargo test --lib

# Frontend
cd frontend
npm run lint
npm run type-check
npm test -- --run

# Backend
cd backend
npm run format:check
npm run type-check
npm test -- --run
```

## CI Secrets Reference

The following secrets must be configured in GitHub Actions (Settings → Secrets and variables → Actions) before the relevant workflows will pass.

### Existing secrets

| Secret | Used by | Notes |
|--------|---------|-------|
| `DATABASE_URL` | Backend CI, integration tests | PostgreSQL connection string |
| `JWT_SECRET` | Backend CI | Auth token signing |
| `REDIS_URL` | Backend CI | Rate limiter |

### Email notification secrets (issue #1264)

| Secret | Required | Description |
|--------|----------|-------------|
| `SENDGRID_API_KEY` | Yes (if using SendGrid) | SendGrid v3 API key — starts with `SG.` |
| `NOTIFICATION_FROM_EMAIL` | Yes (if using SendGrid) | Verified sender address, e.g. `noreply@nova-launch.app` |
| `NOTIFICATION_EMAIL_API_URL` | Legacy fallback only | Generic HTTP email endpoint (used when `SENDGRID_API_KEY` is absent) |
| `NOTIFICATION_EMAIL_API_KEY` | Optional | Bearer token for legacy HTTP email endpoint |

### SMS notification secrets (issue #1264)

| Secret | Required | Description |
|--------|----------|-------------|
| `TWILIO_ACCOUNT_SID` | Yes (if using Twilio) | Twilio account SID — starts with `AC` |
| `TWILIO_AUTH_TOKEN` | Yes (if using Twilio) | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | Yes (if using Twilio) | Verified Twilio sender number in E.164 format, e.g. `+15550001234` |
| `NOTIFICATION_SMS_API_URL` | Legacy fallback only | Generic HTTP SMS endpoint (used when Twilio creds are absent) |
| `NOTIFICATION_SMS_API_KEY` | Optional | Bearer token for legacy HTTP SMS endpoint |

### Delivery tuning (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_RETRIES` | `3` | Max delivery attempts per notification (includes initial try) |
| `NOTIFICATION_RATE_LIMIT_WINDOW_MS` | `3600000` | Rate-limit window in ms (1 hour) — one notification per recipient per event per window |

> **PII policy:** Never log a full email address or phone number. The service masks all recipient identifiers before writing to logs (email → `****@domain.com`, phone → `****NNNN`). Do not weaken this in test fixtures or log assertions.
