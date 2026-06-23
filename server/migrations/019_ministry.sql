-- Ministry reference table
CREATE TABLE IF NOT EXISTS ministry (
  pk_ministry UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  ministry_code VARCHAR(10) NOT NULL UNIQUE,
  ministry_name VARCHAR(255) NOT NULL,
  ministry_is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_ministry_set_updated_at
  BEFORE UPDATE ON ministry
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_ministry_code ON ministry (ministry_code);
