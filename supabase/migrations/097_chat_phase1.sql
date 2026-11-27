-- Chat, Phase 1 (docs/CHAT-PLAN.md §5): replies, reactions, mentions, private
-- read state, Web Push subscriptions, per-Trip notification settings, and the
-- server side of push: a trigger that hands every new message to the
-- `send-chat-push` Edge Function, and a pg_cron tick that sends collapsed
-- summaries once a recipient's cool-down has passed.
--
-- Push wiring. Both the message trigger and the tick call the function through
-- pg_net (asynchronous: the request is queued in the sender's transaction and
-- sent by pg_net's worker after it commits, so posting a message never waits
-- for it and a rolled-back message never notifies). The function's URL and a
-- shared secret live in Supabase Vault as `chat_push_url` and
-- `chat_push_secret`; while either is missing nothing is called. The function
-- checks the secret (header `x-chat-push-secret`) against its CHAT_PUSH_SECRET.
--
-- Read state is private: each person reads and writes only their own row, and
-- nothing exposes another person's (no "seen by", no "last seen").
BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

-- ─── Messages: replies, mentions, groundwork ────────────────────────────────
ALTER TABLE public.trip_messages
  ADD CONSTRAINT trip_messages_group_id_id_key UNIQUE (group_id, id);

ALTER TABLE public.trip_messages
  ADD COLUMN reply_to uuid,
  -- Resolved mentions: active Members of this Trip (checked below), sorted, no repeats.
  ADD COLUMN mentions uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN mentions_everyone boolean NOT NULL DEFAULT false,
  -- Phase 2 groundwork (cards, edit, unsend): set by no one yet.
  ADD COLUMN kind text NOT NULL DEFAULT 'text' CHECK (kind IN ('text')),
  ADD COLUMN ref_type text,
  ADD COLUMN ref_id uuid,
  ADD COLUMN edited_at timestamptz,
  ADD COLUMN deleted_at timestamptz,
  ADD CONSTRAINT trip_messages_ref_pair CHECK ((ref_type IS NULL) = (ref_id IS NULL)),
  ADD CONSTRAINT trip_messages_mentions_size CHECK (cardinality(mentions) <= 50),
  -- A reply quotes a message of the same Trip; if that message is ever deleted the reply stays, unquoted.
  ADD CONSTRAINT trip_messages_reply_same_group FOREIGN KEY (group_id, reply_to)
    REFERENCES public.trip_messages (group_id, id) ON DELETE SET NULL (reply_to);
CREATE INDEX trip_messages_reply_to_idx ON public.trip_messages (reply_to) WHERE reply_to IS NOT NULL;
CREATE INDEX trip_messages_everyone_idx ON public.trip_messages (group_id, sender_id, created_at DESC) WHERE mentions_everyone;

GRANT INSERT (reply_to, mentions, mentions_everyone) ON TABLE public.trip_messages TO authenticated;

-- Mentions name active Members of the message's Trip (stored sorted and unique,
-- so pushes read them as is). @everyone is open to every Member, once an hour
-- per person per Trip. The advisory lock makes two simultaneous @everyone sends
-- from one person queue up, so the second sees the first.
CREATE FUNCTION trip_private.trip_messages_check_mentions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.mentions := coalesce((
    SELECT array_agg(DISTINCT mention ORDER BY mention) FROM unnest(NEW.mentions) AS mention WHERE mention IS NOT NULL
  ), '{}');
  IF EXISTS (
    SELECT 1 FROM unnest(NEW.mentions) AS mention
    WHERE NOT EXISTS (
      SELECT 1 FROM public.group_members AS member
      WHERE member.id = mention AND member.group_id = NEW.group_id AND member.status = 'active'
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'mention_not_member';
  END IF;

  IF NEW.mentions_everyone THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('rove:everyone:' || NEW.group_id::text || ':' || NEW.sender_id::text, 0));
    IF EXISTS (
      SELECT 1 FROM public.trip_messages AS earlier
      WHERE earlier.group_id = NEW.group_id AND earlier.sender_id = NEW.sender_id
        AND earlier.mentions_everyone AND earlier.created_at > now() - interval '1 hour'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'everyone_rate_limited';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION trip_private.trip_messages_check_mentions() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trip_messages_check_mentions
  BEFORE INSERT ON public.trip_messages
  FOR EACH ROW EXECUTE FUNCTION trip_private.trip_messages_check_mentions();

-- ─── Reactions (tapbacks) ───────────────────────────────────────────────────
-- One row per (message, member, emoji); toggled by inserting and deleting your
-- own rows. group_id is part of the key so Realtime DELETE events (which carry
-- only the key under RLS) still say which Trip they belong to.
CREATE TABLE public.trip_message_reactions (
  group_id uuid NOT NULL,
  message_id uuid NOT NULL,
  member_id uuid NOT NULL,
  emoji text NOT NULL CHECK (emoji IN ('👍', '❤️', '😂', '😮', '😢', '🙏', '✅')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, message_id, member_id, emoji),
  FOREIGN KEY (group_id, message_id) REFERENCES public.trip_messages (group_id, id) ON DELETE CASCADE,
  FOREIGN KEY (group_id, member_id) REFERENCES public.group_members (group_id, id) ON DELETE RESTRICT
);
CREATE INDEX trip_message_reactions_message_idx ON public.trip_message_reactions (message_id);

ALTER TABLE public.trip_message_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_message_reactions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.trip_message_reactions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, DELETE ON TABLE public.trip_message_reactions TO authenticated;
GRANT INSERT (group_id, message_id, member_id, emoji) ON TABLE public.trip_message_reactions TO authenticated;

CREATE POLICY trip_message_reactions_select_member ON public.trip_message_reactions
  FOR SELECT TO authenticated
  USING (group_id IN (SELECT ir007_private.current_active_group_ids()));
CREATE POLICY trip_message_reactions_insert_own ON public.trip_message_reactions
  FOR INSERT TO authenticated
  WITH CHECK (
    group_id IN (SELECT ir007_private.current_active_group_ids())
    AND member_id = trip_private.current_member_id(group_id)
  );
CREATE POLICY trip_message_reactions_delete_own ON public.trip_message_reactions
  FOR DELETE TO authenticated
  USING (
    group_id IN (SELECT ir007_private.current_active_group_ids())
    AND member_id = trip_private.current_member_id(group_id)
  );

ALTER TABLE public.trip_message_reactions REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.trip_message_reactions;

-- ─── Read state (private) ───────────────────────────────────────────────────
-- "I have read this Trip's chat up to `last_read_at`" (the created_at of the
-- newest message seen). Never moves backwards, never runs ahead of the clock.
CREATE TABLE public.trip_chat_reads (
  group_id uuid NOT NULL,
  member_id uuid NOT NULL,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, member_id),
  FOREIGN KEY (group_id, member_id) REFERENCES public.group_members (group_id, id) ON DELETE CASCADE
);

ALTER TABLE public.trip_chat_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_chat_reads FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.trip_chat_reads FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.trip_chat_reads TO authenticated;
GRANT INSERT (group_id, member_id, last_read_at), UPDATE (last_read_at) ON TABLE public.trip_chat_reads TO authenticated;

CREATE POLICY trip_chat_reads_select_own ON public.trip_chat_reads
  FOR SELECT TO authenticated
  USING (member_id = trip_private.current_member_id(group_id));
CREATE POLICY trip_chat_reads_insert_own ON public.trip_chat_reads
  FOR INSERT TO authenticated
  WITH CHECK (member_id = trip_private.current_member_id(group_id));
CREATE POLICY trip_chat_reads_update_own ON public.trip_chat_reads
  FOR UPDATE TO authenticated
  USING (member_id = trip_private.current_member_id(group_id))
  WITH CHECK (member_id = trip_private.current_member_id(group_id));

CREATE FUNCTION trip_private.trip_chat_reads_clamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.last_read_at := LEAST(NEW.last_read_at, now());
  IF TG_OP = 'UPDATE' THEN
    NEW.last_read_at := GREATEST(OLD.last_read_at, NEW.last_read_at);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION trip_private.trip_chat_reads_clamp() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trip_chat_reads_clamp
  BEFORE INSERT OR UPDATE ON public.trip_chat_reads
  FOR EACH ROW EXECUTE FUNCTION trip_private.trip_chat_reads_clamp();

-- Everyone already in a Trip starts with everything read; people who join later
-- start at the moment they join (trigger below), so a Trip's history is not a
-- wall of unread messages.
INSERT INTO public.trip_chat_reads (group_id, member_id, last_read_at)
SELECT member.group_id, member.id, now() FROM public.group_members AS member WHERE member.status = 'active'
ON CONFLICT DO NOTHING;

CREATE FUNCTION trip_private.trip_chat_reads_on_join()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.status = 'active' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'active') THEN
    INSERT INTO public.trip_chat_reads AS r (group_id, member_id, last_read_at)
    VALUES (NEW.group_id, NEW.id, now())
    ON CONFLICT (group_id, member_id) DO UPDATE SET last_read_at = GREATEST(r.last_read_at, EXCLUDED.last_read_at);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION trip_private.trip_chat_reads_on_join() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER group_members_chat_read_on_join
  AFTER INSERT OR UPDATE OF status ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION trip_private.trip_chat_reads_on_join();

-- Mark this Trip's chat read up to `p_read_at` (the newest message seen).
CREATE FUNCTION public.mark_chat_read(p_group_id uuid, p_read_at timestamptz)
RETURNS timestamptz
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  INSERT INTO public.trip_chat_reads AS r (group_id, member_id, last_read_at)
  VALUES (p_group_id, trip_private.current_member_id(p_group_id), p_read_at)
  ON CONFLICT (group_id, member_id) DO UPDATE SET last_read_at = EXCLUDED.last_read_at
  RETURNING r.last_read_at;
$$;
REVOKE ALL ON FUNCTION public.mark_chat_read(uuid, timestamptz) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.mark_chat_read(uuid, timestamptz) TO authenticated;

-- Unread messages (from others) per active Trip of the caller, capped at 100
-- (the app shows "99+"). SECURITY INVOKER: RLS shows the caller only their own
-- read rows, one per active Trip (every active Member has one, see above), and
-- only the messages of those Trips.
CREATE FUNCTION public.get_my_unread_counts()
RETURNS TABLE (group_id uuid, unread integer)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT read.group_id, (
    SELECT count(*)::integer FROM (
      SELECT 1 FROM public.trip_messages AS message
      WHERE message.group_id = read.group_id
        AND message.sender_id <> read.member_id
        AND message.created_at > read.last_read_at
      LIMIT 100
    ) AS unread_rows
  )
  FROM public.trip_chat_reads AS read;
$$;
REVOKE ALL ON FUNCTION public.get_my_unread_counts() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_unread_counts() TO authenticated;

-- ─── Push subscriptions (one per device and browser) ────────────────────────
CREATE TABLE public.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE CHECK (endpoint ~ '^https://' AND char_length(endpoint) <= 1024),
  p256dh text NOT NULL CHECK (p256dh ~ '^[A-Za-z0-9_-]{80,100}={0,2}$'),
  auth text NOT NULL CHECK (auth ~ '^[A-Za-z0-9_-]{16,32}={0,2}$'),
  user_agent text CHECK (char_length(user_agent) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX push_subscriptions_profile_idx ON public.push_subscriptions (profile_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.push_subscriptions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, DELETE ON TABLE public.push_subscriptions TO authenticated;
GRANT INSERT (profile_id, endpoint, p256dh, auth, user_agent), UPDATE (p256dh, auth, user_agent)
  ON TABLE public.push_subscriptions TO authenticated;

CREATE POLICY push_subscriptions_select_own ON public.push_subscriptions
  FOR SELECT TO authenticated USING (profile_id = (SELECT ir007_private.current_profile_id()));
CREATE POLICY push_subscriptions_insert_own ON public.push_subscriptions
  FOR INSERT TO authenticated WITH CHECK (profile_id = (SELECT ir007_private.current_profile_id()));
CREATE POLICY push_subscriptions_update_own ON public.push_subscriptions
  FOR UPDATE TO authenticated
  USING (profile_id = (SELECT ir007_private.current_profile_id()))
  WITH CHECK (profile_id = (SELECT ir007_private.current_profile_id()));
CREATE POLICY push_subscriptions_delete_own ON public.push_subscriptions
  FOR DELETE TO authenticated USING (profile_id = (SELECT ir007_private.current_profile_id()));

-- Save this device's subscription for the caller. A browser's endpoint belongs
-- to whoever is signed in on it now: if someone else signed in on this device
-- before, their row for this endpoint is replaced (holding the endpoint is the
-- proof), so a shared phone never notifies the previous person.
CREATE FUNCTION public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_profile_id uuid := ir007_private.current_profile_id();
  v_id uuid;
BEGIN
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'not_authorized';
  END IF;
  DELETE FROM public.push_subscriptions WHERE endpoint = p_endpoint AND profile_id <> v_profile_id;
  INSERT INTO public.push_subscriptions AS sub (profile_id, endpoint, p256dh, auth, user_agent)
  VALUES (v_profile_id, p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent
  RETURNING sub.id INTO v_id;
  RETURN v_id;
EXCEPTION
  WHEN check_violation THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_subscription';
END;
$$;
REVOKE ALL ON FUNCTION public.save_push_subscription(text, text, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.save_push_subscription(text, text, text, text) TO authenticated;

-- ─── Per-Trip notification settings ─────────────────────────────────────────
-- No row means 'all' (with bursts collapsed). 'mentions': only mentions and
-- @everyone. 'none': nothing. `muted_until`: until then, like 'mentions'.
CREATE TABLE public.trip_notification_prefs (
  group_id uuid NOT NULL,
  member_id uuid NOT NULL,
  level text NOT NULL DEFAULT 'all' CHECK (level IN ('all', 'mentions', 'none')),
  muted_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, member_id),
  FOREIGN KEY (group_id, member_id) REFERENCES public.group_members (group_id, id) ON DELETE CASCADE
);

ALTER TABLE public.trip_notification_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_notification_prefs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.trip_notification_prefs FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.trip_notification_prefs TO authenticated;
GRANT INSERT (group_id, member_id, level, muted_until), UPDATE (level, muted_until)
  ON TABLE public.trip_notification_prefs TO authenticated;

CREATE POLICY trip_notification_prefs_select_own ON public.trip_notification_prefs
  FOR SELECT TO authenticated USING (member_id = trip_private.current_member_id(group_id));
CREATE POLICY trip_notification_prefs_insert_own ON public.trip_notification_prefs
  FOR INSERT TO authenticated WITH CHECK (member_id = trip_private.current_member_id(group_id));
CREATE POLICY trip_notification_prefs_update_own ON public.trip_notification_prefs
  FOR UPDATE TO authenticated
  USING (member_id = trip_private.current_member_id(group_id))
  WITH CHECK (member_id = trip_private.current_member_id(group_id));

CREATE TRIGGER trip_notification_prefs_set_updated_at
  BEFORE UPDATE ON public.trip_notification_prefs
  FOR EACH ROW EXECUTE FUNCTION public.ir002_set_updated_at();

-- ─── Push state (server only) ───────────────────────────────────────────────
-- Per recipient and Trip: when the last ordinary push went out, and how many
-- messages wait for a collapsed summary (sent at `pending_due_at`).
CREATE TABLE trip_private.chat_push_state (
  group_id uuid NOT NULL,
  member_id uuid NOT NULL,
  last_sent_at timestamptz,
  pending_count integer NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
  pending_due_at timestamptz,
  PRIMARY KEY (group_id, member_id),
  FOREIGN KEY (group_id, member_id) REFERENCES public.group_members (group_id, id) ON DELETE CASCADE
);
CREATE INDEX chat_push_state_due_idx ON trip_private.chat_push_state (pending_due_at) WHERE pending_count > 0;

-- What the function would have sent, when it runs in stub mode (CHAT_PUSH_STUB=1,
-- local stacks and tests only); real sends are not logged. Kept for 7 days.
CREATE TABLE trip_private.chat_push_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  group_id uuid NOT NULL,
  member_id uuid NOT NULL,
  message_id uuid,
  kind text NOT NULL,
  endpoint text NOT NULL,
  payload jsonb NOT NULL
);

ALTER TABLE trip_private.chat_push_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_private.chat_push_state FORCE ROW LEVEL SECURITY;
ALTER TABLE trip_private.chat_push_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_private.chat_push_log FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE trip_private.chat_push_state, trip_private.chat_push_log FROM PUBLIC, anon, authenticated, service_role;

-- Unread messages from others in one Trip for one Member (capped at 100).
CREATE FUNCTION trip_private.chat_unread(p_group_id uuid, p_member_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT count(*)::integer FROM (
    SELECT 1 FROM public.trip_messages AS message
    WHERE message.group_id = p_group_id
      AND message.sender_id <> p_member_id
      AND message.created_at > coalesce(
        (SELECT read.last_read_at FROM public.trip_chat_reads AS read WHERE read.group_id = p_group_id AND read.member_id = p_member_id),
        (SELECT member.created_at FROM public.group_members AS member WHERE member.id = p_member_id))
    LIMIT 100
  ) AS unread_rows;
$$;
REVOKE ALL ON FUNCTION trip_private.chat_unread(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Everything one recipient needs for a push decision: prefs, read and push
-- state, unread counts (this Trip, and all their Trips for the app badge), and
-- their devices.
CREATE FUNCTION trip_private.chat_push_recipient(p_group_id uuid, p_member_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'member_id', member.id,
    'profile_id', member.profile_id,
    'level', coalesce(pref.level, 'all'),
    'muted_until', pref.muted_until,
    'last_read_at', read.last_read_at,
    'last_sent_at', state.last_sent_at,
    'pending_count', coalesce(state.pending_count, 0),
    'pending_due_at', state.pending_due_at,
    'unread_trip', trip_private.chat_unread(p_group_id, member.id),
    'unread_total', (
      SELECT coalesce(sum(trip_private.chat_unread(other.group_id, other.id)), 0)::integer
      FROM public.group_members AS other
      JOIN public.groups AS other_group ON other_group.id = other.group_id
      WHERE other.profile_id = member.profile_id AND other.status = 'active' AND other_group.archived_at IS NULL
    ),
    'subscriptions', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('id', sub.id, 'endpoint', sub.endpoint, 'p256dh', sub.p256dh, 'auth', sub.auth)
        ORDER BY sub.created_at), '[]'::jsonb)
      FROM public.push_subscriptions AS sub WHERE sub.profile_id = member.profile_id
    )
  )
  FROM public.group_members AS member
  LEFT JOIN public.trip_notification_prefs AS pref ON pref.group_id = p_group_id AND pref.member_id = member.id
  LEFT JOIN public.trip_chat_reads AS read ON read.group_id = p_group_id AND read.member_id = member.id
  LEFT JOIN trip_private.chat_push_state AS state ON state.group_id = p_group_id AND state.member_id = member.id
  WHERE member.id = p_member_id AND member.group_id = p_group_id;
$$;
REVOKE ALL ON FUNCTION trip_private.chat_push_recipient(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- For the Edge Function (service role only): one new message, its Trip, and
-- every other active Member who has at least one device subscribed.
CREATE FUNCTION public.chat_push_message_context(p_message_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'message', jsonb_build_object(
      'id', message.id, 'group_id', message.group_id, 'sender_id', message.sender_id, 'body', message.body,
      'mentions', to_jsonb(message.mentions), 'mentions_everyone', message.mentions_everyone, 'created_at', message.created_at,
      'sender_name', coalesce((SELECT profile.display_name FROM public.group_members AS sender
        JOIN public.profiles AS profile ON profile.id = sender.profile_id WHERE sender.id = message.sender_id), 'Someone')),
    'trip', jsonb_build_object('group_id', config.group_id, 'name', config.trip_name, 'timezone', config.timezone),
    'recipients', (
      SELECT coalesce(jsonb_agg(trip_private.chat_push_recipient(message.group_id, member.id)), '[]'::jsonb)
      FROM public.group_members AS member
      WHERE member.group_id = message.group_id AND member.status = 'active' AND member.id <> message.sender_id
        AND EXISTS (SELECT 1 FROM public.push_subscriptions AS sub WHERE sub.profile_id = member.profile_id)
    )
  )
  FROM public.trip_messages AS message
  JOIN public.group_configurations AS config ON config.group_id = message.group_id
  JOIN public.groups AS trip_group ON trip_group.id = message.group_id AND trip_group.archived_at IS NULL
  WHERE message.id = p_message_id;
$$;
REVOKE ALL ON FUNCTION public.chat_push_message_context(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_push_message_context(uuid) TO service_role;

-- For the Edge Function: claim every collapsed summary that is due (a lease of
-- two minutes, so overlapping ticks never send one twice and a crash retries),
-- with the Trip, the newest unread message and the recipient's state.
CREATE FUNCTION public.chat_push_claim_due(p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_result jsonb;
BEGIN
  WITH due AS (
    SELECT state.group_id, state.member_id FROM trip_private.chat_push_state AS state
    WHERE state.pending_count > 0 AND state.pending_due_at <= now()
    ORDER BY state.pending_due_at
    LIMIT greatest(1, least(coalesce(p_limit, 200), 500))
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE trip_private.chat_push_state AS state SET pending_due_at = now() + interval '2 minutes'
    FROM due WHERE state.group_id = due.group_id AND state.member_id = due.member_id
    RETURNING state.group_id, state.member_id, state.pending_count
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'trip', jsonb_build_object('group_id', config.group_id, 'name', config.trip_name, 'timezone', config.timezone),
    'recipient', trip_private.chat_push_recipient(claimed.group_id, claimed.member_id),
    'pending_count', claimed.pending_count,
    'latest', (
      SELECT jsonb_build_object('id', message.id, 'body', message.body, 'created_at', message.created_at,
        'sender_name', coalesce(profile.display_name, 'Someone'))
      FROM public.trip_messages AS message
      LEFT JOIN public.group_members AS sender ON sender.id = message.sender_id
      LEFT JOIN public.profiles AS profile ON profile.id = sender.profile_id
      WHERE message.group_id = claimed.group_id AND message.sender_id <> claimed.member_id
      ORDER BY message.created_at DESC, message.id DESC LIMIT 1
    )
  )), '[]'::jsonb) INTO v_result
  FROM claimed
  JOIN public.group_configurations AS config ON config.group_id = claimed.group_id;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_push_claim_due(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_push_claim_due(integer) TO service_role;

-- For the Edge Function: record what happened per recipient.
--   outcome 'sent'     an ordinary push or summary went out: cool-down starts, nothing pending
--           'mention'  a mention went out: cool-down starts, pending kept
--           'deferred' wait for a summary at `due_at` (the earliest due time is kept)
--           'cleared'  a pending summary is no longer needed
--           'none'     no state change
-- plus `ok` / `gone` subscription ids (gone ones are deleted) and, in stub mode, `log` rows.
CREATE FUNCTION public.chat_push_record(p_entries jsonb)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_entry jsonb;
  v_group uuid;
  v_member uuid;
  v_outcome text;
BEGIN
  IF jsonb_typeof(p_entries) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_request';
  END IF;
  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_entries) LOOP
    v_group := (v_entry->>'group_id')::uuid;
    v_member := (v_entry->>'member_id')::uuid;
    v_outcome := v_entry->>'outcome';
    IF v_outcome = 'sent' THEN
      INSERT INTO trip_private.chat_push_state AS state (group_id, member_id, last_sent_at, pending_count, pending_due_at)
      VALUES (v_group, v_member, now(), 0, NULL)
      ON CONFLICT (group_id, member_id) DO UPDATE SET last_sent_at = now(), pending_count = 0, pending_due_at = NULL;
    ELSIF v_outcome = 'mention' THEN
      INSERT INTO trip_private.chat_push_state AS state (group_id, member_id, last_sent_at)
      VALUES (v_group, v_member, now())
      ON CONFLICT (group_id, member_id) DO UPDATE SET last_sent_at = now();
    ELSIF v_outcome = 'deferred' THEN
      INSERT INTO trip_private.chat_push_state AS state (group_id, member_id, pending_count, pending_due_at)
      VALUES (v_group, v_member, 1, (v_entry->>'due_at')::timestamptz)
      ON CONFLICT (group_id, member_id) DO UPDATE SET pending_count = state.pending_count + 1,
        pending_due_at = coalesce(state.pending_due_at, EXCLUDED.pending_due_at);
    ELSIF v_outcome = 'cleared' THEN
      UPDATE trip_private.chat_push_state SET pending_count = 0, pending_due_at = NULL
      WHERE group_id = v_group AND member_id = v_member;
    ELSIF v_outcome IS DISTINCT FROM 'none' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_request';
    END IF;

    DELETE FROM public.push_subscriptions
    WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(coalesce(v_entry->'gone', '[]'::jsonb)));
    UPDATE public.push_subscriptions SET last_used_at = now()
    WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(coalesce(v_entry->'ok', '[]'::jsonb)));
    INSERT INTO trip_private.chat_push_log (group_id, member_id, message_id, kind, endpoint, payload)
    SELECT v_group, v_member, (log->>'message_id')::uuid, log->>'kind', log->>'endpoint', log->'payload'
    FROM jsonb_array_elements(coalesce(v_entry->'log', '[]'::jsonb)) AS log;
  END LOOP;
  DELETE FROM trip_private.chat_push_log WHERE created_at < now() - interval '7 days';
END;
$$;
REVOKE ALL ON FUNCTION public.chat_push_record(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_push_record(jsonb) TO service_role;

-- ─── Calling the function ───────────────────────────────────────────────────
-- POST `p_body` to the function with the shared secret. Never raises: a push
-- that cannot be queued must not stop a message from being sent.
CREATE FUNCTION trip_private.chat_push_post(p_body jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_url text;
  v_secret text;
BEGIN
  SELECT secret.decrypted_secret INTO v_url FROM vault.decrypted_secrets AS secret WHERE secret.name = 'chat_push_url';
  SELECT secret.decrypted_secret INTO v_secret FROM vault.decrypted_secrets AS secret WHERE secret.name = 'chat_push_secret';
  IF coalesce(v_url, '') = '' OR coalesce(v_secret, '') = '' THEN
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := v_url,
    body := p_body,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-chat-push-secret', v_secret),
    timeout_milliseconds := 30000
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'chat_push_post_failed';
END;
$$;
REVOKE ALL ON FUNCTION trip_private.chat_push_post(jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- After each message: call the function, unless nobody else in the Trip has a device subscribed.
CREATE FUNCTION trip_private.trip_messages_enqueue_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.group_members AS member
    JOIN public.push_subscriptions AS sub ON sub.profile_id = member.profile_id
    WHERE member.group_id = NEW.group_id AND member.status = 'active' AND member.id <> NEW.sender_id
  ) THEN
    PERFORM trip_private.chat_push_post(jsonb_build_object('message_id', NEW.id));
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION trip_private.trip_messages_enqueue_push() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trip_messages_enqueue_push
  AFTER INSERT ON public.trip_messages
  FOR EACH ROW EXECUTE FUNCTION trip_private.trip_messages_enqueue_push();

-- The summary tick (pg_cron, every 20 seconds): call the function only when a
-- summary is due, so an idle app costs one indexed query per tick.
CREATE FUNCTION trip_private.chat_push_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM trip_private.chat_push_state WHERE pending_count > 0 AND pending_due_at <= now()) THEN
    PERFORM trip_private.chat_push_post(jsonb_build_object('flush', true));
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION trip_private.chat_push_tick() FROM PUBLIC, anon, authenticated, service_role;

DO $schedule$
BEGIN
  PERFORM cron.schedule('rove-chat-push-summaries', '20 seconds', 'SELECT trip_private.chat_push_tick()');
  -- pg_cron logs every run; keep two days of history.
  PERFORM cron.schedule('rove-cron-history-cleanup', '17 3 * * *',
    $$DELETE FROM cron.job_run_details WHERE end_time < now() - interval '2 days'$$);
END;
$schedule$;

COMMIT;
