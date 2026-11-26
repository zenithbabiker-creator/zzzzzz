-- AgriTrack Phase 3.5 Security, Refresh Tokens & Administrative Audit Logs
-- Version: 002

CREATE TABLE IF NOT EXISTS device_refresh_tokens (
    id BIGSERIAL PRIMARY KEY,
    token_hash_sha256 VARCHAR(64) NOT NULL UNIQUE,
    employee_code VARCHAR(64) NOT NULL REFERENCES employees(employee_code) ON DELETE CASCADE,
    device_identifier VARCHAR(64) NOT NULL REFERENCES devices(device_identifier) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_employee_device
    ON device_refresh_tokens (employee_code, device_identifier, revoked_at);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires
    ON device_refresh_tokens (expires_at);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id BIGSERIAL PRIMARY KEY,
    actor_subject VARCHAR(64) NOT NULL,
    action VARCHAR(64) NOT NULL,
    target_employee_code VARCHAR(64),
    details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created
    ON admin_audit_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_target
    ON admin_audit_logs (target_employee_code, created_at DESC);
