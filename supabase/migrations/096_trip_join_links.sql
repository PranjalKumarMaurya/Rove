-- Trip join links: "anyone with the link can join". One active link per Trip,
-- turned on, off or rotated by an Owner, readable (to copy and share again) by
-- every active member, previewed by anyone, and used by any signed-in person
-- with a verified email to join as a 'member'.
--
-- Proof storage. Lookups use `proof_verifier` (sha256 of the 64-hex proof), as
-- invitations do. Unlike an email invitation, a join link must stay copyable by
-- every member after it is created, so the proof itself is kept, but only for the
-- *active* link, in its own table `trip_private.trip_join_link_proofs`: RLS
-- forced, every privilege revoked from anon/authenticated/service_role, readable
-- only by the executor role through `get_trip_join_link` for active members.
-- Revoking or rotating deletes the stored proof, so a dead link's proof exists
-- nowhere. Encrypting it with a key that also lives in this database would add no
-- protection against anyone able to read that table. The proof grants nothing
-- but joining (no Trip data), the people who can read it are already members,
-- and an Owner can rotate it at any time.
--
-- Rate limiting. Not done in SQL: a proof is 256 random bits, so neither
-- `inspect_trip_join_link` nor `join_trip_with_link` can be used to guess one,
-- a failed call rolls back (nothing to count), and anon has no stable identity
-- to count against. Request volume is limited by the API gateway (Supabase).
-- The link deliberately cannot undo a removal: an inactive membership is refused
-- and needs a fresh email invitation.
BEGIN;

CREATE TABLE public.trip_join_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE RESTRICT,
  proof_verifier bytea NOT NULL UNIQUE CHECK (octet_length(proof_verifier) = 32),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (group_id, id),
  FOREIGN KEY (group_id, created_by)
    REFERENCES public.group_members(group_id, id) ON DELETE RESTRICT,
  CONSTRAINT trip_join_links_revoked_after_creation
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE UNIQUE INDEX trip_join_links_one_active_per_group_idx
  ON public.trip_join_links (group_id) WHERE revoked_at IS NULL;

CREATE TABLE trip_private.trip_join_link_proofs (
  link_id uuid PRIMARY KEY REFERENCES public.trip_join_links(id) ON DELETE CASCADE,
  proof text NOT NULL CHECK (proof ~ '^[0-9a-f]{64}$')
);

ALTER TABLE public.trip_join_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_join_links FORCE ROW LEVEL SECURITY;
ALTER TABLE trip_private.trip_join_link_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_private.trip_join_link_proofs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.trip_join_links, trip_private.trip_join_link_proofs
  FROM PUBLIC, anon, authenticated, service_role;

-- Hosted Supabase applies migrations as the non-superuser `postgres`, which can
-- assign ownership only to a role it can SET ROLE to and that may CREATE in the
-- schema. Both grants are revoked before COMMIT. Name `postgres` explicitly:
-- `TO CURRENT_USER` crashes the server under Supabase's supautils extension.
GRANT ir005_invitation_executor TO postgres;
GRANT CREATE ON SCHEMA public TO ir005_invitation_executor;

-- The executor already reads profiles, auth_users, groups, group_members and
-- group_configurations, inserts members and audit rows (migrations 013, 014, 020).
GRANT SELECT (id, group_id, proof_verifier, created_by, created_at, revoked_at),
  INSERT (group_id, proof_verifier, created_by),
  UPDATE (revoked_at)
  ON TABLE public.trip_join_links TO ir005_invitation_executor;
GRANT SELECT, INSERT, DELETE
  ON TABLE trip_private.trip_join_link_proofs TO ir005_invitation_executor;

-- get_trip_join_link ----------------------------------------------------------
CREATE FUNCTION public.trip_join_link_get_impl(p_group_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_auth_user_id uuid := trip_private.auth_uid();
  v_profile_id uuid;
  v_archived_at timestamptz;
  v_proof text;
  v_created_at timestamptz;
BEGIN
  IF v_auth_user_id IS NULL OR p_group_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'not_authorized';
  END IF;

  SELECT profile.id INTO v_profile_id
  FROM public.profiles AS profile
  JOIN trip_private.auth_users AS auth_user ON auth_user.id = profile.auth_user_id
  WHERE profile.auth_user_id = v_auth_user_id
    AND auth_user.email_confirmed_at IS NOT NULL;
  IF v_profile_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.group_members AS member
    WHERE member.group_id = p_group_id
      AND member.profile_id = v_profile_id
      AND member.status = 'active'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'not_authorized';
  END IF;

  SELECT g.archived_at INTO v_archived_at FROM public.groups AS g WHERE g.id = p_group_id;
  IF v_archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('active', false);
  END IF;

  SELECT secret.proof, link.created_at INTO v_proof, v_created_at
  FROM public.trip_join_links AS link
  JOIN trip_private.trip_join_link_proofs AS secret ON secret.link_id = link.id
  WHERE link.group_id = p_group_id AND link.revoked_at IS NULL;
  IF v_proof IS NULL THEN
    RETURN jsonb_build_object('active', false);
  END IF;
  RETURN jsonb_build_object('active', true, 'proof', v_proof, 'created_at', v_created_at);
EXCEPTION
  WHEN SQLSTATE 'P0001' THEN RAISE;
  WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'operation_failed';
END;
$$;

-- set_trip_join_link ----------------------------------------------------------
CREATE FUNCTION public.trip_join_link_set_impl(p_group_id uuid, p_enabled boolean, p_rotate boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_auth_user_id uuid := trip_private.auth_uid();
  v_profile_id uuid;
  v_owner_member_id uuid;
  v_archived_at timestamptz;
  v_active_link_id uuid;
  v_active_proof text;
  v_link_id uuid;
  v_proof text;
  v_outcome text;
BEGIN
  IF v_auth_user_id IS NULL OR p_group_id IS NULL OR p_enabled IS NULL
    OR p_rotate IS NULL OR (p_rotate AND NOT p_enabled)
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_request';
  END IF;

  SELECT profile.id INTO v_profile_id
  FROM public.profiles AS profile
  JOIN trip_private.auth_users AS auth_user ON auth_user.id = profile.auth_user_id
  WHERE profile.auth_user_id = v_auth_user_id
    AND auth_user.email_confirmed_at IS NOT NULL;
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'not_authorized';
  END IF;

  -- Every Group lifecycle operation acquires this lock first.
  SELECT g.archived_at INTO v_archived_at
  FROM public.groups AS g
  WHERE g.id = p_group_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'not_authorized';
  END IF;

  SELECT member.id INTO v_owner_member_id
  FROM public.group_members AS member
  WHERE member.group_id = p_group_id
    AND member.profile_id = v_profile_id
    AND member.role = 'owner'
    AND member.status = 'active';
  IF v_owner_member_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'not_authorized';
  END IF;
  IF v_archived_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'trip_archived';
  END IF;

  SELECT link.id, secret.proof INTO v_active_link_id, v_active_proof
  FROM public.trip_join_links AS link
  LEFT JOIN trip_private.trip_join_link_proofs AS secret ON secret.link_id = link.id
  WHERE link.group_id = p_group_id AND link.revoked_at IS NULL
  FOR UPDATE OF link;

  IF NOT p_enabled THEN
    IF v_active_link_id IS NULL THEN
      RETURN jsonb_build_object('outcome', 'unchanged', 'active', false);
    END IF;
    UPDATE public.trip_join_links AS link SET revoked_at = clock_timestamp()
    WHERE link.id = v_active_link_id;
    DELETE FROM trip_private.trip_join_link_proofs AS secret WHERE secret.link_id = v_active_link_id;
    INSERT INTO public.group_audit_events (
      group_id, actor_group_member_id, event_type, request_id, details, occurred_at
    ) VALUES (
      p_group_id, v_owner_member_id, 'membership_lifecycle', gen_random_uuid(),
      jsonb_build_object('operation', 'join_link_disabled', 'join_link_id', v_active_link_id),
      now()
    );
    RETURN jsonb_build_object('outcome', 'disabled', 'active', false);
  END IF;

  IF v_active_link_id IS NOT NULL AND NOT p_rotate AND v_active_proof IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'active', true, 'proof', v_active_proof);
  END IF;

  v_outcome := 'enabled';
  IF v_active_link_id IS NOT NULL THEN
    v_outcome := 'rotated';
    UPDATE public.trip_join_links AS link SET revoked_at = clock_timestamp()
    WHERE link.id = v_active_link_id;
    DELETE FROM trip_private.trip_join_link_proofs AS secret WHERE secret.link_id = v_active_link_id;
  END IF;

  v_proof := encode(extensions.gen_random_bytes(32), 'hex');
  INSERT INTO public.trip_join_links (group_id, proof_verifier, created_by)
  VALUES (p_group_id, extensions.digest(v_proof, 'sha256'), v_owner_member_id)
  RETURNING id INTO v_link_id;
  INSERT INTO trip_private.trip_join_link_proofs (link_id, proof) VALUES (v_link_id, v_proof);

  INSERT INTO public.group_audit_events (
    group_id, actor_group_member_id, event_type, request_id, details, occurred_at
  ) VALUES (
    p_group_id, v_owner_member_id, 'membership_lifecycle', gen_random_uuid(),
    jsonb_strip_nulls(jsonb_build_object(
      'operation', CASE WHEN v_outcome = 'rotated' THEN 'join_link_rotated' ELSE 'join_link_enabled' END,
      'join_link_id', v_link_id,
      'revoked_join_link_id', v_active_link_id)),
    now()
  );
  RETURN jsonb_build_object('outcome', v_outcome, 'active', true, 'proof', v_proof);
EXCEPTION
  WHEN SQLSTATE 'P0001' THEN RAISE;
  WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'operation_failed';
END;
$$;

-- inspect_trip_join_link ------------------------------------------------------
-- 'closed' covers unknown, malformed and revoked proofs alike, so links can't be
-- probed. Trip details are returned only while the link is active and the Trip
-- is open, and never to someone who was removed.
CREATE FUNCTION public.trip_join_link_inspect_impl(p_proof text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_auth_user_id uuid := trip_private.auth_uid();
  v_group_id uuid;
  v_archived_at timestamptz;
  v_context jsonb;
  v_email_confirmed_at timestamptz;
  v_profile_id uuid;
  v_member_status text;
BEGIN
  IF p_proof IS NULL OR p_proof !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('outcome', 'closed');
  END IF;

  SELECT link.group_id, g.archived_at,
    jsonb_build_object('trip_name', config.trip_name, 'destination', config.destination,
      'start_date', config.start_date, 'end_date', config.end_date)
  INTO v_group_id, v_archived_at, v_context
  FROM public.trip_join_links AS link
  JOIN public.groups AS g ON g.id = link.group_id
  JOIN public.group_configurations AS config ON config.group_id = g.id
  WHERE link.proof_verifier = extensions.digest(p_proof, 'sha256')
    AND link.revoked_at IS NULL;
  IF v_group_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'closed');
  END IF;
  IF v_archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'archived');
  END IF;
  IF v_auth_user_id IS NULL THEN
    RETURN v_context || jsonb_build_object('outcome', 'continue');
  END IF;

  SELECT auth_user.email_confirmed_at, profile.id
  INTO v_email_confirmed_at, v_profile_id
  FROM trip_private.auth_users AS auth_user
  LEFT JOIN public.profiles AS profile ON profile.auth_user_id = auth_user.id
  WHERE auth_user.id = v_auth_user_id;

  IF v_profile_id IS NOT NULL THEN
    SELECT member.status INTO v_member_status
    FROM public.group_members AS member
    WHERE member.group_id = v_group_id AND member.profile_id = v_profile_id;
    IF v_member_status = 'active' THEN
      RETURN v_context || jsonb_build_object('outcome', 'already_member', 'group_id', v_group_id);
    END IF;
    IF v_member_status = 'inactive' THEN
      RETURN jsonb_build_object('outcome', 'removed');
    END IF;
  END IF;
  IF v_email_confirmed_at IS NULL OR v_profile_id IS NULL THEN
    RETURN v_context || jsonb_build_object('outcome', 'verification_required');
  END IF;
  RETURN v_context || jsonb_build_object('outcome', 'ready');
EXCEPTION
  WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'inspection_failed';
END;
$$;

-- join_trip_with_link ---------------------------------------------------------
-- Idempotent without a request table: a retry (or a second tap) finds the active
-- membership and answers 'already_member'. `request_id` keys the audit row.
CREATE FUNCTION public.trip_join_link_join_impl(p_proof text, p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_auth_user_id uuid := trip_private.auth_uid();
  v_email_confirmed_at timestamptz;
  v_profile_id uuid;
  v_link_id uuid;
  v_group_id uuid;
  v_archived_at timestamptz;
  v_member_id uuid;
  v_member_status text;
BEGIN
  IF v_auth_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'not_authorized';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_request';
  END IF;
  IF p_proof IS NULL OR p_proof !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'link_closed';
  END IF;

  SELECT auth_user.email_confirmed_at, profile.id
  INTO v_email_confirmed_at, v_profile_id
  FROM trip_private.auth_users AS auth_user
  LEFT JOIN public.profiles AS profile ON profile.auth_user_id = auth_user.id
  WHERE auth_user.id = v_auth_user_id;
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'not_authorized';
  END IF;
  IF v_email_confirmed_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'verification_required';
  END IF;

  -- Resolve the opaque proof only to find the Group lock; re-read after it.
  SELECT link.group_id INTO v_group_id
  FROM public.trip_join_links AS link
  WHERE link.proof_verifier = extensions.digest(p_proof, 'sha256');
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'link_closed';
  END IF;

  SELECT g.archived_at INTO v_archived_at
  FROM public.groups AS g
  WHERE g.id = v_group_id
  FOR UPDATE;

  SELECT link.id INTO v_link_id
  FROM public.trip_join_links AS link
  WHERE link.group_id = v_group_id
    AND link.proof_verifier = extensions.digest(p_proof, 'sha256')
    AND link.revoked_at IS NULL
  FOR UPDATE;
  IF v_link_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'link_closed';
  END IF;
  IF v_archived_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'trip_archived';
  END IF;

  SELECT member.id, member.status INTO v_member_id, v_member_status
  FROM public.group_members AS member
  WHERE member.group_id = v_group_id AND member.profile_id = v_profile_id
  FOR UPDATE;
  IF v_member_status = 'active' THEN
    RETURN jsonb_build_object('outcome', 'already_member', 'group_id', v_group_id,
      'group_member_id', v_member_id);
  END IF;
  IF v_member_status = 'inactive' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'membership_removed';
  END IF;

  INSERT INTO public.group_members (group_id, profile_id, role, status)
  VALUES (v_group_id, v_profile_id, 'member', 'active')
  RETURNING id INTO v_member_id;

  INSERT INTO public.group_audit_events (
    group_id, actor_group_member_id, event_type, request_id, details, occurred_at
  ) VALUES (
    v_group_id, v_member_id, 'membership_lifecycle', p_request_id,
    jsonb_build_object('operation', 'join_link_joined', 'join_link_id', v_link_id),
    now()
  );

  RETURN jsonb_build_object('outcome', 'joined', 'group_id', v_group_id,
    'group_member_id', v_member_id);
EXCEPTION
  WHEN SQLSTATE 'P0001' THEN RAISE;
  WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'operation_failed';
END;
$$;

ALTER FUNCTION public.trip_join_link_get_impl(uuid) OWNER TO ir005_invitation_executor;
ALTER FUNCTION public.trip_join_link_set_impl(uuid, boolean, boolean) OWNER TO ir005_invitation_executor;
ALTER FUNCTION public.trip_join_link_inspect_impl(text) OWNER TO ir005_invitation_executor;
ALTER FUNCTION public.trip_join_link_join_impl(text, uuid) OWNER TO ir005_invitation_executor;
REVOKE ALL ON FUNCTION public.trip_join_link_get_impl(uuid),
  public.trip_join_link_set_impl(uuid, boolean, boolean),
  public.trip_join_link_inspect_impl(text),
  public.trip_join_link_join_impl(text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Public RPC names (thin SECURITY INVOKER wrappers, like create_invitation).
CREATE FUNCTION public.get_trip_join_link(group_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog
AS $$ SELECT public.trip_join_link_get_impl($1); $$;

CREATE FUNCTION public.set_trip_join_link(group_id uuid, enabled boolean, rotate boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog
AS $$ SELECT public.trip_join_link_set_impl($1, $2, $3); $$;

CREATE FUNCTION public.inspect_trip_join_link(proof text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog
AS $$ SELECT public.trip_join_link_inspect_impl($1); $$;

CREATE FUNCTION public.join_trip_with_link(proof text, request_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog
AS $$ SELECT public.trip_join_link_join_impl($1, $2); $$;

REVOKE ALL ON FUNCTION public.get_trip_join_link(uuid),
  public.set_trip_join_link(uuid, boolean, boolean),
  public.inspect_trip_join_link(text),
  public.join_trip_with_link(text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_trip_join_link(uuid),
  public.trip_join_link_get_impl(uuid),
  public.set_trip_join_link(uuid, boolean, boolean),
  public.trip_join_link_set_impl(uuid, boolean, boolean),
  public.join_trip_with_link(text, uuid),
  public.trip_join_link_join_impl(text, uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.inspect_trip_join_link(text),
  public.trip_join_link_inspect_impl(text)
  TO anon, authenticated;

REVOKE CREATE ON SCHEMA public FROM ir005_invitation_executor;
REVOKE ir005_invitation_executor FROM postgres;

COMMIT;
