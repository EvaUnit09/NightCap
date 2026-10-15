-- One saved plan per (user, itinerary), so concurrent saves share one slug.
-- Operator: this fails if duplicates already exist. Check first and resolve by hand:
--   SELECT user_id, itinerary_id, count(*) FROM public.saved_plans
--   GROUP BY 1, 2 HAVING count(*) > 1;
ALTER TABLE public.saved_plans
  ADD CONSTRAINT saved_plans_user_itinerary_key UNIQUE (user_id, itinerary_id);

-- Return type gains `created`, so the function must be dropped and recreated.
DROP FUNCTION public.save_plan(uuid, uuid);

CREATE FUNCTION public.save_plan(p_user_id uuid, p_itinerary_id uuid)
RETURNS TABLE (
  id uuid,
  share_slug text,
  created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  request_owner uuid;
  saved_id uuid;
  saved_slug text;
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

  INSERT INTO public.saved_plans (user_id, itinerary_id, share_slug)
  VALUES (p_user_id, p_itinerary_id, replace(gen_random_uuid()::text, '-', ''))
  ON CONFLICT ON CONSTRAINT saved_plans_user_itinerary_key DO NOTHING
  RETURNING public.saved_plans.id, public.saved_plans.share_slug
  INTO saved_id, saved_slug;

  IF FOUND THEN
    RETURN QUERY SELECT saved_id, saved_slug, true;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT sp.id, sp.share_slug, false
  FROM public.saved_plans AS sp
  WHERE sp.user_id = p_user_id AND sp.itinerary_id = p_itinerary_id;
END;
$$;

REVOKE ALL ON FUNCTION public.save_plan(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_plan(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.save_plan(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.save_plan(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.save_plan(uuid, uuid) IS
  'service_role only. Generates the slug. Idempotent per (user, itinerary): returns the existing row with created = false. Refuses when the itinerary request belongs to another user.';
