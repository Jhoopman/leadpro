-- ─────────────────────────────────────────────────────────
-- LeadPro — Supabase database setup
-- Run this in: Supabase Dashboard → SQL Editor → New query
-- ─────────────────────────────────────────────────────────

-- 1. CONTRACTORS (extends Supabase auth.users)
CREATE TABLE IF NOT EXISTS contractors (
  id            uuid REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  business_name text    NOT NULL DEFAULT '',
  phone         text             DEFAULT '',
  services      text             DEFAULT 'Landscaping, Lawn care, Pest control, Tree trimming',
  widget_id     text    UNIQUE   NOT NULL DEFAULT 'lp_' || substr(md5(random()::text || now()::text), 1, 8),
  created_at    timestamptz      DEFAULT now()
);

ALTER TABLE contractors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "contractors_select_own" ON contractors
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "contractors_insert_own" ON contractors
  FOR INSERT WITH CHECK (auth.uid() = id);

CREATE POLICY "contractors_update_own" ON contractors
  FOR UPDATE USING (auth.uid() = id);


-- 2. LEADS
CREATE TABLE IF NOT EXISTS leads (
  id            uuid         DEFAULT gen_random_uuid() PRIMARY KEY,
  contractor_id uuid         REFERENCES contractors(id) ON DELETE CASCADE NOT NULL,
  name          text         NOT NULL DEFAULT '',
  phone         text                  DEFAULT '',
  address       text                  DEFAULT '',
  service       text                  DEFAULT '',
  notes         text                  DEFAULT '',
  status        text                  DEFAULT 'new'
                             CHECK (status IN ('new','scheduled','followup','done')),
  requested_at  timestamptz           DEFAULT now()
);

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

-- Contractors see only their own leads
CREATE POLICY "leads_all_own" ON leads
  FOR ALL USING (contractor_id = auth.uid());

-- Service role key (used by the server) bypasses RLS automatically — no extra policy needed.


-- 3. APPOINTMENTS
CREATE TABLE IF NOT EXISTS appointments (
  id            uuid         DEFAULT gen_random_uuid() PRIMARY KEY,
  contractor_id uuid         REFERENCES contractors(id) ON DELETE CASCADE NOT NULL,
  name          text         NOT NULL DEFAULT '',
  phone         text                  DEFAULT '',
  address       text                  DEFAULT '',
  service       text                  DEFAULT '',
  date          text         NOT NULL,
  time          text                  DEFAULT '09:00',
  notes         text                  DEFAULT '',
  created_at    timestamptz           DEFAULT now()
);

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "appointments_all_own" ON appointments
  FOR ALL USING (contractor_id = auth.uid());


-- ─────────────────────────────────────────────────────────
-- After running this SQL, copy the following values from
-- Supabase Dashboard → Settings → API and add them to your
-- Render.com environment variables:
--
--   SUPABASE_URL         = https://xxxx.supabase.co
--   SUPABASE_ANON_KEY    = eyJ... (anon / public key)
--   SUPABASE_SERVICE_KEY = eyJ... (service_role / secret key)
--   ANTHROPIC_API_KEY    = sk-ant-...
-- ─────────────────────────────────────────────────────────
