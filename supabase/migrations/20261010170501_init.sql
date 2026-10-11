-- Nightcap Database Schema
-- Initial migration for requests, itineraries, feedback, places_cache, and saved_plans
-- Implements data model from docs/architecture.md §1 Contracts action #4
--
-- Google Places API caching (Noah, 2026-10-10):
--   places_cache stores only terms-permitted fields:
--     - place_id: may be stored indefinitely (refresh recommended after 12 months)
--     - lat/lng: may be stored at most 30 consecutive calendar days via coords_expires_at
--   There is no payload column. Hours, business_status, price_level, rating,
--   and names are fetched live and are not cached here.
--   Saved itineraries.stops store placeId plus planning fields only (decision #29).
--   The app hydrates names and Places details live at view/share time.
--
-- Share slugs are generated server-side by save_plan() (CSPRNG / gen_random_uuid).
-- Application clients must not insert saved_plans or invent slugs.
--
-- get_shared_plan is SECURITY DEFINER and must be owned by a BYPASSRLS role
-- (migration owner / supabase_admin) so it can read itineraries with no table policy.
--
-- cleanup_expired_cache must be invoked by a scheduled job (pg_cron or the app's
-- cron). Readers must not serve expired coordinates: use places_cache_live or
-- filter coords_expires_at > now().
--
-- Retention: ON DELETE RESTRICT on saved_plans.itinerary_id means a future
-- request-cleanup job must skip any request whose itineraries are referenced
-- by saved_plans.

-- gen_random_uuid() is built in on Postgres 13+ (no uuid-ossp).

-- =============================================================================
-- REQUESTS
-- =============================================================================
CREATE TABLE public.requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  redacted_text TEXT NOT NULL,
  parsed_intent JSONB NOT NULL,
  client_hash TEXT,
  CONSTRAINT requests_redacted_text_not_empty CHECK (LENGTH(TRIM(redacted_text)) > 0)
);

CREATE INDEX idx_requests_created_at ON public.requests (created_at DESC);
CREATE INDEX idx_requests_client_hash ON public.requests (client_hash) WHERE client_hash IS NOT NULL;
CREATE INDEX idx_requests_user_id ON public.requests (user_id) WHERE user_id IS NOT NULL;

ALTER TABLE public.requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.requests FORCE ROW LEVEL SECURITY;

-- =============================================================================
-- ITINERARIES
-- =============================================================================
-- Persisted stops are placeId + our planning fields only. Venue names and
-- Places details (address, rating, hours, price, …) are hydrated live by the
-- app at view/share time. The pipeline must strip those keys before INSERT.
CREATE OR REPLACE FUNCTION public.itineraries_stops_are_place_ids_only(stops jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  stop jsonb;
  key text;
  allowed text[] := ARRAY[
    'placeId',
    'start',
    'end',
    'stopType',
    'estimatedCostUsd',
    'why',
    'travelToNext'
  ];
BEGIN
  IF jsonb_typeof(stops) <> 'array' THEN
    RETURN false;
  END IF;

  FOR stop IN SELECT value FROM jsonb_array_elements(stops)
  LOOP
    IF jsonb_typeof(stop) <> 'object' THEN
      RETURN false;
    END IF;
    IF NULLIF(btrim(stop->>'placeId'), '') IS NULL THEN
      RETURN false;
    END IF;
    FOR key IN SELECT jsonb_object_keys(stop)
    LOOP
      IF NOT (key = ANY (allowed)) THEN
        RETURN false;
      END IF;
    END LOOP;
  END LOOP;

  RETURN true;
END;
$$;

CREATE TABLE public.itineraries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES public.requests (id) ON DELETE CASCADE,
  option_index INTEGER NOT NULL,
  stops JSONB NOT NULL,
  valid BOOLEAN NOT NULL DEFAULT false,
  validation_errors JSONB,
  prompt_versions JSONB NOT NULL,
  models JSONB NOT NULL,
  cost_usd DECIMAL(10, 6),
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT itineraries_option_index_range CHECK (option_index BETWEEN 0 AND 2),
  CONSTRAINT itineraries_cost_non_negative CHECK (cost_usd IS NULL OR cost_usd >= 0),
  CONSTRAINT itineraries_latency_non_negative CHECK (latency_ms IS NULL OR latency_ms >= 0),
  CONSTRAINT itineraries_stops_place_ids_only CHECK (public.itineraries_stops_are_place_ids_only(stops)),
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
  ),
  CONSTRAINT places_cache_coords_fetched_not_future CHECK (
    coords_fetched_at IS NULL
    OR coords_fetched_at <= NOW() + INTERVAL '5 minutes'
  )
);

CREATE INDEX idx_places_cache_coords_expires_at ON public.places_cache (coords_expires_at)
  WHERE coords_expires_at IS NOT NULL;

ALTER TABLE public.places_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.places_cache FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.places_cache_guard_fetched_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.coords_fetched_at IS DISTINCT FROM OLD.coords_fetched_at
     AND NEW.lat IS NOT DISTINCT FROM OLD.lat
     AND NEW.lng IS NOT DISTINCT FROM OLD.lng THEN
    RAISE EXCEPTION 'coords_fetched_at cannot change unless lat/lng change';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER places_cache_guard_fetched_at
  BEFORE UPDATE ON public.places_cache
  FOR EACH ROW
  EXECUTE FUNCTION public.places_cache_guard_fetched_at();

-- Hides expired coordinates. Readers should use this (or filter expires_at > now())
-- rather than raw places_cache.
CREATE OR REPLACE VIEW public.places_cache_live AS
SELECT
  place_id,
  CASE WHEN coords_expires_at IS NOT NULL AND coords_expires_at > NOW() THEN lat END AS lat,
  CASE WHEN coords_expires_at IS NOT NULL AND coords_expires_at > NOW() THEN lng END AS lng,
  CASE WHEN coords_expires_at IS NOT NULL AND coords_expires_at > NOW() THEN coords_fetched_at END AS coords_fetched_at,
  CASE WHEN coords_expires_at IS NOT NULL AND coords_expires_at > NOW() THEN coords_expires_at END AS coords_expires_at
FROM public.places_cache;

-- =============================================================================
-- SAVED_PLANS
-- =============================================================================
-- ON DELETE RESTRICT on itinerary_id: deleting a request/itinerary must not
-- wipe a saved plan a user may have shared. Reload keeps working because the
-- itinerary row stays until the saved_plan is removed first.
-- Any future retention cleanup must skip requests referenced by saved_plans.
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

CREATE POLICY saved_plans_delete_own ON public.saved_plans
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- No INSERT policy: saves go through save_plan() (service_role only).

-- =============================================================================
-- SHARE RPC
-- =============================================================================
-- Public path for a share slug. Returns only safe fields of a valid itinerary.
-- Never returns user_id, request text, or client_hash.
-- stops are placeIds plus planning fields only; the app hydrates names and
-- Places details live through Places at view time (decision #29).
-- Owner must be a BYPASSRLS role so SECURITY DEFINER can read itineraries.
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
  WHERE sp.share_slug = get_shared_plan.slug
    AND i.valid = true;
END;
$$;

-- =============================================================================
-- SAVE RPC (server-only)
-- =============================================================================
-- Generates the share slug. user_id is supplied by the server (service_role).
-- Refuses to save an itinerary whose request belongs to a different user.
CREATE OR REPLACE FUNCTION public.save_plan(p_user_id uuid, p_itinerary_id uuid)
RETURNS TABLE (
  id uuid,
  share_slug text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  request_owner uuid;
  new_slug text;
BEGIN
  SELECT r.user_id
  INTO request_owner
  FROM public.itineraries AS i
  JOIN public.requests AS r ON r.id = i.request_id
  WHERE i.id = p_itinerary_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'itinerary not found';
  END IF;

  IF request_owner IS NOT NULL AND request_owner IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'cannot save another user''s itinerary';
  END IF;

  new_slug := replace(gen_random_uuid()::text, '-', '');

  RETURN QUERY
  INSERT INTO public.saved_plans (user_id, itinerary_id, share_slug)
  VALUES (p_user_id, p_itinerary_id, new_slug)
  RETURNING public.saved_plans.id, public.saved_plans.share_slug;
END;
$$;

-- =============================================================================
-- CACHE CLEANUP
-- =============================================================================
-- Call from pg_cron or the app's cron. Not a substitute for read-time filtering.
CREATE OR REPLACE FUNCTION public.cleanup_expired_cache()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  cleaned_count INTEGER;
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
  GET DIAGNOSTICS cleaned_count = ROW_COUNT;
  RETURN cleaned_count;
END;
$$;

-- =============================================================================
-- GRANTS
-- Server (service_role) reads/writes all tables. The only public path is the
-- share RPC. Feedback writes go through the API after Turnstile, not anon INSERT.
-- Saves go through save_plan() (service_role), not authenticated INSERT.
-- =============================================================================
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

GRANT ALL ON TABLE public.requests TO service_role;
GRANT ALL ON TABLE public.itineraries TO service_role;
GRANT ALL ON TABLE public.feedback TO service_role;
GRANT ALL ON TABLE public.places_cache TO service_role;
GRANT ALL ON TABLE public.saved_plans TO service_role;
GRANT ALL ON TABLE public.places_cache_live TO service_role;

REVOKE ALL ON TABLE public.requests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.itineraries FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.feedback FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.places_cache FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.places_cache_live FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.saved_plans FROM PUBLIC, anon, authenticated;

GRANT SELECT, DELETE ON TABLE public.saved_plans TO authenticated;

REVOKE ALL ON FUNCTION public.get_shared_plan(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_shared_plan(text) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.save_plan(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_plan(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.save_plan(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.save_plan(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.cleanup_expired_cache() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_expired_cache() FROM anon;
REVOKE ALL ON FUNCTION public.cleanup_expired_cache() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_cache() TO service_role;

REVOKE ALL ON FUNCTION public.places_cache_guard_fetched_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.places_cache_guard_fetched_at() FROM anon;
REVOKE ALL ON FUNCTION public.places_cache_guard_fetched_at() FROM authenticated;

REVOKE ALL ON FUNCTION public.itineraries_stops_are_place_ids_only(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.itineraries_stops_are_place_ids_only(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.itineraries_stops_are_place_ids_only(jsonb) FROM authenticated;

-- =============================================================================
-- COMMENTS
-- =============================================================================
COMMENT ON TABLE public.requests IS
  'User requests with heuristically redacted text and parsed intent. service_role only. Retention jobs must skip requests whose itineraries are referenced by saved_plans (RESTRICT).';
COMMENT ON COLUMN public.requests.redacted_text IS
  'Heuristically redacted free text (decision #27).';
COMMENT ON COLUMN public.requests.user_id IS
  'Nullable owner (magic-link user). Null means an anonymous request. save_plan refuses to attach a plan when this belongs to someone else.';
COMMENT ON TABLE public.itineraries IS
  'Generated options with validation and trace metadata. service_role only; public reads go through get_shared_plan(). stops store placeId plus planning fields; names are hydrated live.';
COMMENT ON TABLE public.feedback IS
  'Thumbs, would-go/did-go, new-to-you, closed-venue reports. Writes via service_role after Turnstile.';
COMMENT ON TABLE public.places_cache IS
  'place_id indefinitely; lat/lng with coords_expires_at <= 30 days. Hours, price, and rating are fetched live. Venue names are not stored here.';
COMMENT ON TABLE public.saved_plans IS
  'Magic-link owned saved plans. Inserts via save_plan() only. Shared reads use get_shared_plan(slug).';

COMMENT ON COLUMN public.itineraries.stops IS
  'JSON stop list: placeId plus planning fields only (start, end, stopType, estimatedCostUsd, why, travelToNext). Names and Places details are hydrated live at view/share time. Pipeline must strip names before persist.';
COMMENT ON COLUMN public.itineraries.cost_usd IS
  'Measured plan cost in USD. Nullable; no zero default (unset is not free).';
COMMENT ON COLUMN public.itineraries.latency_ms IS
  'Measured latency in milliseconds. Nullable; no zero default.';
COMMENT ON COLUMN public.places_cache.place_id IS 'Google Place ID; stored indefinitely (PK).';
COMMENT ON COLUMN public.places_cache.lat IS 'Latitude; expire via coords_expires_at within 30 days.';
COMMENT ON COLUMN public.places_cache.lng IS 'Longitude; expire via coords_expires_at within 30 days.';
COMMENT ON COLUMN public.places_cache.coords_fetched_at IS
  'When lat/lng were last written. Must not be more than 5 minutes in the future. Cannot be bumped unless lat/lng change.';
COMMENT ON COLUMN public.places_cache.coords_expires_at IS
  'Coord expiry, at most coords_fetched_at + 30 days. Reads must filter coords_expires_at > now() or use places_cache_live.';
COMMENT ON COLUMN public.saved_plans.share_slug IS
  '16-64 URL-safe chars, generated by save_plan() server-side. Not client-chosen.';
COMMENT ON COLUMN public.saved_plans.itinerary_id IS
  'ON DELETE RESTRICT so deleting a request cannot cascade-delete a saved/shared plan. Retention cleanup must skip referenced requests.';

COMMENT ON FUNCTION public.get_shared_plan(text) IS
  'Share RPC. SECURITY DEFINER, search_path empty, owner must be BYPASSRLS. Returns placeIds plus planning fields only; the app hydrates names and details live through Places at view time.';
COMMENT ON FUNCTION public.itineraries_stops_are_place_ids_only(jsonb) IS
  'CHECK helper: itineraries.stops must be an array of objects with placeId and planning keys only. Rejects name, address, rating, hours, and other Places details.';
COMMENT ON FUNCTION public.save_plan(uuid, uuid) IS
  'service_role only. Generates the slug. Refuses when the itinerary request belongs to another user.';
COMMENT ON FUNCTION public.cleanup_expired_cache() IS
  'service_role only. Clears expired lat/lng; keeps place_id. Invoke from pg_cron or the app cron.';
COMMENT ON VIEW public.places_cache_live IS
  'places_cache with expired coordinates nulled. Prefer this for reads.';
