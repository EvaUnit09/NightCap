ALTER TABLE public.feedback
  ADD COLUMN request_hash TEXT;

ALTER TABLE public.feedback
  ADD CONSTRAINT feedback_request_hash_hex CHECK (
    request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'
  );

CREATE INDEX idx_feedback_request_hash ON public.feedback (request_hash)
  WHERE request_hash IS NOT NULL;

COMMENT ON TABLE public.feedback IS
  'Thumbs, would-go, did-go, new-to-you, and closed-venue reports. Writes via service_role through the API. No captcha. request_hash copies requests.client_hash and matches the Datadog request_hash attribute.';

COMMENT ON COLUMN public.feedback.request_hash IS
  'Datadog join key. Copied from requests.client_hash when the API inserts a row. Clients do not send it.';
