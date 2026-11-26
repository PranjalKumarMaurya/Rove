-- Scanned bills and the date an expense was spent.
-- - trip_expenses.spent_at: when the money was spent (read from a bill, or picked
--   by hand). NULL means not given; the app then shows when it was entered. Bills
--   from before the Trip starts are ordinary expenses with an earlier date.
-- - trip_documents.expense_id: the expense made from a scanned bill, like event_id
--   for bookings. A document is "ready to split" until it has one.
-- - commit_expense and update_expense take p_spent_at; get_split_ledger returns it
--   and lists expenses by when they were spent.
BEGIN;

ALTER TABLE public.trip_expenses
  ADD COLUMN spent_at timestamptz,
  ADD CONSTRAINT trip_expenses_spent_at_plausible CHECK (
    spent_at IS NULL OR (spent_at >= timestamptz '2000-01-01 00:00:00+00' AND spent_at <= created_at + interval '2 days'));
GRANT INSERT (spent_at), UPDATE (spent_at) ON TABLE public.trip_expenses TO authenticated;

ALTER TABLE public.trip_documents
  ADD COLUMN expense_id uuid,
  ADD CONSTRAINT trip_documents_expense_same_group FOREIGN KEY (group_id, expense_id)
    REFERENCES public.trip_expenses(group_id, id) ON DELETE SET NULL (expense_id);
CREATE INDEX trip_documents_group_expense_idx ON public.trip_documents (group_id, expense_id) WHERE expense_id IS NOT NULL;
-- Same rule as event_id: any active member may record what a Trip document became;
-- the foreign key keeps it inside the document's own Trip.
GRANT UPDATE (expense_id) ON TABLE public.trip_documents TO authenticated;

DROP FUNCTION public.commit_expense(uuid, text, text, text, text, jsonb, jsonb, text, text, text, uuid);
CREATE FUNCTION public.commit_expense(
  p_group_id uuid,
  p_description text,
  p_original_amount text,
  p_original_currency text,
  p_split_method text,
  p_payers jsonb,
  p_shares jsonb,
  p_category text DEFAULT NULL,
  p_fx_rate text DEFAULT NULL,
  p_fx_source text DEFAULT NULL,
  p_request_id uuid DEFAULT NULL,
  p_spent_at timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_member uuid := trip_private.current_member_id(p_group_id);
  v_accounting_currency text;
  v_existing record;
  v_amount record;
  v_lines record;
  v_expense_id uuid;
BEGIN
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'split_not_a_member' USING ERRCODE = 'P0001';
  END IF;

  IF p_request_id IS NOT NULL THEN
    SELECT expense.id, expense.created_by INTO v_existing
    FROM public.trip_expenses AS expense
    WHERE expense.group_id = p_group_id AND expense.request_id = p_request_id;
    IF FOUND THEN
      IF v_existing.created_by <> v_member THEN
        RAISE EXCEPTION 'split_request_conflict' USING ERRCODE = 'P0001';
      END IF;
      RETURN v_existing.id;
    END IF;
  END IF;

  SELECT config.accounting_currency INTO v_accounting_currency
  FROM public.group_configurations AS config
  WHERE config.group_id = p_group_id;
  IF v_accounting_currency IS NULL THEN
    RAISE EXCEPTION 'split_not_a_member' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_amount FROM trip_private.split_converted_amount(
    p_original_amount, p_original_currency, v_accounting_currency, p_fx_rate, p_fx_source);
  SELECT * INTO v_lines FROM trip_private.split_checked_lines(
    p_group_id, v_amount.accounting_amount, v_accounting_currency, p_split_method, p_payers, p_shares);

  INSERT INTO public.trip_expenses (group_id, description, category, original_amount, original_currency,
    accounting_amount, accounting_currency, fx_rate, fx_source, split_method, created_by, request_id, spent_at)
  VALUES (p_group_id, trip_private.split_clean_description(p_description),
    trip_private.split_clean_category(p_category), v_amount.original_amount, v_amount.original_currency,
    v_amount.accounting_amount, v_accounting_currency, v_amount.fx_rate, v_amount.fx_source,
    p_split_method, v_member, p_request_id, p_spent_at)
  RETURNING id INTO v_expense_id;

  INSERT INTO public.trip_expense_payers (expense_id, group_id, group_member_id, amount)
  SELECT v_expense_id, p_group_id, line.member_id, line.amount
  FROM unnest(v_lines.payer_ids, v_lines.payer_amounts) AS line(member_id, amount);

  INSERT INTO public.trip_expense_shares (expense_id, group_id, group_member_id, amount, weight)
  SELECT v_expense_id, p_group_id, line.member_id, line.amount, line.weight
  FROM unnest(v_lines.share_ids, v_lines.share_amounts, v_lines.share_weights) AS line(member_id, amount, weight);

  RETURN v_expense_id;
EXCEPTION
  WHEN unique_violation THEN
    -- A concurrent retry with the same request id won the race.
    SELECT expense.id, expense.created_by INTO v_existing
    FROM public.trip_expenses AS expense
    WHERE expense.group_id = p_group_id AND expense.request_id = p_request_id;
    IF FOUND AND v_existing.created_by = v_member THEN
      RETURN v_existing.id;
    END IF;
    RAISE;
END;
$$;

DROP FUNCTION public.update_expense(uuid, integer, text, text, text, text, jsonb, jsonb, text, text, text);
CREATE FUNCTION public.update_expense(
  p_expense_id uuid,
  p_expected_version integer,
  p_description text,
  p_original_amount text,
  p_original_currency text,
  p_split_method text,
  p_payers jsonb,
  p_shares jsonb,
  p_category text DEFAULT NULL,
  p_fx_rate text DEFAULT NULL,
  p_fx_source text DEFAULT NULL,
  p_spent_at timestamptz DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_expense public.trip_expenses;
  v_amount record;
  v_lines record;
  v_version integer;
BEGIN
  v_expense := trip_private.split_editable_expense(p_expense_id, p_expected_version);

  SELECT * INTO v_amount FROM trip_private.split_converted_amount(
    p_original_amount, p_original_currency, v_expense.accounting_currency, p_fx_rate, p_fx_source);
  SELECT * INTO v_lines FROM trip_private.split_checked_lines(
    v_expense.group_id, v_amount.accounting_amount, v_expense.accounting_currency, p_split_method,
    p_payers, p_shares);

  DELETE FROM public.trip_expense_payers AS payer WHERE payer.expense_id = p_expense_id;
  DELETE FROM public.trip_expense_shares AS share WHERE share.expense_id = p_expense_id;

  UPDATE public.trip_expenses AS expense SET
    description = trip_private.split_clean_description(p_description),
    category = trip_private.split_clean_category(p_category),
    original_amount = v_amount.original_amount,
    original_currency = v_amount.original_currency,
    accounting_amount = v_amount.accounting_amount,
    fx_rate = v_amount.fx_rate,
    fx_source = v_amount.fx_source,
    split_method = p_split_method,
    -- Left as it was when an older client sends no date.
    spent_at = coalesce(p_spent_at, expense.spent_at)
  WHERE expense.id = p_expense_id
  RETURNING expense.version INTO v_version;

  INSERT INTO public.trip_expense_payers (expense_id, group_id, group_member_id, amount)
  SELECT p_expense_id, v_expense.group_id, line.member_id, line.amount
  FROM unnest(v_lines.payer_ids, v_lines.payer_amounts) AS line(member_id, amount);

  INSERT INTO public.trip_expense_shares (expense_id, group_id, group_member_id, amount, weight)
  SELECT p_expense_id, v_expense.group_id, line.member_id, line.amount, line.weight
  FROM unnest(v_lines.share_ids, v_lines.share_amounts, v_lines.share_weights) AS line(member_id, amount, weight);

  RETURN v_version;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_split_ledger(p_group_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF trip_private.current_member_id(p_group_id) IS NULL THEN
    RAISE EXCEPTION 'split_not_a_member' USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object(
    'accounting_currency', (
      SELECT config.accounting_currency FROM public.group_configurations AS config
      WHERE config.group_id = p_group_id),
    'expenses', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', expense.id,
        'description', expense.description,
        'category', expense.category,
        'original_amount', expense.original_amount::text,
        'original_currency', expense.original_currency,
        'accounting_amount', expense.accounting_amount::text,
        'accounting_currency', expense.accounting_currency,
        'fx_rate', expense.fx_rate::text,
        'fx_source', expense.fx_source,
        'fx_captured_at', expense.fx_captured_at,
        'split_method', expense.split_method,
        'created_by', expense.created_by,
        'version', expense.version,
        'created_at', expense.created_at,
        'spent_at', expense.spent_at,
        'updated_at', expense.updated_at,
        'payers', coalesce((
          SELECT jsonb_agg(jsonb_build_object('member_id', payer.group_member_id, 'amount', payer.amount::text)
            ORDER BY payer.group_member_id)
          FROM public.trip_expense_payers AS payer WHERE payer.expense_id = expense.id), '[]'::jsonb),
        'shares', coalesce((
          SELECT jsonb_agg(jsonb_build_object('member_id', share.group_member_id, 'amount', share.amount::text,
              'weight', share.weight::text)
            ORDER BY share.group_member_id)
          FROM public.trip_expense_shares AS share WHERE share.expense_id = expense.id), '[]'::jsonb)
      ) ORDER BY coalesce(expense.spent_at, expense.created_at) DESC, expense.id DESC)
      FROM public.trip_expenses AS expense
      WHERE expense.group_id = p_group_id), '[]'::jsonb),
    'settlements', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', settlement.id,
        'from_member', settlement.from_member,
        'to_member', settlement.to_member,
        'amount', settlement.amount::text,
        'currency', settlement.currency,
        'note', settlement.note,
        'recorded_by', settlement.recorded_by,
        'created_at', settlement.created_at
      ) ORDER BY settlement.created_at DESC, settlement.id DESC)
      FROM public.trip_settlements AS settlement
      WHERE settlement.group_id = p_group_id), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION
  public.commit_expense(uuid, text, text, text, text, jsonb, jsonb, text, text, text, uuid, timestamptz),
  public.update_expense(uuid, integer, text, text, text, text, jsonb, jsonb, text, text, text, timestamptz)
FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION
  public.commit_expense(uuid, text, text, text, text, jsonb, jsonb, text, text, text, uuid, timestamptz),
  public.update_expense(uuid, integer, text, text, text, text, jsonb, jsonb, text, text, text, timestamptz)
TO authenticated;

COMMIT;
