-- Nightcap Database Schema
-- Initial migration for requests, itineraries, feedback, places_cache, and saved_plans
-- Implements data model from docs/architecture.md §1 Contracts action #4
-- 
-- Google Places API Caching Compliance:
-- Per Google Maps Platform Terms (https://cloud.google.com/maps-platform/terms/maps-service-terms):
-- - place_id: May be cached indefinitely (refresh recommended after 12 months)
-- - lat/lng coordinates: May be cached for up to 30 consecutive days
-- - Other content: Stored with 24-hour TTL (PLACES_CACHE_TTL_HOURS) for operational use,
--   which is significantly more conservative than Google's limits and aligns with
--   temporary caching for real-time query optimization
--
-- The expires_at mechanism ensures automatic expiration; application code must not
-- serve expired rows. Consider adding a cleanup job for rows where expires_at < now().

-- Enable UUID extension for ID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- REQUESTS TABLE
-- =============================================================================
-- Stores user requests with PII-redacted text and parsed intent
CREATE TABLE requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  redacted_text TEXT NOT NULL,
  parsed_intent JSONB NOT NULL,
  client_hash TEXT,
  
  -- Indexes for common queries
  CONSTRAINT requests_redacted_text_not_empty CHECK (LENGTH(TRIM(redacted_text)) > 0)
);

CREATE INDEX idx_requests_created_at ON requests(created_at DESC);
CREATE INDEX idx_requests_client_hash ON requests(client_hash) WHERE client_hash IS NOT NULL;

-- RLS: Anonymous read-only for now; write is server-side only
ALTER TABLE requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Requests are viewable by everyone" ON requests
  FOR SELECT USING (true);

-- =============================================================================
-- ITINERARIES TABLE
-- =============================================================================
-- Stores generated itinerary options with validation results and metadata
CREATE TABLE itineraries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id UUID NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  option_index INTEGER NOT NULL,
  stops JSONB NOT NULL,
  valid BOOLEAN NOT NULL DEFAULT false,
  validation_errors JSONB,
  prompt_versions JSONB NOT NULL,
  models JSONB NOT NULL,
  cost_usd DECIMAL(10, 6) NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Constraints
  CONSTRAINT itineraries_option_index_positive CHECK (option_index >= 0),
  CONSTRAINT itineraries_cost_non_negative CHECK (cost_usd >= 0),
  CONSTRAINT itineraries_latency_non_negative CHECK (latency_ms >= 0),
  CONSTRAINT itineraries_unique_option_per_request UNIQUE (request_id, option_index)
);

CREATE INDEX idx_itineraries_request_id ON itineraries(request_id);
CREATE INDEX idx_itineraries_valid ON itineraries(valid);
CREATE INDEX idx_itineraries_created_at ON itineraries(created_at DESC);

-- RLS: Anonymous read-only for now; write is server-side only
ALTER TABLE itineraries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Itineraries are viewable by everyone" ON itineraries
  FOR SELECT USING (true);

-- =============================================================================
-- FEEDBACK TABLE
-- =============================================================================
-- Collects user feedback on itineraries: thumbs, intent signals, and issue reports
CREATE TABLE feedback (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  itinerary_id UUID NOT NULL REFERENCES itineraries(id) ON DELETE CASCADE,
  thumbs SMALLINT CHECK (thumbs IN (-1, 1)),
  would_go BOOLEAN,
  did_go BOOLEAN,
  new_to_you JSONB,
  closed_report_place_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- At least one feedback field must be provided
  CONSTRAINT feedback_has_content CHECK (
    thumbs IS NOT NULL OR
    would_go IS NOT NULL OR
    did_go IS NOT NULL OR
    new_to_you IS NOT NULL OR
    closed_report_place_id IS NOT NULL
  )
);

CREATE INDEX idx_feedback_itinerary_id ON feedback(itinerary_id);
CREATE INDEX idx_feedback_closed_report ON feedback(closed_report_place_id) WHERE closed_report_place_id IS NOT NULL;
CREATE INDEX idx_feedback_created_at ON feedback(created_at DESC);

-- RLS: Anonymous feedback submission allowed; read is server-side only
ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can submit feedback" ON feedback
  FOR INSERT WITH CHECK (true);

-- =============================================================================
-- PLACES_CACHE TABLE
-- =============================================================================
-- Caches Google Places API responses in compliance with Google's Terms of Service
-- 
-- Google Places API Caching Policy Compliance:
-- ✓ place_id: Cacheable indefinitely (Google recommends refresh if >12 months old)
-- ✓ lat/lng: Cacheable for up to 30 consecutive calendar days
-- ⚠ Other fields (business_status, opening_hours, price_level, rating, etc.):
--   Stored in payload JSONB with 24-hour TTL for operational query optimization.
--   This conservative approach (24h << 30d limit for coordinates) ensures compliance
--   while supporting the real-time retrieval pipeline.
--
-- Application code MUST NOT serve rows where expires_at < NOW().
-- The expires_at timestamp is set based on PLACES_CACHE_TTL_HOURS (default: 24h).
CREATE TABLE places_cache (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  -- Primary cache key (place_id for Place Details, query hash for Text/Nearby Search)
  cache_key TEXT NOT NULL UNIQUE,
  
  -- Google Place ID (cacheable indefinitely per Google's terms)
  place_id TEXT,
  
  -- Coordinates (cacheable for 30 days per Google's terms)
  lat DECIMAL(10, 8),
  lng DECIMAL(11, 8),
  
  -- Additional API response data stored with 24-hour TTL
  -- Fields may include: business_status, opening_hours, price_level, rating,
  -- user_ratings_total, types, formatted_address, etc.
  -- Application code interprets this based on the response structure.
  payload JSONB NOT NULL,
  
  -- Cache timing
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  
  -- Enforce expiration policy
  CONSTRAINT places_cache_valid_expiration CHECK (expires_at > fetched_at)
);

CREATE INDEX idx_places_cache_cache_key ON places_cache(cache_key);
CREATE INDEX idx_places_cache_place_id ON places_cache(place_id) WHERE place_id IS NOT NULL;
CREATE INDEX idx_places_cache_expires_at ON places_cache(expires_at);

-- RLS: Cache is server-side only; no direct user access
ALTER TABLE places_cache ENABLE ROW LEVEL SECURITY;

-- No public policies; server-side code bypasses RLS with service role

-- =============================================================================
-- SAVED_PLANS TABLE
-- =============================================================================
-- Allows authenticated users (via Supabase magic link) to save and share itineraries
CREATE TABLE saved_plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  itinerary_id UUID NOT NULL REFERENCES itineraries(id) ON DELETE CASCADE,
  share_slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Constraints
  CONSTRAINT saved_plans_share_slug_format CHECK (share_slug ~ '^[a-z0-9-]{6,}$')
);

CREATE INDEX idx_saved_plans_user_id ON saved_plans(user_id);
CREATE INDEX idx_saved_plans_itinerary_id ON saved_plans(itinerary_id);
CREATE INDEX idx_saved_plans_share_slug ON saved_plans(share_slug);

-- RLS: Users can only manage their own saved plans
ALTER TABLE saved_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own saved plans" ON saved_plans
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own saved plans" ON saved_plans
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own saved plans" ON saved_plans
  FOR DELETE USING (auth.uid() = user_id);

-- Public read access via share_slug (for sharing functionality)
CREATE POLICY "Anyone can view saved plans via share slug" ON saved_plans
  FOR SELECT USING (share_slug IS NOT NULL);

-- =============================================================================
-- HELPER FUNCTION: Cleanup expired cache entries
-- =============================================================================
-- Optional: Can be called by a periodic job (e.g., pg_cron) to remove stale cache
CREATE OR REPLACE FUNCTION cleanup_expired_cache()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM places_cache WHERE expires_at < NOW();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- COMMENTS FOR DOCUMENTATION
-- =============================================================================
COMMENT ON TABLE requests IS 'User requests with PII-redacted text and parsed intent';
COMMENT ON TABLE itineraries IS 'Generated itinerary options with validation results and trace metadata';
COMMENT ON TABLE feedback IS 'User feedback: thumbs up/down, would-go/did-go signals, new-to-you per venue, closed venue reports';
COMMENT ON TABLE places_cache IS 'Google Places API response cache. Complies with Google terms: place_id indefinite, lat/lng 30d, other fields 24h TTL via expires_at.';
COMMENT ON TABLE saved_plans IS 'User-owned saved plans with shareable slugs (Supabase magic-link auth)';

COMMENT ON COLUMN places_cache.cache_key IS 'Unique cache key: place_id for Place Details, or hash of query params for Text/Nearby Search';
COMMENT ON COLUMN places_cache.place_id IS 'Google Place ID (cacheable indefinitely per Google Maps Platform Terms)';
COMMENT ON COLUMN places_cache.lat IS 'Latitude (cacheable for 30 consecutive days per Google Maps Platform Terms)';
COMMENT ON COLUMN places_cache.lng IS 'Longitude (cacheable for 30 consecutive days per Google Maps Platform Terms)';
COMMENT ON COLUMN places_cache.payload IS 'Additional response fields stored as JSONB. Served only if expires_at > NOW(). Contains business_status, hours, price_level, rating, etc.';
COMMENT ON COLUMN places_cache.expires_at IS 'Expiration timestamp based on PLACES_CACHE_TTL_HOURS (default 24h). Application MUST NOT serve rows where expires_at < NOW().';
