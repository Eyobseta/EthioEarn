CREATE TABLE admin_users(
  user_id uuid PRIMARY KEY REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('SUPPORT','FINANCE','SUPER')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit_logs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users(id),
  action text NOT NULL, entity_type text NOT NULL, entity_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END $$;
CREATE TRIGGER audit_no_change BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_append_only();
CREATE INDEX audit_entity ON audit_logs(entity_type, entity_id);
