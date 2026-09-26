CREATE TABLE "app"."audit_events" (
	"id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"hash_version" smallint NOT NULL,
	"prev_hash" "bytea" NOT NULL,
	"hash" "bytea" NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_ids" uuid[] NOT NULL,
	"purpose" text NOT NULL,
	"request_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "audit_events_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "audit_events_org_id_seq_unique" UNIQUE("org_id","seq"),
	CONSTRAINT "audit_events_seq_positive" CHECK ("app"."audit_events"."seq" >= 1),
	CONSTRAINT "audit_events_prev_hash_len" CHECK (octet_length("app"."audit_events"."prev_hash") = 32),
	CONSTRAINT "audit_events_hash_len" CHECK (octet_length("app"."audit_events"."hash") = 32),
	CONSTRAINT "audit_events_actor" CHECK ("app"."audit_events"."actor_kind" in ('user', 'support', 'system')
          and (
            ("app"."audit_events"."actor_kind" = 'system' and "app"."audit_events"."actor_id" is null)
            or ("app"."audit_events"."actor_kind" in ('user', 'support') and "app"."audit_events"."actor_id" is not null)
          )),
	CONSTRAINT "audit_events_action" CHECK ("app"."audit_events"."action" ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
	CONSTRAINT "audit_events_purpose" CHECK ("app"."audit_events"."purpose" ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
	CONSTRAINT "audit_events_target_ids" CHECK (CASE
  WHEN cardinality("app"."audit_events"."target_ids") = 0 THEN true
  WHEN array_ndims("app"."audit_events"."target_ids") IS DISTINCT FROM 1 THEN false
  ELSE array_position("app"."audit_events"."target_ids", NULL) IS NULL
END)
);
--> statement-breakpoint
ALTER TABLE "app"."audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "audit_events_select" ON "app"."audit_events" AS PERMISSIVE FOR SELECT TO public USING ("app"."audit_events"."org_id" = current_setting('app.org_id')::uuid);--> statement-breakpoint
CREATE POLICY "audit_events_insert" ON "app"."audit_events" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("app"."audit_events"."org_id" = current_setting('app.org_id')::uuid);
--> statement-breakpoint
ALTER TABLE "app"."audit_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE app.audit_events FROM app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.audit_event_hash(
  p_hash_version smallint,
  p_org_id uuid,
  p_id uuid,
  p_seq bigint,
  p_prev_hash bytea,
  p_actor_kind text,
  p_actor_id uuid,
  p_action text,
  p_target_ids uuid[],
  p_purpose text,
  p_request_id uuid,
  p_occurred_at timestamptz
) RETURNS bytea
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, app
AS $$
DECLARE
  preimage bytea;
  field_bytes bytea;
  target_bytes bytea;
  i integer;
  occurred_micros bigint;
BEGIN
  IF p_hash_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'unsupported hash_version: %', p_hash_version;
  END IF;

  preimage := E'\\x01'::bytea;

  field_bytes := uuid_send(p_org_id);
  preimage := preimage || int4send(length(field_bytes)::integer) || field_bytes;

  field_bytes := uuid_send(p_id);
  preimage := preimage || int4send(length(field_bytes)::integer) || field_bytes;

  field_bytes := int8send(p_seq);
  preimage := preimage || int4send(length(field_bytes)::integer) || field_bytes;

  field_bytes := p_prev_hash;
  preimage := preimage || int4send(length(field_bytes)::integer) || field_bytes;

  field_bytes := convert_to(p_actor_kind, 'UTF8');
  preimage := preimage || int4send(length(field_bytes)::integer) || field_bytes;

  IF p_actor_id IS NULL THEN
    field_bytes := ''::bytea;
  ELSE
    field_bytes := uuid_send(p_actor_id);
  END IF;
  preimage := preimage || int4send(length(field_bytes)::integer) || field_bytes;

  field_bytes := convert_to(p_action, 'UTF8');
  preimage := preimage || int4send(length(field_bytes)::integer) || field_bytes;

  target_bytes := ''::bytea;
  IF p_target_ids IS NOT NULL AND COALESCE(cardinality(p_target_ids), 0) > 0 THEN
    IF array_ndims(p_target_ids) IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'audit_event_hash: target_ids must be a one-dimensional uuid array';
    END IF;
    FOR i IN 1..cardinality(p_target_ids) LOOP
      IF p_target_ids[i] IS NULL THEN
        RAISE EXCEPTION 'audit_event_hash: target_ids must not contain null elements';
      END IF;
      target_bytes := target_bytes || uuid_send(p_target_ids[i]);
    END LOOP;
  END IF;
  preimage := preimage || int4send(length(target_bytes)::integer) || target_bytes;

  field_bytes := convert_to(p_purpose, 'UTF8');
  preimage := preimage || int4send(length(field_bytes)::integer) || field_bytes;

  field_bytes := uuid_send(p_request_id);
  preimage := preimage || int4send(length(field_bytes)::integer) || field_bytes;

  occurred_micros := trunc(extract(epoch from p_occurred_at) * 1000000)::bigint;
  field_bytes := int8send(occurred_micros);
  preimage := preimage || int4send(length(field_bytes)::integer) || field_bytes;

  RETURN sha256(preimage);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.audit_event_hash(
  smallint, uuid, uuid, bigint, bytea, text, uuid, text, uuid[], text, uuid, timestamptz
) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.audit_event_hash(
  smallint, uuid, uuid, bigint, bytea, text, uuid, text, uuid[], text, uuid, timestamptz
) TO app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.audit_events_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, app
AS $$
DECLARE
  v_prev_seq bigint;
  v_prev_hash bytea;
BEGIN
  IF NOT (
    CASE
      WHEN cardinality(NEW.target_ids) = 0 THEN true
      WHEN array_ndims(NEW.target_ids) IS DISTINCT FROM 1 THEN false
      ELSE array_position(NEW.target_ids, NULL) IS NULL
    END
  ) THEN
    RAISE SQLSTATE '23514' USING
      MESSAGE = 'new row for relation "audit_events" violates check constraint "audit_events_target_ids"',
      CONSTRAINT = 'audit_events_target_ids',
      TABLE = 'audit_events',
      SCHEMA = 'app';
  END IF;

  NEW.org_id := current_setting('app.org_id')::uuid;
  NEW.hash_version := 1;

  SELECT seq, hash INTO v_prev_seq, v_prev_hash
  FROM app.audit_events
  WHERE org_id = current_setting('app.org_id')::uuid
  ORDER BY seq DESC
  LIMIT 1;

  NEW.seq := CASE WHEN v_prev_seq IS NULL THEN 1 ELSE v_prev_seq + 1 END;
  NEW.prev_hash := CASE
    WHEN v_prev_hash IS NULL THEN decode(repeat('00', 32), 'hex')
    ELSE v_prev_hash
  END;

  NEW.occurred_at := clock_timestamp();

  NEW.hash := app.audit_event_hash(
    NEW.hash_version,
    NEW.org_id,
    NEW.id,
    NEW.seq,
    NEW.prev_hash,
    NEW.actor_kind,
    NEW.actor_id,
    NEW.action,
    NEW.target_ids,
    NEW.purpose,
    NEW.request_id,
    NEW.occurred_at
  );

  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.audit_events_before_insert() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.audit_events_before_insert() TO app;
--> statement-breakpoint
CREATE TRIGGER audit_events_before_insert
  BEFORE INSERT ON app.audit_events
  FOR EACH ROW
  EXECUTE FUNCTION app.audit_events_before_insert();