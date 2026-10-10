-- Nightcap Database Schema
-- Initial migration for requests, itineraries, feedback, places_cache, and saved_plans
-- Implements data model from docs/architecture.md §1 Contracts action #4
--
-- Google Places API caching (Noah, 2026-10-10):
--   places_cache stores only terms-permitted fields:
--     - place_id: may be stored indefinitely (refresh recommended after 12 months)
--     - lat/lng: may be stored at most 30 consecutive calendar days via coords_expires_at
--   There is no payload column. Hours, business_status, price_level, rating, and
--   other Places content are not cached here.
--   Venue names inside itineraries.stops are a separate storage question; see the
--   column comment. Do not treat this table as a general Places response cache.
--
-- Share slugs are generated server-side with a CSPRNG (e.g. crypto.randomBytes).
-- Application code must not invent guessable slugs.

-- gen_random_uuid() is built in on Postgres 13+ (no uuid-ossp).

-- =============================================================================
-- REQUESTS
-- =============================================================================
CREATE TABLE public.requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  redacted_text TEXT NOT NULL,
  parsed_intent JSONB NOT NULL,
  client_hash TEXT,
  CONSTRAINT requests_redacted_text_not_empty CHECK (LENGTH(TRIM(redacted_text)) > 0)
);

CREATE INDEX idx_requests_created_at ON public.requests (created_at DESC);
CREATE INDEX idx_requests_client_hash ON public.requests (client_hash) WHERE client_hash IS NOT NULL;

ALTER TABLE public.requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.requests FORCE ROW LEVEL SECURITY;

-- =============================================================================
-- ITINERARIES
-- =============================================================================
CREATE TABLE public.itineraries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES public.requests (id) ON DELETE CASCADE,
  option_index INTEGER NOT NULL,
  stops JSONB NOT NULL,
  valid BOOLEAN NOT NULL DEFAULT false,
  validation_errors JSONB,
  prompt_versions JSONB NOT NULL,
  models JSONB NOT NULL,
  cost_usd DECIMAL(10, 6) NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT itineraries_option_index_range CHECK (option_index BETWEEN 0 AND 2),
  CONSTRAINT itineraries_cost_non_negative CHECK (cost_usd >= 0),
  CONSTRAINT itineraries_latency_non_negative CHECK (latency_ms >= 0),
  CONSTRAINT itineraries_unique_option_per_request UNIQUE (request_id, option_index)
);

CREATE INDEX idx_itineraries_valid ON public.itineraries (valid);
CREATE INDEX idx_itineraries_created_at ON public.itineraries (created_at DESC);

ALTER TABLE public.itineraries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.itineraries FORCE ROW LEVEL SECURITY;

-- =============================================================================
-- FEEDBACK
-- =============================================================================
CREATE TABLE public.feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  itinerary_id UUID NOT NULL REFERENCES public.itineraries (id) ON DELETE CASCADE,
  thumbs SMALLINT CHECK (thumbs IN (-1, 1)),
  would_go BOOLEAN,
  did_go BOOLEAN,
  new_to_you JSONB,
  closed_report_place_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT feedback_has_content CHECK (
    thumbs IS NOT NULL
    OR would_go IS NOT NULL
    OR did_go IS NOT NULL
    OR new_to_you IS NOT NULL
    OR closed_report_place_id IS NOT NULL
  )
);

CREATE INDEX idx_feedback_itinerary_id ON public.feedback (itinerary_id);
CREATE INDEX idx_feedback_closed_report ON public.feedback (closed_report_place_id)
  WHERE closed_report_place_id IS NOT NULL;
CREATE INDEX idx_feedback_created_at ON public.feedback (created_at DESC);

ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback FORCE ROW LEVEL SECURITY;

-- =============================================================================
-- PLACES_CACHE
-- =============================================================================
-- Noah 2026-10-10: place_id indefinitely; lat/lng for ≤ 30 days; details live.
-- No payload, name, hours, price, or rating columns.
CREATE TABLE public.places_cache (
  place_id TEXT PRIMARY KEY,
  lat DECIMAL(10, 8),
  lng DECIMAL(11, 8),
  coords_fetched_at TIMESTAMPTZ,
  coords_expires_at TIMESTAMPTZ,
  CONSTRAINT places_cache_coords_pair CHECK (
    (lat IS NULL AND lng IS NULL AND coords_fetched_at IS NULL AND coords_expires_at IS NULL)
    OR (lat IS NOT NULL AND lng IS NOT NULL AND coords_fetched_at IS NOT NULL AND coords_expires_at IS NOT NULL)
  ),
  CONSTRAINT places_cache_coords_ttl CHECK (
    coords_expires_at IS NULL
    OR (
      coords_expires_at > coords_fetched_at
      AND coords_expires_at <= coords_fetched_at + INTERVAL '30 days'
    )
  )
);

CREATE INDEX idx_places_cache_coords_expires_at ON public.places_cache (coords_expires_at)
  WHERE coords_expires_at IS NOT NULL;

ALTER TABLE public.places_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.places_cache FORCE ROW LEVEL SECURITY;

-- =============================================================================
-- SAVED_PLANS
-- =============================================================================
-- ON DELETE RESTRICT on itinerary_id: deleting a request/itinerary must not
-- wipe a saved plan a user may have shared. Reload keeps working because the
-- itinerary row stays until the saved_plan is removed first.
CREATE TABLE public.saved_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  itinerary_id UUID NOT NULL REFERENCES public.itineraries (id) ON DELETE RESTRICT,
  share_slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT saved_plans_share_slug_format CHECK (share_slug ~ '^[A-Za-z0-9_-]{16,64}$')
);

CREATE INDEX idx_saved_plans_user_id ON public.saved_plans (user_id);
CREATE INDEX idx_saved_plans_itinerary_id ON public.saved_plans (itinerary_id);

ALTER TABLE public.saved_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_plans FORCE ROW LEVEL SECURITY;

CREATE POLICY saved_plans_select_own ON public.saved_plans
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY saved_plans_insert_own ON public.saved_plans
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY saved_plans_delete_own ON public.saved_plans
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- =============================================================================
-- SHARE RPC
-- =============================================================================
-- Public path for a share slug. Returns only safe itinerary fields.
-- Never returns user_id, request text, or client_hash.
CREATE OR REPLACE FUNCTION public.get_shared_plan(slug text)
RETURNS TABLE (
  itinerary_id uuid,
  option_index integer,
  stops jsonb,
  valid boolean,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT
    i.id,
    i.option_index,
    i.stops,
    i.valid,
    i.created_at
  FROM public.saved_plans AS sp
  JOIN public.itineraries AS i ON i.id = sp.itinerary_id
  WHERE sp.share_slug = get_shared_plan.slug;
END;
$$;

-- =============================================================================
-- CACHE CLEANUP
-- =============================================================================
CREATE OR REPLACE FUNCTION public.cleanup_expired_cache()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  -- Keep place_id rows; only drop expired coordinates.
  UPDATE public.places_cache
  SET
    lat = NULL,
    lng = NULL,
    coords_fetched_at = NULL,
    coords_expires_at = NULL
  WHERE coords_expires_at IS NOT NULL
    AND coords_expires_at < NOW();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- =============================================================================
-- GRANTS
-- Server (service_role) reads/writes all tables. The only public path is the
-- share RPC. Feedback writes go through the API after Turnstile, not anon INSERT.
-- =============================================================================
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

GRANT ALL ON TABLE public.requests TO service_role;
GRANT ALL ON TABLE public.itineraries TO service_role;
GRANT ALL ON TABLE public.feedback TO service_role;
GRANT ALL ON TABLE public.places_cache TO service_role;
GRANT ALL ON TABLE public.saved_plans TO service_role;

REVOKE ALL ON TABLE public.requests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.itineraries FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.feedback FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.places_cache FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.saved_plans FROM PUBLIC, anon;

GRANT SELECT, INSERT, DELETE ON TABLE public.saved_plans TO authenticated;

REVOKE ALL ON FUNCTION public.get_shared_plan(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_shared_plan(text) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.cleanup_expired_cache() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_expired_cache() FROM anon;
REVOKE ALL ON FUNCTION public.cleanup_expired_cache() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_cache() TO service_role;

-- =============================================================================
-- COMMENTS
-- =============================================================================
COMMENT ON TABLE public.requests IS 'User requests with heuristic-redacted text and parsed intent. service_role only.';
COMMENT ON COLUMN public.requests.redacted_text IS 'Heuristic-redacted free text (decision #27). PII must not be stored in the clear.';
COMMENT ON TABLE public.itineraries IS 'Generated options with validation and trace metadata. service_role only; public reads go through get_shared_plan().';
COMMENT ON TABLE public.feedback IS 'Thumbs, would-go/did-go, new-to-you, closed-venue reports. Writes via service_role after Turnstile.';
COMMENT ON TABLE public.places_cache IS 'place_id indefinitely; lat/lng with coords_expires_at <= 30 days. Hours, price, rating, and names are fetched live — not stored.';
COMMENT ON TABLE public.saved_plans IS 'Magic-link owned saved plans. Shared reads use get_shared_plan(slug), not a table policy.';

COMMENT ON COLUMN public.itineraries.stops IS
  'JSON stop list. Venue names are not cached in places_cache; hours, price, rating, and names are fetched live per request.';
COMMENT ON COLUMN public.places_cache.place_id IS 'Google Place ID; stored indefinitely (PK).';
COMMENT ON COLUMN public.places_cache.lat IS 'Latitude; expire via coords_expires_at within 30 days.';
COMMENT ON COLUMN public.places_cache.lng IS 'Longitude; expire via coords_expires_at within 30 days.';
COMMENT ON COLUMN public.places_cache.coords_fetched_at IS 'When lat/lng were last written. Used with PLACES_COORDS_CACHE_TTL_DAYS (default 30).';
COMMENT ON COLUMN public.places_cache.coords_expires_at IS 'Coord expiry, at most coords_fetched_at + 30 days. Do not serve expired coordinates.';
COMMENT ON COLUMN public.saved_plans.share_slug IS '16-64 URL-safe chars, generated server-side with a CSPRNG. Not user-chosen.';
COMMENT ON COLUMN public.saved_plans.itinerary_id IS 'ON DELETE RESTRICT so deleting a request cannot cascade-delete a saved/shared plan.';

COMMENT ON FUNCTION public.get_shared_plan(text) IS
  'Share RPC. SECURITY DEFINER, search_path empty. Returns only safe itinerary fields.';
COMMENT ON FUNCTION public.cleanup_expired_cache() IS
  'service_role only. Clears expired lat/lng; keeps place_id.';
