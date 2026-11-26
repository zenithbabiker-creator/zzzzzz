-- AgriTrack Phase 3 Initial PostgreSQL Schema & Indexes
-- Version: 001

CREATE TABLE IF NOT EXISTS employees (
    id BIGSERIAL PRIMARY KEY,
    employee_code VARCHAR(64) NOT NULL UNIQUE,
    employee_number VARCHAR(64) NOT NULL UNIQUE,
    full_name_en TEXT NOT NULL,
    full_name_ar TEXT NOT NULL,
    passcode_scrypt_hash TEXT NOT NULL,
    pwa_digest_scrypt_hash TEXT NOT NULL,
    android_digest_scrypt_hash TEXT NOT NULL,
    account_status VARCHAR(16) NOT NULL DEFAULT 'active'
        CHECK (account_status IN ('active', 'inactive')),
    assigned_device_id VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS devices (
    id BIGSERIAL PRIMARY KEY,
    device_identifier VARCHAR(64) NOT NULL UNIQUE,
    employee_code VARCHAR(64) REFERENCES employees(employee_code) ON DELETE SET NULL,
    registration_status VARCHAR(24) NOT NULL DEFAULT 'active'
        CHECK (registration_status IN ('active', 'suspended', 'retired')),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tracking_sessions (
    id BIGSERIAL PRIMARY KEY,
    session_uuid VARCHAR(128) NOT NULL UNIQUE,
    employee_code VARCHAR(64) NOT NULL REFERENCES employees(employee_code) ON DELETE RESTRICT,
    device_identifier VARCHAR(64) NOT NULL REFERENCES devices(device_identifier) ON DELETE RESTRICT,
    session_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    session_end TIMESTAMPTZ,
    session_status VARCHAR(24) NOT NULL DEFAULT 'active'
        CHECK (session_status IN ('active', 'completed', 'interrupted')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gps_records (
    id BIGSERIAL PRIMARY KEY,
    record_uuid VARCHAR(128) NOT NULL UNIQUE,
    employee_code VARCHAR(64) NOT NULL REFERENCES employees(employee_code) ON DELETE RESTRICT,
    device_identifier VARCHAR(64) NOT NULL REFERENCES devices(device_identifier) ON DELETE RESTRICT,
    session_uuid VARCHAR(128) NOT NULL REFERENCES tracking_sessions(session_uuid) ON DELETE RESTRICT,
    latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    accuracy_meters REAL NOT NULL CHECK (accuracy_meters >= 0),
    provider VARCHAR(32) NOT NULL,
    battery_percent SMALLINT CHECK (battery_percent IS NULL OR (battery_percent BETWEEN 0 AND 100)),
    captured_at TIMESTAMPTZ NOT NULL,
    captured_at_epoch_ms BIGINT NOT NULL,
    captured_date DATE NOT NULL,
    captured_hour SMALLINT NOT NULL CHECK (captured_hour BETWEEN 0 AND 23),
    captured_minute SMALLINT NOT NULL CHECK (captured_minute BETWEEN 0 AND 59),
    captured_second SMALLINT NOT NULL CHECK (captured_second BETWEEN 0 AND 59),
    server_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    batch_id VARCHAR(128) NOT NULL,
    sync_status VARCHAR(24) NOT NULL DEFAULT 'SYNCED'
        CHECK (sync_status IN ('SYNCED', 'PENDING', 'FAILED'))
);

CREATE TABLE IF NOT EXISTS sync_batches (
    id BIGSERIAL PRIMARY KEY,
    batch_id VARCHAR(128) NOT NULL,
    employee_code VARCHAR(64) NOT NULL REFERENCES employees(employee_code) ON DELETE RESTRICT,
    device_identifier VARCHAR(64) NOT NULL,
    accepted_count INTEGER NOT NULL CHECK (accepted_count >= 0),
    duplicate_count INTEGER NOT NULL CHECK (duplicate_count >= 0),
    server_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_credentials (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    passcode_scrypt_hash TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gps_records_employee_captured
    ON gps_records (employee_code, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_gps_records_employee_date
    ON gps_records (employee_code, captured_date DESC, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_gps_records_session
    ON gps_records (session_uuid, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_gps_records_device
    ON gps_records (device_identifier, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_tracking_sessions_employee_start
    ON tracking_sessions (employee_code, session_start DESC);

CREATE INDEX IF NOT EXISTS idx_devices_employee
    ON devices (employee_code);

CREATE INDEX IF NOT EXISTS idx_sync_batches_employee_time
    ON sync_batches (employee_code, server_received_at DESC);
