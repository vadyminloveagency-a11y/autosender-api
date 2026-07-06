CREATE TABLE IF NOT EXISTS users (

  id SERIAL PRIMARY KEY,

  email TEXT UNIQUE NOT NULL,

  password_hash TEXT NOT NULL,

  name TEXT NOT NULL DEFAULT '',

  role TEXT NOT NULL DEFAULT 'operator',

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()

);



CREATE TABLE IF NOT EXISTS favorites (

  id SERIAL PRIMARY KEY,

  female_profile_id BIGINT NOT NULL,

  male_profile_id BIGINT NOT NULL,

  display_name TEXT NOT NULL DEFAULT '',

  photo_url TEXT NOT NULL DEFAULT '',

  notes TEXT NOT NULL DEFAULT '',

  tags TEXT[] NOT NULL DEFAULT '{}',

  last_letter_at TIMESTAMPTZ,

  last_letter_preview TEXT NOT NULL DEFAULT '',

  inbox_order INTEGER,

  letter_count INTEGER NOT NULL DEFAULT 0,

  is_site_favorite BOOLEAN NOT NULL DEFAULT FALSE,
  is_site_ignored BOOLEAN NOT NULL DEFAULT FALSE,

  man_type TEXT NOT NULL DEFAULT '',

  is_pinned BOOLEAN NOT NULL DEFAULT FALSE,

  pin_order BIGINT,

  first_contact_at TIMESTAMPTZ,

  source TEXT NOT NULL DEFAULT 'manual',

  added_by TEXT NOT NULL DEFAULT '',

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (female_profile_id, male_profile_id)

);



CREATE INDEX IF NOT EXISTS favorites_female_idx ON favorites (female_profile_id);

CREATE INDEX IF NOT EXISTS favorites_updated_idx ON favorites (updated_at DESC);

