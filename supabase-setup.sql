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


-- 4. CALLS (AI voice calls via Vapi)
CREATE TABLE IF NOT EXISTS calls (
  id               uuid         DEFAULT gen_random_uuid() PRIMARY KEY,
  contractor_id    uuid         REFERENCES contractors(id) ON DELETE CASCADE NOT NULL,
  caller_phone     text                  DEFAULT '',
  started_at       timestamptz           DEFAULT now(),
  duration_seconds integer               DEFAULT 0,
  status           text                  DEFAULT 'answered'
                               CHECK (status IN ('answered','missed','lead_captured')),
  transcript       text                  DEFAULT '',
  lead_data        jsonb                 DEFAULT NULL
);

ALTER TABLE calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "calls_all_own" ON calls
  FOR ALL USING (contractor_id = auth.uid());


-- ─────────────────────────────────────────────────────────
-- Run these if upgrading an existing database (safe to re-run):
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS website_url          text             DEFAULT '';
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS profile              jsonb            DEFAULT '{}'::jsonb;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS scraped_at           timestamptz;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS vapi_phone           text             DEFAULT '';
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS vapi_assistant_id    text             DEFAULT '';

-- Stripe billing columns (required for /create-checkout-session):
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS stripe_customer_id     text;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS stripe_subscription_id text;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS plan                   text DEFAULT 'free';
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS plan_status            text DEFAULT 'trial';
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS trial_ends_at          timestamptz;

-- Email column (used by auth/signup insert):
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS email text DEFAULT '';

-- Google Calendar integration:
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS google_access_token  text;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS google_refresh_token text;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS google_calendar_id   text;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS google_connected      boolean DEFAULT false;

-- SMS consent + opt-out columns (A2P 10DLC compliance):
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS mobile_phone          text             DEFAULT '';
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS sms_consent_given     boolean          DEFAULT false;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS sms_consent_at        timestamptz;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS sms_consent_ip        text;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS sms_consent_user_agent text;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS sms_opted_out         boolean          DEFAULT false;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS sms_opted_out_at      timestamptz;

-- Twilio phone number mapping (inbound call/SMS routing):
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS twilio_phone          text             DEFAULT '';
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS forward_phone         text             DEFAULT '';
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS vapi_phone_number_id  text             DEFAULT '';
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS owner_email           text             DEFAULT '';

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
