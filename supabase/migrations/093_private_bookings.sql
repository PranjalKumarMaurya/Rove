-- Private bookings: an itinerary entry with a "Who's on this" list is visible
-- only to the people on it and to whoever added it. An entry with no list is
-- for everyone, as before. The same rule covers the entry's audience rows, the
-- scanned document it came from and that document's file.
--
-- A scanned document that is not in the itinerary yet is visible only to its
-- uploader, unless it was read as a bill (bills are split with the group and
-- every expense stays visible to the whole Trip).
BEGIN;

-- Whether the caller may see one itinerary entry, given its creator. Owned by
-- `postgres`, which bypasses RLS, so trip_events policies can read the
-- audience without the audience policies reading trip_events back (recursion).
-- It never reads trip_events itself, so it also works for a row being inserted.
CREATE FUNCTION trip_private.can_see_event(p_group_id uuid, p_event_id uuid, p_created_by uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT p_created_by = trip_private.current_member_id(p_group_id)
    OR NOT EXISTS (
      SELECT 1 FROM public.trip_event_audience AS audience
      WHERE audience.group_id = p_group_id AND audience.event_id = p_event_id)
    OR EXISTS (
      SELECT 1 FROM public.trip_event_audience AS audience
      WHERE audience.group_id = p_group_id AND audience.event_id = p_event_id
        AND audience.group_member_id = trip_private.current_member_id(p_group_id));
$$;
REVOKE ALL ON FUNCTION trip_private.can_see_event(uuid, uuid, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION trip_private.can_see_event(uuid, uuid, uuid) TO authenticated;

-- Itinerary entries.
DROP POLICY trip_events_select_member ON public.trip_events;
DROP POLICY trip_events_update_member ON public.trip_events;
DROP POLICY trip_events_delete_member ON public.trip_events;

CREATE POLICY trip_events_select_visible ON public.trip_events
  FOR SELECT TO authenticated
  USING (
    group_id IN (SELECT ir007_private.current_active_group_ids())
    AND trip_private.can_see_event(group_id, id, created_by)
  );

CREATE POLICY trip_events_update_visible ON public.trip_events
  FOR UPDATE TO authenticated
  USING (
    group_id IN (SELECT ir007_private.current_active_group_ids())
    AND trip_private.can_see_event(group_id, id, created_by)
  )
  WITH CHECK (group_id IN (SELECT ir007_private.current_active_group_ids()));

CREATE POLICY trip_events_delete_visible ON public.trip_events
  FOR DELETE TO authenticated
  USING (
    group_id IN (SELECT ir007_private.current_active_group_ids())
    AND trip_private.can_see_event(group_id, id, created_by)
  );

-- Audience rows follow their entry (read through trip_events' own RLS).
DROP POLICY trip_event_audience_select_member ON public.trip_event_audience;
DROP POLICY trip_event_audience_insert_member ON public.trip_event_audience;
DROP POLICY trip_event_audience_delete_member ON public.trip_event_audience;

CREATE POLICY trip_event_audience_select_visible ON public.trip_event_audience
  FOR SELECT TO authenticated
  USING (
    group_id IN (SELECT ir007_private.current_active_group_ids())
    AND EXISTS (SELECT 1 FROM public.trip_events AS event
      WHERE event.group_id = trip_event_audience.group_id AND event.id = trip_event_audience.event_id)
  );

CREATE POLICY trip_event_audience_insert_visible ON public.trip_event_audience
  FOR INSERT TO authenticated
  WITH CHECK (
    group_id IN (SELECT ir007_private.current_active_group_ids())
    AND EXISTS (SELECT 1 FROM public.trip_events AS event
      WHERE event.group_id = trip_event_audience.group_id AND event.id = trip_event_audience.event_id)
  );

CREATE POLICY trip_event_audience_delete_visible ON public.trip_event_audience
  FOR DELETE TO authenticated
  USING (
    group_id IN (SELECT ir007_private.current_active_group_ids())
    AND EXISTS (SELECT 1 FROM public.trip_events AS event
      WHERE event.group_id = trip_event_audience.group_id AND event.id = trip_event_audience.event_id)
  );

-- Replace an entry's audience. New people are added before old ones are
-- removed, so the entry never passes through "everyone" on the way, and a
-- caller who takes themselves off still finishes the change.
CREATE OR REPLACE FUNCTION public.set_trip_event_audience(p_group_id uuid, p_event_id uuid, p_member_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.trip_events AS event
    WHERE event.group_id = p_group_id AND event.id = p_event_id
  ) THEN
    RAISE EXCEPTION 'trip_event_not_found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.trip_event_audience (group_id, event_id, group_member_id)
  SELECT DISTINCT p_group_id, p_event_id, wanted.member_id
  FROM unnest(COALESCE(p_member_ids, '{}'::uuid[])) AS wanted(member_id)
  WHERE wanted.member_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.trip_event_audience AS existing
      WHERE existing.event_id = p_event_id AND existing.group_member_id = wanted.member_id
    );

  DELETE FROM public.trip_event_audience AS audience
  WHERE audience.group_id = p_group_id
    AND audience.event_id = p_event_id
    AND NOT (audience.group_member_id = ANY (COALESCE(p_member_ids, '{}'::uuid[])));
END;
$$;

-- Scanned documents.
DROP POLICY trip_documents_select_member ON public.trip_documents;
DROP POLICY trip_documents_update_member ON public.trip_documents;

CREATE POLICY trip_documents_select_visible ON public.trip_documents
  FOR SELECT TO authenticated
  USING (
    group_id IN (SELECT ir007_private.current_active_group_ids())
    AND (
      uploaded_by = trip_private.current_member_id(group_id)
      OR (event_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.trip_events AS event
        WHERE event.group_id = trip_documents.group_id AND event.id = trip_documents.event_id))
      OR (event_id IS NULL AND extracted ->> 'kind' = 'bill')
    )
  );

CREATE POLICY trip_documents_update_visible ON public.trip_documents
  FOR UPDATE TO authenticated
  USING (
    group_id IN (SELECT ir007_private.current_active_group_ids())
    AND (
      uploaded_by = trip_private.current_member_id(group_id)
      OR (event_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.trip_events AS event
        WHERE event.group_id = trip_documents.group_id AND event.id = trip_documents.event_id))
      OR (event_id IS NULL AND extracted ->> 'kind' = 'bill')
    )
  )
  WITH CHECK (group_id IN (SELECT ir007_private.current_active_group_ids()));

-- Files: whoever can see the document's row, plus the uploader of a file whose
-- row does not exist yet (upload comes first, then the row is recorded). The
-- document rule is evaluated by a `postgres`-owned helper: reading
-- trip_documents through RLS here would loop, because recording a document
-- checks storage.objects.
CREATE FUNCTION trip_private.can_see_document_path(p_path text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.trip_documents AS document
    LEFT JOIN public.trip_events AS event
      ON event.group_id = document.group_id AND event.id = document.event_id
    WHERE document.storage_path = p_path
      AND document.group_id IN (SELECT ir007_private.current_active_group_ids())
      AND (
        document.uploaded_by = trip_private.current_member_id(document.group_id)
        OR (event.id IS NOT NULL AND trip_private.can_see_event(event.group_id, event.id, event.created_by))
        OR (document.event_id IS NULL AND document.extracted ->> 'kind' = 'bill')
      )
  );
$$;
REVOKE ALL ON FUNCTION trip_private.can_see_document_path(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION trip_private.can_see_document_path(text) TO authenticated;

DROP POLICY trip_documents_objects_select_member ON storage.objects;

CREATE POLICY trip_documents_objects_select_visible ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'trip-documents'
    AND (storage.foldername(name))[1] IN (
      SELECT active_group_id::text FROM ir007_private.current_active_group_ids() AS active_group_id)
    AND (
      owner_id = (SELECT auth.uid())::text
      OR trip_private.can_see_document_path(name)
    )
  );

-- Adding a scanned booking now takes its audience too, in the same
-- transaction, so it is never briefly visible to the whole Trip.
DROP FUNCTION public.create_event_from_document(uuid, text, text, timestamptz, timestamptz,
  text, text, text, text, text, text, text, text, text);

CREATE FUNCTION public.create_event_from_document(
  p_document_id uuid,
  p_event_type text,
  p_title text,
  p_starts_at timestamptz,
  p_ends_at timestamptz DEFAULT NULL,
  p_location text DEFAULT NULL,
  p_location_to text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_dep_code text DEFAULT NULL,
  p_arr_code text DEFAULT NULL,
  p_flight_no text DEFAULT NULL,
  p_airline text DEFAULT NULL,
  p_terminal text DEFAULT NULL,
  p_booking_ref text DEFAULT NULL,
  p_member_ids uuid[] DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_group_id uuid;
  v_event_id uuid;
BEGIN
  SELECT document.group_id INTO v_group_id
  FROM public.trip_documents AS document
  WHERE document.id = p_document_id AND document.event_id IS NULL
  FOR UPDATE;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'document_unavailable' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.trip_events (group_id, event_type, title, starts_at, ends_at, location, location_to,
    notes, dep_code, arr_code, flight_no, airline, terminal, booking_ref, created_by)
  VALUES (v_group_id, p_event_type, btrim(p_title), p_starts_at, p_ends_at, p_location, p_location_to,
    p_notes, p_dep_code, p_arr_code, p_flight_no, p_airline, p_terminal, p_booking_ref,
    trip_private.current_member_id(v_group_id))
  RETURNING id INTO v_event_id;

  INSERT INTO public.trip_event_audience (group_id, event_id, group_member_id)
  SELECT DISTINCT v_group_id, v_event_id, wanted.member_id
  FROM unnest(COALESCE(p_member_ids, '{}'::uuid[])) AS wanted(member_id)
  WHERE wanted.member_id IS NOT NULL;

  UPDATE public.trip_documents SET event_id = v_event_id WHERE id = p_document_id;
  RETURN v_event_id;
END;
$$;
REVOKE ALL ON FUNCTION public.create_event_from_document(uuid, text, text, timestamptz, timestamptz,
  text, text, text, text, text, text, text, text, text, uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.create_event_from_document(uuid, text, text, timestamptz, timestamptz,
  text, text, text, text, text, text, text, text, text, uuid[]) TO authenticated;

COMMIT;
