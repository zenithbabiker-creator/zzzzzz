# Product 2: AgriTrack Central Backend (PostgreSQL Phase 3)

Independent Node.js + Express + TypeScript + PostgreSQL 15 backend API service.

## Responsibilities
- Employee and administrator authentication (`scrypt` + HMAC-SHA256 Bearer tokens) and RBAC isolation.
- Employee and device registration (`employees`, `devices` tables).
- Explicit work-session lifecycle tracking (`tracking_sessions`).
- Transactional, UUID-idempotent GPS batch ingestion (`POST /api/sync/batch`) preserving original device capture timestamps alongside `server_received_at`.
- Indexed, paginated, date-filtered historical GPS retrieval (`GET /api/sync/records/:employeeId`, `GET /api/admin/records`).

## Strict Architectural Boundaries
- Contains **no** Vite middleware, **no** React dependencies, and **no** static frontend or dashboard UI.
- Communicates exclusively over JSON HTTP REST APIs with Product 1 (`employee-android/`) and Product 3 (`admin-dashboard/`).

## Docker Compose Startup & Shutdown (Local PostgreSQL)
```bash
cd central-backend
cp .env.example .env
# Edit .env and set POSTGRES_PASSWORD, SESSION_SECRET, and ADMIN_PASSCODE

# Start PostgreSQL 15 (or both PostgreSQL + central-backend)
docker compose up -d postgres
# Or full stack:
docker compose up -d --build

# Check health & logs
docker compose ps
docker compose logs -f central-backend

# Stop containers (preserves agritrack_pgdata volume)
docker compose down
```

## Database Migrations & JSON Import
```bash
cd central-backend

# Apply SQL migrations and idempotent initial 50-employee seed
npm run migrate

# Import legacy Phase 2 JSON backup safely (creates .bak-<timestamp> and preserves backup)
npm run migrate:json -- --source ../.data/phase2_sync_store.json
```

## Database Backup & Restoration
### Docker Compose PostgreSQL
```bash
# Create compressed custom-format backup inside ./backups/
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > backups/agritrack_$(date +%Y%m%d_%H%M%S).dump

# Restore into a running database
cat backups/agritrack_YYYYMMDD_HHMMSS.dump | docker compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner
```

### Plain SQL Backup / Restore (Host `pg_dump` / `psql`)
```bash
pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" --clean --if-exists > agritrack_backup.sql
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -f agritrack_backup.sql
```

## Access Controls, Privacy & Retention Policy
- **Employee Isolation**: Every `/api/sync/*` and `/api/sessions/*` route binds queries strictly to the authenticated employee ID from the verified Bearer token; cross-employee reads or writes return HTTP `403`.
- **Admin Role Separation**: Administrative endpoints (`/api/admin/*`) require an `admin` role token; employee tokens receive HTTP `403`.
- **Session-Bounded Tracking**: Location records link via foreign key to `tracking_sessions` started explicitly by the employee during work shifts.
- **Retention**: Configure `GPS_RETENTION_DAYS` (default `365`) for scheduled archival/purging of historical `gps_records` older than the organization's retention policy window.
