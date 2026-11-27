-- Trip chat: plain text messages between the active Members of one Trip, so a
-- crew does not need a separate group chat elsewhere. Append-only for now: no
-- edits, no deletes. Each send carries a client-made id, so a retried send
-- (flaky network, app backgrounded mid-request) never posts twice.
BEGIN;

CREATE TABLE public.trip_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE RESTRICT,
  sender_id uuid NOT NULL,
  -- 1-2000 characters once surrounding whitespace (not just spaces: plain
  -- btrim() strips only ' ') is removed. The app sends the trimmed text.
  body text NOT NULL CHECK (
    char_length(btrim(body, ' ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(160) || chr(8232) || chr(8233) || chr(12288) || chr(65279))) BETWEEN 1 AND 2000
  ),
  client_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One row per send attempt, however often the client retries it.
  CONSTRAINT trip_messages_sender_client_unique UNIQUE (sender_id, client_id),
  -- The sender is always a member of the same Trip as the message.
  CONSTRAINT trip_messages_sender_same_group FOREIGN KEY (group_id, sender_id)
    REFERENCES public.group_members(group_id, id) ON DELETE RESTRICT
);
CREATE INDEX trip_messages_group_created_idx ON public.trip_messages (group_id, created_at DESC);

ALTER TABLE public.trip_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_messages FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.trip_messages FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.trip_messages TO authenticated;
-- id and created_at are always the database's own.
GRANT INSERT (group_id, sender_id, body, client_id) ON TABLE public.trip_messages TO authenticated;

CREATE POLICY trip_messages_select_member ON public.trip_messages
  FOR SELECT TO authenticated
  USING (group_id IN (SELECT ir007_private.current_active_group_ids()));

-- Members post only as themselves.
CREATE POLICY trip_messages_insert_member ON public.trip_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    group_id IN (SELECT ir007_private.current_active_group_ids())
    AND sender_id = trip_private.current_member_id(group_id)
  );

-- Realtime delivers inserts only for rows the subscriber can SELECT under RLS.
-- FULL replica identity keeps `group_id=eq.<id>` filters working for every event
-- type, as for the other Trip tables (migration 031).
ALTER TABLE public.trip_messages REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.trip_messages;

COMMIT;
