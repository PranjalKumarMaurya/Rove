-- AI usage per person: one row per model call (today only Scan's document
-- reader), with the tokens it used and what that cost. Written only by the
-- server (Edge Functions with the service role), so nobody can lower or
-- inflate their own numbers; each person can read only their own rows and
-- totals. Kept for every AI feature to come (`feature`).
BEGIN;

CREATE TABLE public.ai_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The person. Deleting an account keeps the row (for spend totals) without them.
  profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  group_id uuid REFERENCES public.groups(id) ON DELETE SET NULL,
  feature text NOT NULL CHECK (feature ~ '^[a-z_]{1,40}$'),
  -- The document read, when the feature is Scan (no FK: deleting it keeps the cost).
  document_id uuid,
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 80),
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens integer NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens integer NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  -- Cost in millionths of a US dollar, computed from the model's price when the call ran.
  cost_micro_usd bigint NOT NULL DEFAULT 0 CHECK (cost_micro_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_profile_time_idx ON public.ai_usage (profile_id, created_at);
CREATE INDEX ai_usage_group_time_idx ON public.ai_usage (group_id, created_at);

ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage FORCE ROW LEVEL SECURITY;

-- Clients may only read their own rows; writes come from the service role only.
REVOKE ALL ON TABLE public.ai_usage FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.ai_usage TO authenticated;
GRANT SELECT, INSERT ON TABLE public.ai_usage TO service_role;

CREATE POLICY ai_usage_select_own ON public.ai_usage
  FOR SELECT TO authenticated
  USING (profile_id = (SELECT ir007_private.current_profile_id()));

-- The caller's running totals, for Profile (their rows only, via RLS).
CREATE FUNCTION public.get_my_ai_usage()
RETURNS TABLE (total_tokens bigint, cost_micro_usd bigint, calls bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT
    coalesce(sum(usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_write_tokens), 0)::bigint,
    coalesce(sum(usage.cost_micro_usd), 0)::bigint,
    count(*)::bigint
  -- SECURITY INVOKER: the select policy already limits this to the caller's own rows.
  FROM public.ai_usage AS usage;
$$;
REVOKE ALL ON FUNCTION public.get_my_ai_usage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_ai_usage() TO authenticated;

COMMIT;
