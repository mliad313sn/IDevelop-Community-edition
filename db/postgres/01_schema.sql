--
-- PostgreSQL database dump
--


-- Dumped from database version 17.9
-- Dumped by pg_dump version 17.9

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: admin_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.admin_role AS ENUM (
    'superadmin',
    'localadmin',
    'viewer',
    'regional_admin',
    'country_admin',
    'site_admin',
    'hr_bp'
);


--
-- Name: admin_scope_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.admin_scope_type AS ENUM (
    'site',
    'department',
    'service',
    'region',
    'country'
);


--
-- Name: app_setting_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.app_setting_type AS ENUM (
    'string',
    'number',
    'boolean',
    'json'
);


--
-- Name: av_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.av_status AS ENUM (
    'pending',
    'clean',
    'infected',
    'quarantined',
    'scan_error'
);


--
-- Name: bias_alert_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.bias_alert_state AS ENUM (
    'open',
    'reviewed',
    'dismissed'
);


--
-- Name: coach_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.coach_kind AS ENUM (
    'coach',
    'mentor'
);


--
-- Name: coach_signoff_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.coach_signoff_role AS ENUM (
    'employee',
    'manager',
    'coach',
    'hr'
);


--
-- Name: cycle_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.cycle_status AS ENUM (
    'draft',
    'open',
    'locked',
    'closed'
);


--
-- Name: dispute_level; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.dispute_level AS ENUM (
    'L0',
    'L1'
);


--
-- Name: dispute_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.dispute_state AS ENUM (
    'open',
    'resolved',
    'escalated'
);


--
-- Name: dsr_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.dsr_kind AS ENUM (
    'access',
    'rectification',
    'erasure',
    'portability',
    'objection'
);


--
-- Name: dsr_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.dsr_state AS ENUM (
    'received',
    'in_progress',
    'fulfilled',
    'rejected'
);


--
-- Name: idp_action_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.idp_action_type AS ENUM (
    'training',
    'coaching',
    'mentoring',
    'on_the_job',
    'self_study',
    'certification',
    'stretch'
);


--
-- Name: idp_objective_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.idp_objective_state AS ENUM (
    'pending',
    'in_progress',
    'completed',
    'cancelled'
);


--
-- Name: idp_priority; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.idp_priority AS ENUM (
    'low',
    'medium',
    'high',
    'critical'
);


--
-- Name: idp_signoff_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.idp_signoff_role AS ENUM (
    'employee',
    'supervisor'
);


--
-- Name: idp_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.idp_status AS ENUM (
    'draft',
    'active',
    'completed',
    'archived'
);


--
-- Name: lifecycle_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.lifecycle_kind AS ENUM (
    'joiner',
    'mover',
    'leaver'
);


--
-- Name: locked_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.locked_state AS ENUM (
    'provisional',
    'finalized'
);


--
-- Name: mc_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.mc_state AS ENUM (
    'pending',
    'approved',
    'rejected',
    'applied',
    'failed',
    'cancelled'
);


--
-- Name: mfa_user_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.mfa_user_type AS ENUM (
    'admin',
    'employee'
);


--
-- Name: notif_channel; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.notif_channel AS ENUM (
    'inapp',
    'email'
);


--
-- Name: notif_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.notif_state AS ENUM (
    'queued',
    'sent',
    'failed',
    'snoozed'
);


--
-- Name: perf_pot_level; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.perf_pot_level AS ENUM (
    'low',
    'medium',
    'high'
);


--
-- Name: pip_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pip_state AS ENUM (
    'proposed',
    'approved',
    'active',
    'closed_success',
    'closed_failure',
    'cancelled'
);


--
-- Name: placement_source; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.placement_source AS ENUM (
    'auto',
    'override'
);


--
-- Name: report_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.report_type AS ENUM (
    'employees',
    'assessments',
    'readiness',
    'skills',
    'roles',
    'organization',
    'custom'
);


--
-- Name: reviewer_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.reviewer_role AS ENUM (
    'manager',
    'peer',
    'direct_report',
    'hr'
);


--
-- Name: self_assessment_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.self_assessment_state AS ENUM (
    'draft',
    'submitted',
    'reviewed',
    'approved'
);


--
-- Name: supervisor_review_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.supervisor_review_state AS ENUM (
    'pending',
    'completed',
    'disputed'
);


--
-- Name: talent_tier; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.talent_tier AS ENUM (
    'up',
    'mid',
    'low'
);


--
-- Name: training_item_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.training_item_status AS ENUM (
    'pending',
    'in-progress',
    'completed',
    'cancelled'
);


--
-- Name: training_item_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.training_item_type AS ENUM (
    'course',
    'workshop',
    'on-the-job',
    'mentoring',
    'coaching',
    'self-study',
    'certification'
);


--
-- Name: training_plan_priority; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.training_plan_priority AS ENUM (
    'low',
    'medium',
    'high',
    'critical'
);


--
-- Name: training_plan_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.training_plan_status AS ENUM (
    'draft',
    'active',
    'completed',
    'cancelled'
);


--
-- Name: block_mutation; Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.block_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'IMMUTABLE_TABLE: % is append-only', TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
END;
$$;


--
-- Name: fn_classify_assessment_source(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_classify_assessment_source(p_notes text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    WHEN p_notes ILIKE '%approved self-assessment%' THEN 'self_assessment'
    WHEN p_notes ILIKE '%supervisor review%'        THEN 'supervisor_review'
    WHEN p_notes ILIKE '%action close uplift%' OR p_notes ILIKE 'auto:%' THEN 'action_uplift'
    WHEN p_notes ILIKE '%import%'                   THEN 'import'
    ELSE 'manual'
  END;
$$;


--
-- Name: fn_log_skill_assessment_change; Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_log_skill_assessment_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_src   TEXT;
  v_actor TEXT;
  v_cycle BIGINT;
BEGIN
  -- Only record an actual level change (or a brand-new assessment).
  IF TG_OP = 'UPDATE' AND NEW.current_level IS NOT DISTINCT FROM OLD.current_level THEN
    RETURN NEW;
  END IF;

  v_src := fn_classify_assessment_source(NEW.notes);
  v_actor := CASE v_src
      WHEN 'self_assessment'   THEN 'employee'
      WHEN 'supervisor_review' THEN 'supervisor'
      WHEN 'action_uplift'     THEN 'system'
      WHEN 'import'            THEN 'system'
      ELSE 'admin' END;
  SELECT id INTO v_cycle
    FROM assessment_cycles
   WHERE status = 'open'
   ORDER BY opened_at DESC NULLS LAST
   LIMIT 1;

  INSERT INTO assessment_history
      (employee_id, skill_id, previous_level, new_level, assessed_by, assessed_at, notes, source, actor_type, cycle_id)
  VALUES
      (NEW.employee_id, NEW.skill_id,
       CASE WHEN TG_OP = 'UPDATE' THEN OLD.current_level ELSE NULL END,
       NEW.current_level, NEW.assessed_by, COALESCE(NEW.assessed_at, now()),
       NEW.notes, v_src, v_actor, v_cycle);
  RETURN NEW;
END;
$$;


--
-- Name: set_updated_at; Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: action_effectiveness; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.action_effectiveness (
    action_id bigint NOT NULL,
    rating_pre smallint NOT NULL,
    rating_post smallint NOT NULL,
    uplift smallint NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT action_effectiveness_rating_post_check CHECK (((rating_post >= 0) AND (rating_post <= 4))),
    CONSTRAINT action_effectiveness_rating_pre_check CHECK (((rating_pre >= 0) AND (rating_pre <= 4)))
);


--
-- Name: action_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.action_evidence (
    id bigint NOT NULL,
    action_id bigint NOT NULL,
    file_uri text NOT NULL,
    original_name text NOT NULL,
    mime text NOT NULL,
    size_bytes bigint NOT NULL,
    av_status public.av_status DEFAULT 'pending'::public.av_status NOT NULL,
    av_signature text,
    scanned_at timestamp with time zone,
    quarantine_uri text,
    uploaded_by bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: action_evidence_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.action_evidence_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: action_evidence_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.action_evidence_id_seq OWNED BY public.action_evidence.id;


--
-- Name: action_skill_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.action_skill_links (
    action_id bigint NOT NULL,
    skill_id bigint NOT NULL
);


--
-- Name: admin_scopes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_scopes (
    id bigint NOT NULL,
    admin_id bigint NOT NULL,
    scope_type public.admin_scope_type NOT NULL,
    site_id bigint,
    department_id bigint,
    service_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    region_id bigint,
    country_id bigint,
    CONSTRAINT admin_scopes_check CHECK ((((scope_type = 'region'::public.admin_scope_type) AND (region_id IS NOT NULL) AND (country_id IS NULL) AND (site_id IS NULL) AND (department_id IS NULL) AND (service_id IS NULL)) OR ((scope_type = 'country'::public.admin_scope_type) AND (country_id IS NOT NULL) AND (region_id IS NULL) AND (site_id IS NULL) AND (department_id IS NULL) AND (service_id IS NULL)) OR ((scope_type = 'site'::public.admin_scope_type) AND (site_id IS NOT NULL) AND (region_id IS NULL) AND (country_id IS NULL) AND (department_id IS NULL) AND (service_id IS NULL)) OR ((scope_type = 'department'::public.admin_scope_type) AND (department_id IS NOT NULL) AND (region_id IS NULL) AND (country_id IS NULL) AND (site_id IS NULL) AND (service_id IS NULL)) OR ((scope_type = 'service'::public.admin_scope_type) AND (service_id IS NOT NULL) AND (region_id IS NULL) AND (country_id IS NULL) AND (site_id IS NULL) AND (department_id IS NULL))))
);


--
-- Name: admin_scopes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_scopes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_scopes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_scopes_id_seq OWNED BY public.admin_scopes.id;


--
-- Name: admins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admins (
    id bigint NOT NULL,
    username public.citext NOT NULL,
    email public.citext,
    password_hash text NOT NULL,
    role public.admin_role NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    password_changed_at timestamp with time zone,
    force_password_change boolean DEFAULT false NOT NULL,
    locked_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    external_id text,
    auth_provider text
);


--
-- Name: admins_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admins_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admins_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admins_id_seq OWNED BY public.admins.id;


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id bigint NOT NULL,
    label text NOT NULL,
    key_hash text NOT NULL,
    scope text DEFAULT 'powerbi.read'::text NOT NULL,
    created_by bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone
);


--
-- Name: api_keys_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.api_keys_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: api_keys_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.api_keys_id_seq OWNED BY public.api_keys.id;


--
-- Name: app_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_settings (
    id bigint NOT NULL,
    setting_key text NOT NULL,
    setting_value text NOT NULL,
    setting_type public.app_setting_type NOT NULL,
    description text,
    category text DEFAULT 'general'::text NOT NULL,
    updated_by bigint,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: app_settings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.app_settings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: app_settings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.app_settings_id_seq OWNED BY public.app_settings.id;


--
-- Name: assessment_cycles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assessment_cycles (
    id bigint NOT NULL,
    code text NOT NULL,
    label text NOT NULL,
    opened_at timestamp with time zone NOT NULL,
    closes_at timestamp with time zone NOT NULL,
    status public.cycle_status DEFAULT 'draft'::public.cycle_status NOT NULL,
    created_by bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: assessment_cycles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.assessment_cycles_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: assessment_cycles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.assessment_cycles_id_seq OWNED BY public.assessment_cycles.id;


--
-- Name: assessment_disputes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assessment_disputes (
    id bigint NOT NULL,
    supervisor_review_id bigint NOT NULL,
    employee_id bigint NOT NULL,
    level public.dispute_level DEFAULT 'L0'::public.dispute_level NOT NULL,
    state public.dispute_state DEFAULT 'open'::public.dispute_state NOT NULL,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    escalated_at timestamp with time zone,
    resolved_at timestamp with time zone,
    final_level public.dispute_level,
    decided_by bigint,
    decided_rating smallint,
    reason text NOT NULL,
    CONSTRAINT assessment_disputes_decided_rating_check CHECK (((decided_rating IS NULL) OR ((decided_rating >= 0) AND (decided_rating <= 4))))
);


--
-- Name: assessment_disputes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.assessment_disputes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: assessment_disputes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.assessment_disputes_id_seq OWNED BY public.assessment_disputes.id;


--
-- Name: assessment_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assessment_evidence (
    id bigint NOT NULL,
    self_assessment_id bigint NOT NULL,
    file_uri text NOT NULL,
    original_name text NOT NULL,
    mime text NOT NULL,
    size_bytes bigint NOT NULL,
    av_status public.av_status DEFAULT 'pending'::public.av_status NOT NULL,
    av_signature text,
    scanned_at timestamp with time zone,
    quarantine_uri text,
    submit_locked_at timestamp with time zone,
    uploaded_by bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: assessment_evidence_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.assessment_evidence_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: assessment_evidence_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.assessment_evidence_id_seq OWNED BY public.assessment_evidence.id;


--
-- Name: assessment_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assessment_history (
    id bigint NOT NULL,
    employee_id bigint NOT NULL,
    skill_id bigint NOT NULL,
    previous_level smallint,
    new_level smallint NOT NULL,
    assessed_by bigint NOT NULL,
    assessed_at timestamp with time zone DEFAULT now() NOT NULL,
    notes text,
    source text,
    actor_type text,
    cycle_id bigint,
    self_assessment_id bigint,
    CONSTRAINT assessment_history_new_level_check CHECK (((new_level >= 0) AND (new_level <= 4))),
    CONSTRAINT assessment_history_previous_level_check CHECK (((previous_level IS NULL) OR ((previous_level >= 0) AND (previous_level <= 4))))
);


--
-- Name: assessment_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.assessment_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: assessment_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.assessment_history_id_seq OWNED BY public.assessment_history.id;


--
-- Name: bias_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bias_alerts (
    id bigint NOT NULL,
    cycle_id bigint NOT NULL,
    group_dim text NOT NULL,
    group_value text NOT NULL,
    z_score numeric(5,3) NOT NULL,
    raised_at timestamp with time zone DEFAULT now() NOT NULL,
    state public.bias_alert_state DEFAULT 'open'::public.bias_alert_state NOT NULL,
    notes text
);


--
-- Name: bias_alerts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bias_alerts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bias_alerts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bias_alerts_id_seq OWNED BY public.bias_alerts.id;


--
-- Name: check_in_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.check_in_items (
    id bigint NOT NULL,
    check_in_id bigint NOT NULL,
    body text NOT NULL,
    is_action boolean DEFAULT false NOT NULL,
    done boolean DEFAULT false NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: check_in_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.check_in_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: check_in_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.check_in_items_id_seq OWNED BY public.check_in_items.id;


--
-- Name: check_ins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.check_ins (
    id bigint NOT NULL,
    employee_id bigint NOT NULL,
    manager_id bigint,
    kind text DEFAULT 'one_on_one'::text NOT NULL,
    title text,
    scheduled_at timestamp with time zone,
    occurred_at timestamp with time zone,
    status text DEFAULT 'scheduled'::text NOT NULL,
    shared_notes text,
    sentiment smallint,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT check_ins_kind_check CHECK ((kind = ANY (ARRAY['one_on_one'::text, 'feedback'::text, 'pulse'::text]))),
    CONSTRAINT check_ins_sentiment_check CHECK (((sentiment >= 1) AND (sentiment <= 5))),
    CONSTRAINT check_ins_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'completed'::text, 'cancelled'::text])))
);


--
-- Name: check_ins_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.check_ins_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: check_ins_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.check_ins_id_seq OWNED BY public.check_ins.id;


--
-- Name: coaching_grow; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coaching_grow (
    session_id bigint NOT NULL,
    goal text,
    reality text,
    options text,
    way_forward text
);


--
-- Name: coaching_objectives; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coaching_objectives (
    id bigint NOT NULL,
    session_id bigint NOT NULL,
    smart_text text NOT NULL,
    due_on date,
    state public.idp_objective_state DEFAULT 'pending'::public.idp_objective_state NOT NULL,
    carry_forward_of bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: coaching_objectives_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.coaching_objectives_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: coaching_objectives_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.coaching_objectives_id_seq OWNED BY public.coaching_objectives.id;


--
-- Name: coaching_plan_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coaching_plan_actions (
    id bigint NOT NULL,
    plan_id bigint NOT NULL,
    description text NOT NULL,
    due_on date,
    status text DEFAULT 'pending'::text NOT NULL,
    progress_note text,
    acknowledged_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT coaching_plan_actions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'done'::text])))
);


--
-- Name: coaching_plan_actions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.coaching_plan_actions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: coaching_plan_actions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.coaching_plan_actions_id_seq OWNED BY public.coaching_plan_actions.id;


--
-- Name: coaching_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coaching_plans (
    id bigint NOT NULL,
    employee_id bigint NOT NULL,
    created_by bigint,
    mentor_id bigint,
    kind text NOT NULL,
    title text NOT NULL,
    objective text,
    expected_outcome text,
    target_date date,
    state text DEFAULT 'draft'::text NOT NULL,
    progress smallint DEFAULT 0 NOT NULL,
    validated_by bigint,
    validated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    context_type text,
    idp_id bigint,
    pip_id bigint,
    skill_id bigint,
    CONSTRAINT chk_coaching_plans_context CHECK (((context_type IS NULL) OR ((context_type = ANY (ARRAY['idp'::text, 'pip'::text, 'skill_gap'::text])) AND ((context_type <> 'idp'::text) OR (idp_id IS NOT NULL)) AND ((context_type <> 'pip'::text) OR (pip_id IS NOT NULL)) AND ((context_type <> 'skill_gap'::text) OR (skill_id IS NOT NULL))))),
    CONSTRAINT coaching_plans_kind_check CHECK ((kind = ANY (ARRAY['coaching'::text, 'mentoring'::text]))),
    CONSTRAINT coaching_plans_progress_check CHECK (((progress >= 0) AND (progress <= 100))),
    CONSTRAINT coaching_plans_state_check CHECK ((state = ANY (ARRAY['draft'::text, 'active'::text, 'completed'::text, 'cancelled'::text])))
);


--
-- Name: coaching_plans_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.coaching_plans_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: coaching_plans_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.coaching_plans_id_seq OWNED BY public.coaching_plans.id;


--
-- Name: coaching_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coaching_sessions (
    id bigint NOT NULL,
    employee_id bigint NOT NULL,
    coach_id bigint NOT NULL,
    kind public.coach_kind NOT NULL,
    session_at timestamp with time zone NOT NULL,
    agenda text,
    notes_uri text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    plan_id bigint,
    context_type text,
    idp_id bigint,
    pip_id bigint,
    skill_id bigint,
    CONSTRAINT chk_coaching_sessions_context CHECK (((context_type IS NULL) OR ((context_type = ANY (ARRAY['idp'::text, 'pip'::text, 'skill_gap'::text])) AND ((context_type <> 'idp'::text) OR (idp_id IS NOT NULL)) AND ((context_type <> 'pip'::text) OR (pip_id IS NOT NULL)) AND ((context_type <> 'skill_gap'::text) OR (skill_id IS NOT NULL)))))
);


--
-- Name: coaching_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.coaching_sessions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: coaching_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.coaching_sessions_id_seq OWNED BY public.coaching_sessions.id;


--
-- Name: coaching_signoffs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coaching_signoffs (
    session_id bigint NOT NULL,
    role public.coach_signoff_role NOT NULL,
    user_id bigint NOT NULL,
    ip inet NOT NULL,
    ua text,
    signed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: countries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.countries (
    id bigint NOT NULL,
    region_id bigint NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    dsr_sla_days integer DEFAULT 30 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: countries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.countries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: countries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.countries_id_seq OWNED BY public.countries.id;


--
-- Name: departments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.departments (
    id bigint NOT NULL,
    site_id bigint NOT NULL,
    name text NOT NULL,
    code text,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: departments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.departments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: departments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.departments_id_seq OWNED BY public.departments.id;


--
-- Name: domains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.domains (
    id bigint NOT NULL,
    name text NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: domains_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.domains_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: domains_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.domains_id_seq OWNED BY public.domains.id;


--
-- Name: dsr_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dsr_requests (
    id bigint NOT NULL,
    employee_id bigint,
    requested_by text NOT NULL,
    kind public.dsr_kind NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    due_at timestamp with time zone NOT NULL,
    state public.dsr_state DEFAULT 'received'::public.dsr_state NOT NULL,
    fulfilled_at timestamp with time zone,
    notes text
);


--
-- Name: dsr_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dsr_requests_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dsr_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dsr_requests_id_seq OWNED BY public.dsr_requests.id;


--
-- Name: employees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employees (
    id bigint NOT NULL,
    employee_number text NOT NULL,
    first_name text NOT NULL,
    last_name text NOT NULL,
    email public.citext,
    phone text,
    site_id bigint NOT NULL,
    department_id bigint NOT NULL,
    service_id bigint NOT NULL,
    role_id bigint NOT NULL,
    supervisor_id bigint,
    username public.citext,
    password_hash text,
    is_account_active boolean DEFAULT true NOT NULL,
    last_login_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    manager_id bigint,
    is_org_root boolean DEFAULT false NOT NULL,
    manager_type text,
    force_password_change boolean DEFAULT false NOT NULL,
    external_id text,
    auth_provider text,
    CONSTRAINT chk_employees_manager_pair CHECK (((manager_id IS NULL) OR (manager_type IS NOT NULL))),
    CONSTRAINT chk_employees_manager_type CHECK (((manager_type IS NULL) OR (manager_type = ANY (ARRAY['employee'::text, 'admin'::text])))),
    CONSTRAINT chk_employees_not_self_manager CHECK (((manager_id IS NULL) OR (manager_id <> id))),
    CONSTRAINT chk_employees_not_self_supervisor CHECK (((supervisor_id IS NULL) OR (supervisor_id <> id)))
);


--
-- Name: employees_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.employees_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: employees_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.employees_id_seq OWNED BY public.employees.id;


--
-- Name: goals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.goals (
    id bigint NOT NULL,
    employee_id bigint NOT NULL,
    parent_id bigint,
    kind text DEFAULT 'objective'::text NOT NULL,
    title text NOT NULL,
    description text,
    metric_unit text,
    target_value numeric,
    current_value numeric DEFAULT 0 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    period text,
    due_date date,
    created_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT goals_kind_check CHECK ((kind = ANY (ARRAY['objective'::text, 'key_result'::text]))),
    CONSTRAINT goals_status_check CHECK ((status = ANY (ARRAY['active'::text, 'at_risk'::text, 'done'::text, 'cancelled'::text])))
);


--
-- Name: goals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.goals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: goals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.goals_id_seq OWNED BY public.goals.id;


--
-- Name: idp_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idp_actions (
    id bigint NOT NULL,
    idp_id bigint NOT NULL,
    objective_id bigint,
    type public.idp_action_type NOT NULL,
    title text NOT NULL,
    description text,
    status public.idp_objective_state DEFAULT 'pending'::public.idp_objective_state NOT NULL,
    estimated_hours integer,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    completion_notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: idp_actions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.idp_actions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: idp_actions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.idp_actions_id_seq OWNED BY public.idp_actions.id;


--
-- Name: idp_objectives; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idp_objectives (
    id bigint NOT NULL,
    idp_id bigint NOT NULL,
    skill_id bigint,
    smart_text text NOT NULL,
    due_on date,
    priority public.idp_priority DEFAULT 'medium'::public.idp_priority NOT NULL,
    state public.idp_objective_state DEFAULT 'pending'::public.idp_objective_state NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: idp_objectives_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.idp_objectives_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: idp_objectives_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.idp_objectives_id_seq OWNED BY public.idp_objectives.id;


--
-- Name: idp_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idp_plans (
    id bigint NOT NULL,
    employee_id bigint NOT NULL,
    cycle_id bigint,
    status public.idp_status DEFAULT 'draft'::public.idp_status NOT NULL,
    priority public.idp_priority DEFAULT 'medium'::public.idp_priority NOT NULL,
    starts_on date,
    ends_on date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: idp_plans_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.idp_plans_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: idp_plans_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.idp_plans_id_seq OWNED BY public.idp_plans.id;


--
-- Name: idp_signoffs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idp_signoffs (
    id bigint NOT NULL,
    idp_id bigint NOT NULL,
    role public.idp_signoff_role NOT NULL,
    user_id bigint NOT NULL,
    ip inet NOT NULL,
    ua text,
    signed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: idp_signoffs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.idp_signoffs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: idp_signoffs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.idp_signoffs_id_seq OWNED BY public.idp_signoffs.id;


--
-- Name: lifecycle_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lifecycle_events (
    id bigint NOT NULL,
    employee_id bigint NOT NULL,
    kind public.lifecycle_kind NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone
);


--
-- Name: lifecycle_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.lifecycle_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lifecycle_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.lifecycle_events_id_seq OWNED BY public.lifecycle_events.id;


--
-- Name: login_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.login_attempts (
    id bigint NOT NULL,
    username public.citext NOT NULL,
    ip_address inet NOT NULL,
    successful boolean DEFAULT false NOT NULL,
    attempted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: login_attempts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.login_attempts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: login_attempts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.login_attempts_id_seq OWNED BY public.login_attempts.id;


--
-- Name: maker_checker_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maker_checker_requests (
    id bigint NOT NULL,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    maker_id bigint NOT NULL,
    checker_id bigint,
    state public.mc_state DEFAULT 'pending'::public.mc_state NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    applied_at timestamp with time zone,
    error text,
    CONSTRAINT maker_checker_requests_check CHECK ((maker_id <> checker_id))
);


--
-- Name: maker_checker_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.maker_checker_requests_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: maker_checker_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.maker_checker_requests_id_seq OWNED BY public.maker_checker_requests.id;


--
-- Name: mfa_backup_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mfa_backup_codes (
    id bigint NOT NULL,
    user_type public.mfa_user_type NOT NULL,
    user_id bigint NOT NULL,
    code_hash text NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mfa_backup_codes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mfa_backup_codes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mfa_backup_codes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mfa_backup_codes_id_seq OWNED BY public.mfa_backup_codes.id;


--
-- Name: mfa_secrets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mfa_secrets (
    id bigint NOT NULL,
    user_type public.mfa_user_type NOT NULL,
    user_id bigint NOT NULL,
    secret_enc bytea NOT NULL,
    algo text DEFAULT 'SHA1'::text NOT NULL,
    digits smallint DEFAULT 6 NOT NULL,
    period_sec smallint DEFAULT 30 NOT NULL,
    confirmed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mfa_secrets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mfa_secrets_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mfa_secrets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mfa_secrets_id_seq OWNED BY public.mfa_secrets.id;


--
-- Name: nine_box_evaluations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nine_box_evaluations (
    id bigint NOT NULL,
    employee_id bigint NOT NULL,
    cycle_id bigint,
    performance text NOT NULL,
    potential text NOT NULL,
    box smallint NOT NULL,
    box_label text,
    comments text,
    evidence text,
    calibration_notes text,
    status text DEFAULT 'draft'::text NOT NULL,
    clearance text DEFAULT 'confidential'::text NOT NULL,
    created_by bigint,
    submitted_by bigint,
    approved_by bigint,
    approved_at timestamp with time zone,
    rejected_by bigint,
    rejected_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    cell_tier smallint DEFAULT 2 NOT NULL,
    cell_trend text DEFAULT 'stable'::text NOT NULL,
    position_source text DEFAULT 'manager'::text NOT NULL,
    CONSTRAINT chk_nb_cell_tier CHECK (((cell_tier >= 1) AND (cell_tier <= 3))),
    CONSTRAINT chk_nb_cell_trend CHECK ((cell_trend = ANY (ARRAY['up'::text, 'stable'::text, 'down'::text]))),
    CONSTRAINT chk_nb_position_source CHECK ((position_source = ANY (ARRAY['system'::text, 'manager'::text]))),
    CONSTRAINT nine_box_evaluations_box_check CHECK (((box >= 1) AND (box <= 9))),
    CONSTRAINT nine_box_evaluations_clearance_check CHECK ((clearance = ANY (ARRAY['internal'::text, 'confidential'::text, 'restricted'::text]))),
    CONSTRAINT nine_box_evaluations_performance_check CHECK ((performance = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text]))),
    CONSTRAINT nine_box_evaluations_potential_check CHECK ((potential = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text]))),
    CONSTRAINT nine_box_evaluations_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'under_review'::text, 'approved'::text, 'rejected'::text, 'archived'::text])))
);


--
-- Name: nine_box_evaluations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.nine_box_evaluations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: nine_box_evaluations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.nine_box_evaluations_id_seq OWNED BY public.nine_box_evaluations.id;


--
-- Name: nine_box_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nine_box_events (
    id bigint NOT NULL,
    evaluation_id bigint,
    employee_id bigint,
    actor_id bigint,
    actor_type text,
    action text NOT NULL,
    from_status text,
    to_status text,
    detail jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: nine_box_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.nine_box_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: nine_box_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.nine_box_events_id_seq OWNED BY public.nine_box_events.id;


--
-- Name: notification_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_preferences (
    user_type text NOT NULL,
    user_id bigint NOT NULL,
    kind text NOT NULL,
    channel public.notif_channel NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    quiet_hours_start time without time zone,
    quiet_hours_end time without time zone,
    CONSTRAINT notification_preferences_user_type_check CHECK ((user_type = ANY (ARRAY['admin'::text, 'employee'::text])))
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id bigint NOT NULL,
    user_type text NOT NULL,
    user_id bigint NOT NULL,
    channel public.notif_channel NOT NULL,
    kind text NOT NULL,
    locale text DEFAULT 'fr'::text NOT NULL,
    payload jsonb NOT NULL,
    state public.notif_state DEFAULT 'queued'::public.notif_state NOT NULL,
    sent_at timestamp with time zone,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notifications_user_type_check CHECK ((user_type = ANY (ARRAY['admin'::text, 'employee'::text])))
);


--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.notifications_id_seq OWNED BY public.notifications.id;


--
-- Name: password_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_history (
    id bigint NOT NULL,
    admin_id bigint NOT NULL,
    password_hash text NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: password_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.password_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: password_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.password_history_id_seq OWNED BY public.password_history.id;


--
-- Name: pii_cleanup_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pii_cleanup_jobs (
    employee_id bigint NOT NULL,
    country_code text NOT NULL,
    due_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    notes text
);


--
-- Name: pip_milestones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pip_milestones (
    id bigint NOT NULL,
    pip_id bigint NOT NULL,
    description text NOT NULL,
    due_on date NOT NULL,
    met boolean,
    notes text
);


--
-- Name: pip_milestones_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pip_milestones_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pip_milestones_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pip_milestones_id_seq OWNED BY public.pip_milestones.id;


--
-- Name: pips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pips (
    id bigint NOT NULL,
    employee_id bigint NOT NULL,
    initiated_by bigint NOT NULL,
    approved_by bigint,
    state public.pip_state DEFAULT 'proposed'::public.pip_state NOT NULL,
    starts_on date,
    ends_on date,
    summary text NOT NULL,
    outcome text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pips_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pips_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pips_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pips_id_seq OWNED BY public.pips.id;


--
-- Name: readiness_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.readiness_snapshots (
    id bigint NOT NULL,
    employee_id bigint NOT NULL,
    cycle_id bigint,
    pct numeric(5,2) NOT NULL,
    is_ready boolean NOT NULL,
    critical_met integer NOT NULL,
    critical_total integer NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: readiness_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.readiness_snapshots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: readiness_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.readiness_snapshots_id_seq OWNED BY public.readiness_snapshots.id;


--
-- Name: regions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.regions (
    id bigint NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: regions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.regions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: regions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.regions_id_seq OWNED BY public.regions.id;


--
-- Name: report_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_templates (
    id bigint NOT NULL,
    name text NOT NULL,
    description text,
    report_type public.report_type NOT NULL,
    data_source text NOT NULL,
    selected_fields jsonb NOT NULL,
    filters jsonb,
    sorting jsonb,
    group_by jsonb,
    created_by bigint NOT NULL,
    is_public boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: report_templates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.report_templates_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: report_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.report_templates_id_seq OWNED BY public.report_templates.id;


--
-- Name: review_delegations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.review_delegations (
    id bigint NOT NULL,
    grantor_id bigint NOT NULL,
    grantee_id bigint NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT review_delegations_check CHECK ((grantor_id <> grantee_id)),
    CONSTRAINT review_delegations_check1 CHECK ((ends_at > starts_at))
);


--
-- Name: review_delegations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.review_delegations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: review_delegations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.review_delegations_id_seq OWNED BY public.review_delegations.id;


--
-- Name: review_signatures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.review_signatures (
    id bigint NOT NULL,
    review_id bigint NOT NULL,
    user_id bigint NOT NULL,
    ip inet NOT NULL,
    ua text,
    signed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: review_signatures_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.review_signatures_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: review_signatures_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.review_signatures_id_seq OWNED BY public.review_signatures.id;


--
-- Name: role_skill_requirements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_skill_requirements (
    id bigint NOT NULL,
    role_id bigint NOT NULL,
    skill_id bigint NOT NULL,
    required_level smallint NOT NULL,
    is_critical boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT role_skill_requirements_required_level_check CHECK (((required_level >= 0) AND (required_level <= 4)))
);


--
-- Name: role_skill_requirements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.role_skill_requirements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: role_skill_requirements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.role_skill_requirements_id_seq OWNED BY public.role_skill_requirements.id;


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    id bigint NOT NULL,
    name text NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: roles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.roles_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: roles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.roles_id_seq OWNED BY public.roles.id;


--
-- Name: schema_meta; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_meta (
    key text NOT NULL,
    value text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: self_assessment_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.self_assessment_comments (
    id bigint NOT NULL,
    self_assessment_id bigint NOT NULL,
    author_id bigint,
    author_type text NOT NULL,
    body text NOT NULL,
    in_reply_to bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT self_assessment_comments_author_type_check CHECK ((author_type = ANY (ARRAY['employee'::text, 'supervisor'::text, 'manager'::text, 'admin'::text])))
);


--
-- Name: self_assessment_comments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.self_assessment_comments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: self_assessment_comments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.self_assessment_comments_id_seq OWNED BY public.self_assessment_comments.id;


--
-- Name: self_assessment_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.self_assessment_events (
    id bigint NOT NULL,
    self_assessment_id bigint NOT NULL,
    actor_id bigint,
    actor_type text,
    action text NOT NULL,
    from_state text,
    to_state text,
    detail jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: self_assessment_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.self_assessment_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: self_assessment_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.self_assessment_events_id_seq OWNED BY public.self_assessment_events.id;


--
-- Name: self_assessments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.self_assessments (
    id bigint NOT NULL,
    employee_id bigint NOT NULL,
    skill_id bigint NOT NULL,
    self_rated_level smallint NOT NULL,
    status public.self_assessment_state DEFAULT 'draft'::public.self_assessment_state NOT NULL,
    submitted_at timestamp with time zone,
    reviewed_at timestamp with time zone,
    reviewed_by bigint,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    cycle_id bigint,
    justification text,
    locked_state public.locked_state DEFAULT 'provisional'::public.locked_state NOT NULL,
    workflow_state text DEFAULT 'draft'::text NOT NULL,
    approved_by bigint,
    approved_at timestamp with time zone,
    current_reviewer_id bigint,
    CONSTRAINT chk_sa_workflow_state CHECK ((workflow_state = ANY (ARRAY['draft'::text, 'submitted'::text, 'under_review'::text, 'changes_requested'::text, 'reviewed'::text, 'arbitration'::text, 'approved'::text, 'rejected'::text]))),
    CONSTRAINT self_assessments_self_rated_level_check CHECK (((self_rated_level >= 0) AND (self_rated_level <= 4)))
);


--
-- Name: self_assessments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.self_assessments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: self_assessments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.self_assessments_id_seq OWNED BY public.self_assessments.id;


--
-- Name: services; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.services (
    id bigint NOT NULL,
    department_id bigint NOT NULL,
    name text NOT NULL,
    code text,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: services_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.services_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: services_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.services_id_seq OWNED BY public.services.id;


--
-- Name: session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session (
    sid character varying NOT NULL,
    sess json NOT NULL,
    expire timestamp(6) without time zone NOT NULL
);


--
-- Name: sites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sites (
    id bigint NOT NULL,
    name text NOT NULL,
    code text,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    country_id bigint
);


--
-- Name: sites_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sites_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sites_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sites_id_seq OWNED BY public.sites.id;


--
-- Name: skill_assessments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.skill_assessments (
    id bigint NOT NULL,
    employee_id bigint NOT NULL,
    skill_id bigint NOT NULL,
    current_level smallint NOT NULL,
    assessed_by bigint NOT NULL,
    assessed_at timestamp with time zone DEFAULT now() NOT NULL,
    notes text,
    CONSTRAINT skill_assessments_current_level_check CHECK (((current_level >= 0) AND (current_level <= 4)))
);


--
-- Name: skill_assessments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.skill_assessments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: skill_assessments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.skill_assessments_id_seq OWNED BY public.skill_assessments.id;


--
-- Name: skills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.skills (
    id bigint NOT NULL,
    domain_id bigint NOT NULL,
    name text NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    category text DEFAULT 'HardSkills'::text,
    CONSTRAINT skills_category_check CHECK ((category = ANY (ARRAY['Safety'::text, 'Cybersecurity'::text, 'SoftSkills'::text, 'HardSkills'::text])))
);


--
-- Name: skills_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.skills_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: skills_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.skills_id_seq OWNED BY public.skills.id;


--
-- Name: snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.snapshots (
    id bigint NOT NULL,
    name text NOT NULL,
    description text,
    snapshot_data jsonb NOT NULL,
    created_by bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.snapshots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.snapshots_id_seq OWNED BY public.snapshots.id;


--
-- Name: supervisor_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supervisor_reviews (
    id bigint NOT NULL,
    self_assessment_id bigint NOT NULL,
    employee_id bigint NOT NULL,
    skill_id bigint NOT NULL,
    supervisor_rated_level smallint NOT NULL,
    gap integer NOT NULL,
    gap_reason text,
    supervisor_notes text,
    reviewed_by bigint NOT NULL,
    reviewed_at timestamp with time zone DEFAULT now() NOT NULL,
    status public.supervisor_review_state DEFAULT 'pending'::public.supervisor_review_state NOT NULL,
    priority_index numeric(10,4) DEFAULT 0,
    decision text,
    recommendation text,
    decided_at timestamp with time zone,
    CONSTRAINT chk_sr_decision CHECK (((decision IS NULL) OR (decision = ANY (ARRAY['approve'::text, 'reject'::text, 'request_changes'::text])))),
    CONSTRAINT supervisor_reviews_supervisor_rated_level_check CHECK (((supervisor_rated_level >= 0) AND (supervisor_rated_level <= 4)))
);


--
-- Name: supervisor_reviews_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.supervisor_reviews_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: supervisor_reviews_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.supervisor_reviews_id_seq OWNED BY public.supervisor_reviews.id;


--
-- Name: system_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_logs (
    id bigint NOT NULL,
    admin_id bigint,
    action text NOT NULL,
    entity_type text,
    entity_id bigint,
    details jsonb,
    ip_address inet,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: system_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.system_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: system_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.system_logs_id_seq OWNED BY public.system_logs.id;


--
-- Name: talent_placements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.talent_placements (
    employee_id bigint NOT NULL,
    cycle_id bigint NOT NULL,
    box text NOT NULL,
    tier public.talent_tier NOT NULL,
    confidence numeric(4,3),
    source public.placement_source NOT NULL,
    override_reason text,
    placed_by bigint,
    placed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: talent_ratings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.talent_ratings (
    id bigint NOT NULL,
    employee_id bigint NOT NULL,
    reviewer_id bigint NOT NULL,
    reviewer_role public.reviewer_role NOT NULL,
    performance public.perf_pot_level NOT NULL,
    potential public.perf_pot_level NOT NULL,
    cycle_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: talent_ratings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.talent_ratings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: talent_ratings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.talent_ratings_id_seq OWNED BY public.talent_ratings.id;


--
-- Name: training_plan_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.training_plan_items (
    id bigint NOT NULL,
    training_plan_id bigint NOT NULL,
    skill_id bigint NOT NULL,
    current_level smallint NOT NULL,
    target_level smallint NOT NULL,
    training_type public.training_item_type,
    training_method text,
    resource_url text,
    estimated_hours integer,
    status public.training_item_status DEFAULT 'pending'::public.training_item_status NOT NULL,
    completed_at timestamp with time zone,
    completion_notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT training_plan_items_current_level_check CHECK (((current_level >= 0) AND (current_level <= 4))),
    CONSTRAINT training_plan_items_target_level_check CHECK (((target_level >= 0) AND (target_level <= 4)))
);


--
-- Name: training_plan_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.training_plan_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: training_plan_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.training_plan_items_id_seq OWNED BY public.training_plan_items.id;


--
-- Name: training_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.training_plans (
    id bigint NOT NULL,
    employee_id bigint NOT NULL,
    name text NOT NULL,
    description text,
    status public.training_plan_status DEFAULT 'draft'::public.training_plan_status NOT NULL,
    start_date date,
    end_date date,
    priority public.training_plan_priority DEFAULT 'medium'::public.training_plan_priority NOT NULL,
    created_by bigint NOT NULL,
    approved_by bigint,
    approved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: training_plans_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.training_plans_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: training_plans_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.training_plans_id_seq OWNED BY public.training_plans.id;


--
-- Name: v_employee_details; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_employee_details AS
 SELECT e.id AS employee_id,
    e.employee_number,
    e.first_name,
    e.last_name,
    ((e.first_name || ' '::text) || e.last_name) AS full_name,
    e.email,
    e.is_active,
    e.supervisor_id,
    s.id AS site_id,
    s.name AS site_name,
    d.id AS department_id,
    d.name AS department_name,
    sv.id AS service_id,
    sv.name AS service_name,
    r.id AS role_id,
    r.name AS role_name
   FROM ((((public.employees e
     LEFT JOIN public.sites s ON ((s.id = e.site_id)))
     LEFT JOIN public.departments d ON ((d.id = e.department_id)))
     LEFT JOIN public.services sv ON ((sv.id = e.service_id)))
     LEFT JOIN public.roles r ON ((r.id = e.role_id)))
  WHERE (e.is_active = true);


--
-- Name: v_resolved_assessments; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_resolved_assessments AS
 SELECT employee_id,
    skill_id,
    level,
    source,
    assessed_at
   FROM ( SELECT combined.employee_id,
            combined.skill_id,
            combined.current_level AS level,
            'assessment'::text AS source,
            combined.assessed_at,
            row_number() OVER (PARTITION BY combined.employee_id, combined.skill_id ORDER BY combined.assessed_at DESC) AS rn
           FROM ( SELECT skill_assessments.employee_id,
                    skill_assessments.skill_id,
                    skill_assessments.current_level,
                    skill_assessments.assessed_at
                   FROM public.skill_assessments
                UNION ALL
                 SELECT self_assessments.employee_id,
                    self_assessments.skill_id,
                    self_assessments.self_rated_level AS current_level,
                    self_assessments.created_at AS assessed_at
                   FROM public.self_assessments
                  WHERE (self_assessments.status = 'approved'::public.self_assessment_state)) combined) latest
  WHERE (rn = 1);


--
-- Name: v_domain_capability; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_domain_capability AS
 SELECT ra.employee_id,
    s.id AS skill_id,
    s.name AS skill_name,
    d.id AS domain_id,
    d.name AS domain_name,
    COALESCE(s.category, 'HardSkills'::text) AS category,
    ra.level,
    ed.site_id,
    ed.site_name,
    ed.department_id,
    ed.department_name,
    ed.service_id,
    ed.service_name,
    ed.role_id,
    ed.role_name
   FROM (((public.v_resolved_assessments ra
     JOIN public.skills s ON ((s.id = ra.skill_id)))
     JOIN public.domains d ON ((d.id = s.domain_id)))
     JOIN public.v_employee_details ed ON ((ed.employee_id = ra.employee_id)));


--
-- Name: v_employee_skill_gaps; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_employee_skill_gaps AS
 SELECT e.employee_id,
    e.site_id,
    e.site_name,
    e.department_id,
    e.department_name,
    e.service_id,
    e.service_name,
    e.role_id,
    e.role_name,
    s.id AS skill_id,
    s.name AS skill_name,
    dom.id AS domain_id,
    dom.name AS domain_name,
    rsr.required_level,
    COALESCE((ra.level)::integer, 0) AS actual_level,
    (rsr.required_level - COALESCE((ra.level)::integer, 0)) AS gap,
    rsr.is_critical,
        CASE
            WHEN (ra.level IS NOT NULL) THEN 1
            ELSE 0
        END AS is_assessed,
        CASE
            WHEN (COALESCE((ra.level)::integer, 0) >= rsr.required_level) THEN 1
            ELSE 0
        END AS is_met
   FROM ((((public.v_employee_details e
     JOIN public.role_skill_requirements rsr ON ((rsr.role_id = e.role_id)))
     JOIN public.skills s ON ((s.id = rsr.skill_id)))
     JOIN public.domains dom ON ((dom.id = s.domain_id)))
     LEFT JOIN public.v_resolved_assessments ra ON (((ra.employee_id = e.employee_id) AND (ra.skill_id = rsr.skill_id))))
  WHERE (rsr.required_level > 0);


--
-- Name: v_employee_readiness; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_employee_readiness AS
 SELECT e.employee_id,
    e.full_name,
    e.site_id,
    e.site_name,
    e.department_id,
    e.department_name,
    e.service_id,
    e.service_name,
    e.role_id,
    e.role_name,
    count(g.skill_id) AS total_required,
    (sum(g.is_met))::integer AS skills_met,
    (sum(
        CASE
            WHEN (g.gap > 0) THEN g.gap
            ELSE 0
        END))::integer AS total_gap_points,
    (sum(
        CASE
            WHEN g.is_critical THEN 1
            ELSE 0
        END))::integer AS total_critical,
    (sum(
        CASE
            WHEN (g.is_critical AND (g.is_met = 1)) THEN 1
            ELSE 0
        END))::integer AS critical_met,
    (sum(LEAST(g.actual_level, (g.required_level)::integer)))::integer AS points_gained,
    (sum(g.required_level))::integer AS points_required,
        CASE
            WHEN (sum(g.required_level) > 0) THEN round(((100.0 * (sum(LEAST(g.actual_level, (g.required_level)::integer)))::numeric) / (sum(g.required_level))::numeric), 1)
            ELSE NULL::numeric
        END AS readiness,
        CASE
            WHEN ((sum(g.required_level) > 0) AND (((100.0 * (sum(LEAST(g.actual_level, (g.required_level)::integer)))::numeric) / (sum(g.required_level))::numeric) >= (80)::numeric) AND (sum(
            CASE
                WHEN g.is_critical THEN 1
                ELSE 0
            END) = sum(
            CASE
                WHEN (g.is_critical AND (g.is_met = 1)) THEN 1
                ELSE 0
            END))) THEN 1
            ELSE 0
        END AS is_role_ready
   FROM (public.v_employee_details e
     JOIN public.v_employee_skill_gaps g ON ((g.employee_id = e.employee_id)))
  GROUP BY e.employee_id, e.full_name, e.site_id, e.site_name, e.department_id, e.department_name, e.service_id, e.service_name, e.role_id, e.role_name;


--
-- Name: action_evidence id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_evidence ALTER COLUMN id SET DEFAULT nextval('public.action_evidence_id_seq'::regclass);


--
-- Name: admin_scopes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_scopes ALTER COLUMN id SET DEFAULT nextval('public.admin_scopes_id_seq'::regclass);


--
-- Name: admins id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins ALTER COLUMN id SET DEFAULT nextval('public.admins_id_seq'::regclass);


--
-- Name: api_keys id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys ALTER COLUMN id SET DEFAULT nextval('public.api_keys_id_seq'::regclass);


--
-- Name: app_settings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings ALTER COLUMN id SET DEFAULT nextval('public.app_settings_id_seq'::regclass);


--
-- Name: assessment_cycles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_cycles ALTER COLUMN id SET DEFAULT nextval('public.assessment_cycles_id_seq'::regclass);


--
-- Name: assessment_disputes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_disputes ALTER COLUMN id SET DEFAULT nextval('public.assessment_disputes_id_seq'::regclass);


--
-- Name: assessment_evidence id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_evidence ALTER COLUMN id SET DEFAULT nextval('public.assessment_evidence_id_seq'::regclass);


--
-- Name: assessment_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_history ALTER COLUMN id SET DEFAULT nextval('public.assessment_history_id_seq'::regclass);


--
-- Name: bias_alerts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bias_alerts ALTER COLUMN id SET DEFAULT nextval('public.bias_alerts_id_seq'::regclass);


--
-- Name: check_in_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.check_in_items ALTER COLUMN id SET DEFAULT nextval('public.check_in_items_id_seq'::regclass);


--
-- Name: check_ins id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.check_ins ALTER COLUMN id SET DEFAULT nextval('public.check_ins_id_seq'::regclass);


--
-- Name: coaching_objectives id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coaching_objectives ALTER COLUMN id SET DEFAULT nextval('public.coaching_objectives_id_seq'::regclass);


--
-- Name: coaching_plan_actions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coaching_plan_actions ALTER COLUMN id SET DEFAULT nextval('public.coaching_plan_actions_id_seq'::regclass);


--
-- Name: coaching_plans id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coaching_plans ALTER COLUMN id SET DEFAULT nextval('public.coaching_plans_id_seq'::regclass);


--
-- Name: coaching_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coaching_sessions ALTER COLUMN id SET DEFAULT nextval('public.coaching_sessions_id_seq'::regclass);


--
-- Name: countries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.countries ALTER COLUMN id SET DEFAULT nextval('public.countries_id_seq'::regclass);


--
-- Name: departments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments ALTER COLUMN id SET DEFAULT nextval('public.departments_id_seq'::regclass);


--
-- Name: domains id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domains ALTER COLUMN id SET DEFAULT nextval('public.domains_id_seq'::regclass);


--
-- Name: dsr_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dsr_requests ALTER COLUMN id SET DEFAULT nextval('public.dsr_requests_id_seq'::regclass);


--
-- Name: employees id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees ALTER COLUMN id SET DEFAULT nextval('public.employees_id_seq'::regclass);


--
-- Name: goals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goals ALTER COLUMN id SET DEFAULT nextval('public.goals_id_seq'::regclass);


--
-- Name: idp_actions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idp_actions ALTER COLUMN id SET DEFAULT nextval('public.idp_actions_id_seq'::regclass);


--
-- Name: idp_objectives id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idp_objectives ALTER COLUMN id SET DEFAULT nextval('public.idp_objectives_id_seq'::regclass);


--
-- Name: idp_plans id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idp_plans ALTER COLUMN id SET DEFAULT nextval('public.idp_plans_id_seq'::regclass);


--
-- Name: idp_signoffs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idp_signoffs ALTER COLUMN id SET DEFAULT nextval('public.idp_signoffs_id_seq'::regclass);


--
-- Name: lifecycle_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lifecycle_events ALTER COLUMN id SET DEFAULT nextval('public.lifecycle_events_id_seq'::regclass);


--
-- Name: login_attempts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_attempts ALTER COLUMN id SET DEFAULT nextval('public.login_attempts_id_seq'::regclass);


--
-- Name: maker_checker_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maker_checker_requests ALTER COLUMN id SET DEFAULT nextval('public.maker_checker_requests_id_seq'::regclass);


--
-- Name: mfa_backup_codes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfa_backup_codes ALTER COLUMN id SET DEFAULT nextval('public.mfa_backup_codes_id_seq'::regclass);


--
-- Name: mfa_secrets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfa_secrets ALTER COLUMN id SET DEFAULT nextval('public.mfa_secrets_id_seq'::regclass);


--
-- Name: nine_box_evaluations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nine_box_evaluations ALTER COLUMN id SET DEFAULT nextval('public.nine_box_evaluations_id_seq'::regclass);


--
-- Name: nine_box_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nine_box_events ALTER COLUMN id SET DEFAULT nextval('public.nine_box_events_id_seq'::regclass);


--
-- Name: notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications ALTER COLUMN id SET DEFAULT nextval('public.notifications_id_seq'::regclass);


--
-- Name: password_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_history ALTER COLUMN id SET DEFAULT nextval('public.password_history_id_seq'::regclass);


--
-- Name: pip_milestones id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pip_milestones ALTER COLUMN id SET DEFAULT nextval('public.pip_milestones_id_seq'::regclass);


--
-- Name: pips id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pips ALTER COLUMN id SET DEFAULT nextval('public.pips_id_seq'::regclass);


--
-- Name: readiness_snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.readiness_snapshots ALTER COLUMN id SET DEFAULT nextval('public.readiness_snapshots_id_seq'::regclass);


--
-- Name: regions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regions ALTER COLUMN id SET DEFAULT nextval('public.regions_id_seq'::regclass);


--
-- Name: report_templates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_templates ALTER COLUMN id SET DEFAULT nextval('public.report_templates_id_seq'::regclass);


--
-- Name: review_delegations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_delegations ALTER COLUMN id SET DEFAULT nextval('public.review_delegations_id_seq'::regclass);


--
-- Name: review_signatures id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_signatures ALTER COLUMN id SET DEFAULT nextval('public.review_signatures_id_seq'::regclass);


--
-- Name: role_skill_requirements id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_skill_requirements ALTER COLUMN id SET DEFAULT nextval('public.role_skill_requirements_id_seq'::regclass);


--
-- Name: roles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles ALTER COLUMN id SET DEFAULT nextval('public.roles_id_seq'::regclass);


--
-- Name: self_assessment_comments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.self_assessment_comments ALTER COLUMN id SET DEFAULT nextval('public.self_assessment_comments_id_seq'::regclass);


--
-- Name: self_assessment_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.self_assessment_events ALTER COLUMN id SET DEFAULT nextval('public.self_assessment_events_id_seq'::regclass);


--
-- Name: self_assessments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.self_assessments ALTER COLUMN id SET DEFAULT nextval('public.self_assessments_id_seq'::regclass);


--
-- Name: services id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.services ALTER COLUMN id SET DEFAULT nextval('public.services_id_seq'::regclass);


--
-- Name: sites id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sites ALTER COLUMN id SET DEFAULT nextval('public.sites_id_seq'::regclass);


--
-- Name: skill_assessments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_assessments ALTER COLUMN id SET DEFAULT nextval('public.skill_assessments_id_seq'::regclass);


--
-- Name: skills id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skills ALTER COLUMN id SET DEFAULT nextval('public.skills_id_seq'::regclass);


--
-- Name: snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshots ALTER COLUMN id SET DEFAULT nextval('public.snapshots_id_seq'::regclass);


--
-- Name: supervisor_reviews id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_reviews ALTER COLUMN id SET DEFAULT nextval('public.supervisor_reviews_id_seq'::regclass);


--
-- Name: system_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_logs ALTER COLUMN id SET DEFAULT nextval('public.system_logs_id_seq'::regclass);


--
-- Name: talent_ratings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.talent_ratings ALTER COLUMN id SET DEFAULT nextval('public.talent_ratings_id_seq'::regclass);


--
-- Name: training_plan_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_plan_items ALTER COLUMN id SET DEFAULT nextval('public.training_plan_items_id_seq'::regclass);


--
-- Name: training_plans id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_plans ALTER COLUMN id SET DEFAULT nextval('public.training_plans_id_seq'::regclass);


--
-- Name: action_effectiveness action_effectiveness_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_effectiveness
    ADD CONSTRAINT action_effectiveness_pkey PRIMARY KEY (action_id);


--
-- Name: action_evidence action_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_evidence
    ADD CONSTRAINT action_evidence_pkey PRIMARY KEY (id);


--
-- Name: action_skill_links action_skill_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_skill_links
    ADD CONSTRAINT action_skill_links_pkey PRIMARY KEY (action_id, skill_id);


--
-- Name: admin_scopes admin_scopes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_scopes
    ADD CONSTRAINT admin_scopes_pkey PRIMARY KEY (id);


--
-- Name: admins admins_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_email_key UNIQUE (email);


--
-- Name: admins admins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_pkey PRIMARY KEY (id);


--
-- Name: admins admins_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_username_key UNIQUE (username);


--
-- Name: api_keys api_keys_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_key_hash_key UNIQUE (key_hash);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: app_settings app_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (id);


--
-- Name: app_settings app_settings_setting_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_setting_key_key UNIQUE (setting_key);


--
-- Name: assessment_cycles assessment_cycles_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_cycles
    ADD CONSTRAINT assessment_cycles_code_key UNIQUE (code);


--
-- Name: assessment_cycles assessment_cycles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_cycles
    ADD CONSTRAINT assessment_cycles_pkey PRIMARY KEY (id);


--
-- Name: assessment_disputes assessment_disputes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_disputes
    ADD CONSTRAINT assessment_disputes_pkey PRIMARY KEY (id);


--
-- Name: assessment_evidence assessment_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_evidence
    ADD CONSTRAINT assessment_evidence_pkey PRIMARY KEY (id);


--
-- Name: assessment_history assessment_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_history
    ADD CONSTRAINT assessment_history_pkey PRIMARY KEY (id);


--
-- Name: bias_alerts bias_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bias_alerts
    ADD CONSTRAINT bias_alerts_pkey PRIMARY KEY (id);


--
-- Name: check_in_items check_in_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.check_in_items
    ADD CONSTRAINT check_in_items_pkey PRIMARY KEY (id);


--
-- Name: check_ins check_ins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.check_ins
    ADD CONSTRAINT check_ins_pkey PRIMARY KEY (id);


--
-- Name: coaching_grow coaching_grow_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coaching_grow
    ADD CONSTRAINT coaching_grow_pkey PRIMARY KEY (session_id);


--
-- Name: coaching_objectives coaching_objectives_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coaching_objectives
    ADD CONSTRAINT coaching_objectives_pkey PRIMARY KEY (id);


--
-- Name: coaching_plan_actions coaching_plan_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coaching_plan_actions
    ADD CONSTRAINT coaching_plan_actions_pkey PRIMARY KEY (id);


--
-- Name: coaching_plans coaching_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coaching_plans
    ADD CONSTRAINT coaching_plans_pkey PRIMARY KEY (id);


--
-- Name: coaching_sessions coaching_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coaching_sessions
    ADD CONSTRAINT coaching_sessions_pkey PRIMARY KEY (id);


--
-- Name: coaching_signoffs coaching_signoffs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coaching_signoffs
    ADD CONSTRAINT coaching_signoffs_pkey PRIMARY KEY (session_id, role);


--
-- Name: countries countries_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.countries
    ADD CONSTRAINT countries_code_key UNIQUE (code);


--
-- Name: countries countries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.countries
    ADD CONSTRAINT countries_pkey PRIMARY KEY (id);


--
-- Name: departments departments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_pkey PRIMARY KEY (id);


--
-- Name: departments departments_site_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_site_id_name_key UNIQUE (site_id, name);


--
-- Name: domains domains_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domains
    ADD CONSTRAINT domains_name_key UNIQUE (name);


--
-- Name: domains domains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domains
    ADD CONSTRAINT domains_pkey PRIMARY KEY (id);


--
-- Name: dsr_requests dsr_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dsr_requests
    ADD CONSTRAINT dsr_requests_pkey PRIMARY KEY (id);


--
-- Name: employees employees_employee_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_employee_number_key UNIQUE (employee_number);


--
-- Name: employees employees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_pkey PRIMARY KEY (id);


--
-- Name: employees employees_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_username_key UNIQUE (username);


--
-- Name: goals goals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goals
    ADD CONSTRAINT goals_pkey PRIMARY KEY (id);


--
-- Name: idp_actions idp_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idp_actions
    ADD CONSTRAINT idp_actions_pkey PRIMARY KEY (id);


--
-- Name: idp_objectives idp_objectives_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idp_objectives
    ADD CONSTRAINT idp_objectives_pkey PRIMARY KEY (id);


--
-- Name: idp_plans idp_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idp_plans
    ADD CONSTRAINT idp_plans_pkey PRIMARY KEY (id);


--
-- Name: idp_signoffs idp_signoffs_idp_id_role_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idp_signoffs
    ADD CONSTRAINT idp_signoffs_idp_id_role_key UNIQUE (idp_id, role);


--
-- Name: idp_signoffs idp_signoffs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idp_signoffs
    ADD CONSTRAINT idp_signoffs_pkey PRIMARY KEY (id);


--
-- Name: lifecycle_events lifecycle_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lifecycle_events
    ADD CONSTRAINT lifecycle_events_pkey PRIMARY KEY (id);


--
-- Name: login_attempts login_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_attempts
    ADD CONSTRAINT login_attempts_pkey PRIMARY KEY (id);


--
-- Name: maker_checker_requests maker_checker_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maker_checker_requests
    ADD CONSTRAINT maker_checker_requests_pkey PRIMARY KEY (id);


--
-- Name: mfa_backup_codes mfa_backup_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfa_backup_codes
    ADD CONSTRAINT mfa_backup_codes_pkey PRIMARY KEY (id);


--
-- Name: mfa_secrets mfa_secrets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfa_secrets
    ADD CONSTRAINT mfa_secrets_pkey PRIMARY KEY (id);


--
-- Name: mfa_secrets mfa_secrets_user_type_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfa_secrets
    ADD CONSTRAINT mfa_secrets_user_type_user_id_key UNIQUE (user_type, user_id);


--
-- Name: nine_box_evaluations nine_box_evaluations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nine_box_evaluations
    ADD CONSTRAINT nine_box_evaluations_pkey PRIMARY KEY (id);


--
-- Name: nine_box_events nine_box_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nine_box_events
    ADD CONSTRAINT nine_box_events_pkey PRIMARY KEY (id);


--
-- Name: notification_preferences notification_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (user_type, user_id, kind, channel);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: password_history password_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_history
    ADD CONSTRAINT password_history_pkey PRIMARY KEY (id);


--
-- Name: pii_cleanup_jobs pii_cleanup_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pii_cleanup_jobs
    ADD CONSTRAINT pii_cleanup_jobs_pkey PRIMARY KEY (employee_id);


--
-- Name: pip_milestones pip_milestones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pip_milestones
    ADD CONSTRAINT pip_milestones_pkey PRIMARY KEY (id);


--
-- Name: pips pips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pips
    ADD CONSTRAINT pips_pkey PRIMARY KEY (id);


--
-- Name: readiness_snapshots readiness_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.readiness_snapshots
    ADD CONSTRAINT readiness_snapshots_pkey PRIMARY KEY (id);


--
-- Name: regions regions_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regions
    ADD CONSTRAINT regions_code_key UNIQUE (code);


--
-- Name: regions regions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regions
    ADD CONSTRAINT regions_pkey PRIMARY KEY (id);


--
-- Name: report_templates report_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_templates
    ADD CONSTRAINT report_templates_pkey PRIMARY KEY (id);


--
-- Name: review_delegations review_delegations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_delegations
    ADD CONSTRAINT review_delegations_pkey PRIMARY KEY (id);


--
-- Name: review_signatures review_signatures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_signatures
    ADD CONSTRAINT review_signatures_pkey PRIMARY KEY (id);


--
-- Name: role_skill_requirements role_skill_requirements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_skill_requirements
    ADD CONSTRAINT role_skill_requirements_pkey PRIMARY KEY (id);


--
-- Name: role_skill_requirements role_skill_requirements_role_id_skill_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_skill_requirements
    ADD CONSTRAINT role_skill_requirements_role_id_skill_id_key UNIQUE (role_id, skill_id);


--
-- Name: roles roles_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_name_key UNIQUE (name);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: schema_meta schema_meta_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_meta
    ADD CONSTRAINT schema_meta_pkey PRIMARY KEY (key);


--
-- Name: self_assessment_comments self_assessment_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.self_assessment_comments
    ADD CONSTRAINT self_assessment_comments_pkey PRIMARY KEY (id);


--
-- Name: self_assessment_events self_assessment_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.self_assessment_events
    ADD CONSTRAINT self_assessment_events_pkey PRIMARY KEY (id);


--
-- Name: self_assessments self_assessments_employee_id_skill_id_status_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.self_assessments
    ADD CONSTRAINT self_assessments_employee_id_skill_id_status_key UNIQUE (employee_id, skill_id, status);


--
-- Name: self_assessments self_assessments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.self_assessments
    ADD CONSTRAINT self_assessments_pkey PRIMARY KEY (id);


--
-- Name: services services_department_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.services
    ADD CONSTRAINT services_department_id_name_key UNIQUE (department_id, name);


--
-- Name: services services_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.services
    ADD CONSTRAINT services_pkey PRIMARY KEY (id);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (sid);


--
-- Name: sites sites_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sites
    ADD CONSTRAINT sites_code_key UNIQUE (code);


--
-- Name: sites sites_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sites
    ADD CONSTRAINT sites_name_key UNIQUE (name);


--
-- Name: sites sites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sites
    ADD CONSTRAINT sites_pkey PRIMARY KEY (id);


--
-- Name: skill_assessments skill_assessments_employee_id_skill_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_assessments
    ADD CONSTRAINT skill_assessments_employee_id_skill_id_key UNIQUE (employee_id, skill_id);


--
-- Name: skill_assessments skill_assessments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_assessments
    ADD CONSTRAINT skill_assessments_pkey PRIMARY KEY (id);


--
-- Name: skills skills_domain_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_domain_id_name_key UNIQUE (domain_id, name);


--
-- Name: skills skills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_pkey PRIMARY KEY (id);


--
-- Name: snapshots snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshots
    ADD CONSTRAINT snapshots_pkey PRIMARY KEY (id);


--
-- Name: supervisor_reviews supervisor_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_reviews
    ADD CONSTRAINT supervisor_reviews_pkey PRIMARY KEY (id);


--
-- Name: supervisor_reviews supervisor_reviews_self_assessment_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_reviews
    ADD CONSTRAINT supervisor_reviews_self_assessment_id_key UNIQUE (self_assessment_id);


--
-- Name: system_logs system_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_logs
    ADD CONSTRAINT system_logs_pkey PRIMARY KEY (id);


--
-- Name: talent_placements talent_placements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.talent_placements
    ADD CONSTRAINT talent_placements_pkey PRIMARY KEY (employee_id, cycle_id);


--
-- Name: talent_ratings talent_ratings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.talent_ratings
    ADD CONSTRAINT talent_ratings_pkey PRIMARY KEY (id);


--
-- Name: training_plan_items training_plan_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_plan_items
    ADD CONSTRAINT training_plan_items_pkey PRIMARY KEY (id);


--
-- Name: training_plans training_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_plans
    ADD CONSTRAINT training_plans_pkey PRIMARY KEY (id);


--
-- Name: idx_action_evidence_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_action_evidence_action ON public.action_evidence USING btree (action_id);


--
-- Name: idx_admin_scopes_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_scopes_admin_id ON public.admin_scopes USING btree (admin_id);


--
-- Name: idx_admin_scopes_country_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_scopes_country_id ON public.admin_scopes USING btree (country_id);


--
-- Name: idx_admin_scopes_department_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_scopes_department_id ON public.admin_scopes USING btree (department_id);


--
-- Name: idx_admin_scopes_region_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_scopes_region_id ON public.admin_scopes USING btree (region_id);


--
-- Name: idx_admin_scopes_service_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_scopes_service_id ON public.admin_scopes USING btree (service_id);


--
-- Name: idx_admin_scopes_site_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_scopes_site_id ON public.admin_scopes USING btree (site_id);


--
-- Name: idx_admins_sso_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_admins_sso_identity ON public.admins USING btree (auth_provider, external_id) WHERE (external_id IS NOT NULL);


--
-- Name: idx_assessment_history_assessed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_assessment_history_assessed_at ON public.assessment_history USING btree (assessed_at);


--
-- Name: idx_assessment_history_emp_skill_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_assessment_history_emp_skill_time ON public.assessment_history USING btree (employee_id, skill_id, assessed_at DESC);


--
-- Name: idx_assessment_history_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_assessment_history_employee ON public.assessment_history USING btree (employee_id);


--
-- Name: idx_assessment_history_skill; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_assessment_history_skill ON public.assessment_history USING btree (skill_id);


--
-- Name: idx_bias_alerts_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bias_alerts_state ON public.bias_alerts USING btree (state);


--
-- Name: idx_check_in_items_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_check_in_items_parent ON public.check_in_items USING btree (check_in_id);


--
-- Name: idx_check_ins_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_check_ins_employee ON public.check_ins USING btree (employee_id);


--
-- Name: idx_check_ins_scheduled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_check_ins_scheduled ON public.check_ins USING btree (scheduled_at);


--
-- Name: idx_check_ins_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_check_ins_status ON public.check_ins USING btree (status);


--
-- Name: idx_coaching_objectives_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coaching_objectives_session ON public.coaching_objectives USING btree (session_id);


--
-- Name: idx_coaching_plan_actions_plan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coaching_plan_actions_plan ON public.coaching_plan_actions USING btree (plan_id);


--
-- Name: idx_coaching_plans_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coaching_plans_due ON public.coaching_plans USING btree (target_date);


--
-- Name: idx_coaching_plans_emp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coaching_plans_emp ON public.coaching_plans USING btree (employee_id);


--
-- Name: idx_coaching_plans_idp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coaching_plans_idp ON public.coaching_plans USING btree (idp_id);


--
-- Name: idx_coaching_plans_pip; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coaching_plans_pip ON public.coaching_plans USING btree (pip_id);


--
-- Name: idx_coaching_plans_skill; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coaching_plans_skill ON public.coaching_plans USING btree (skill_id);


--
-- Name: idx_coaching_plans_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coaching_plans_state ON public.coaching_plans USING btree (state);


--
-- Name: idx_coaching_sessions_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coaching_sessions_employee ON public.coaching_sessions USING btree (employee_id);


--
-- Name: idx_coaching_sessions_idp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coaching_sessions_idp ON public.coaching_sessions USING btree (idp_id);


--
-- Name: idx_coaching_sessions_pip; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coaching_sessions_pip ON public.coaching_sessions USING btree (pip_id);


--
-- Name: idx_coaching_sessions_skill; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coaching_sessions_skill ON public.coaching_sessions USING btree (skill_id);


--
-- Name: idx_departments_site_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_departments_site_id ON public.departments USING btree (site_id);


--
-- Name: idx_disputes_level; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_disputes_level ON public.assessment_disputes USING btree (level);


--
-- Name: idx_disputes_opened_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_disputes_opened_at ON public.assessment_disputes USING btree (opened_at);


--
-- Name: idx_disputes_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_disputes_state ON public.assessment_disputes USING btree (state);


--
-- Name: idx_dsr_due_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dsr_due_at ON public.dsr_requests USING btree (due_at);


--
-- Name: idx_dsr_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dsr_state ON public.dsr_requests USING btree (state);


--
-- Name: idx_employees_department_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employees_department_id ON public.employees USING btree (department_id);


--
-- Name: idx_employees_manager_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employees_manager_id ON public.employees USING btree (manager_id);


--
-- Name: idx_employees_role_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employees_role_id ON public.employees USING btree (role_id);


--
-- Name: idx_employees_service_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employees_service_id ON public.employees USING btree (service_id);


--
-- Name: idx_employees_site_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employees_site_id ON public.employees USING btree (site_id);


--
-- Name: idx_employees_sso_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_employees_sso_identity ON public.employees USING btree (auth_provider, external_id) WHERE (external_id IS NOT NULL);


--
-- Name: idx_employees_supervisor_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employees_supervisor_id ON public.employees USING btree (supervisor_id);


--
-- Name: idx_employees_username_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employees_username_trgm ON public.employees USING gin (username public.gin_trgm_ops);


--
-- Name: idx_evidence_av_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_evidence_av_status ON public.assessment_evidence USING btree (av_status);


--
-- Name: idx_evidence_self_assessment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_evidence_self_assessment ON public.assessment_evidence USING btree (self_assessment_id);


--
-- Name: idx_goals_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_goals_employee ON public.goals USING btree (employee_id);


--
-- Name: idx_goals_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_goals_parent ON public.goals USING btree (parent_id);


--
-- Name: idx_goals_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_goals_status ON public.goals USING btree (status);


--
-- Name: idx_idp_actions_idp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_idp_actions_idp ON public.idp_actions USING btree (idp_id);


--
-- Name: idx_idp_objectives_idp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_idp_objectives_idp ON public.idp_objectives USING btree (idp_id);


--
-- Name: idx_idp_plans_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_idp_plans_employee ON public.idp_plans USING btree (employee_id);


--
-- Name: idx_idp_plans_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_idp_plans_status ON public.idp_plans USING btree (status);


--
-- Name: idx_lifecycle_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lifecycle_kind ON public.lifecycle_events USING btree (kind);


--
-- Name: idx_lifecycle_unprocessed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lifecycle_unprocessed ON public.lifecycle_events USING btree (occurred_at) WHERE (processed_at IS NULL);


--
-- Name: idx_login_attempts_attempted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_login_attempts_attempted_at ON public.login_attempts USING btree (attempted_at);


--
-- Name: idx_login_attempts_ip; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_login_attempts_ip ON public.login_attempts USING btree (ip_address);


--
-- Name: idx_login_attempts_username; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_login_attempts_username ON public.login_attempts USING btree (username);


--
-- Name: idx_mc_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mc_kind ON public.maker_checker_requests USING btree (kind);


--
-- Name: idx_mc_maker; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mc_maker ON public.maker_checker_requests USING btree (maker_id);


--
-- Name: idx_mc_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mc_state ON public.maker_checker_requests USING btree (state);


--
-- Name: idx_mfa_backup_codes_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mfa_backup_codes_user ON public.mfa_backup_codes USING btree (user_type, user_id);


--
-- Name: idx_ninebox_box; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ninebox_box ON public.nine_box_evaluations USING btree (box);


--
-- Name: idx_ninebox_emp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ninebox_emp ON public.nine_box_evaluations USING btree (employee_id);


--
-- Name: idx_ninebox_events_eval; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ninebox_events_eval ON public.nine_box_events USING btree (evaluation_id);


--
-- Name: idx_ninebox_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ninebox_status ON public.nine_box_evaluations USING btree (status);


--
-- Name: idx_notifications_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_user ON public.notifications USING btree (user_type, user_id, read_at);


--
-- Name: idx_password_history_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_password_history_admin_id ON public.password_history USING btree (admin_id);


--
-- Name: idx_password_history_changed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_password_history_changed_at ON public.password_history USING btree (changed_at);


--
-- Name: idx_pips_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pips_employee ON public.pips USING btree (employee_id);


--
-- Name: idx_readiness_snapshots_cycle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_readiness_snapshots_cycle ON public.readiness_snapshots USING btree (cycle_id);


--
-- Name: idx_readiness_snapshots_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_readiness_snapshots_employee ON public.readiness_snapshots USING btree (employee_id);


--
-- Name: idx_report_templates_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_report_templates_created_by ON public.report_templates USING btree (created_by);


--
-- Name: idx_report_templates_is_public; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_report_templates_is_public ON public.report_templates USING btree (is_public);


--
-- Name: idx_report_templates_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_report_templates_type ON public.report_templates USING btree (report_type);


--
-- Name: idx_review_delegations_grantee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_review_delegations_grantee ON public.review_delegations USING btree (grantee_id);


--
-- Name: idx_review_signatures_review; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_review_signatures_review ON public.review_signatures USING btree (review_id);


--
-- Name: idx_rsr_role_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rsr_role_id ON public.role_skill_requirements USING btree (role_id);


--
-- Name: idx_rsr_skill_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rsr_skill_id ON public.role_skill_requirements USING btree (skill_id);


--
-- Name: idx_sa_comments_sa; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sa_comments_sa ON public.self_assessment_comments USING btree (self_assessment_id);


--
-- Name: idx_sa_current_reviewer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sa_current_reviewer ON public.self_assessments USING btree (current_reviewer_id);


--
-- Name: idx_sa_events_assessment_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sa_events_assessment_time ON public.self_assessment_events USING btree (self_assessment_id, created_at);


--
-- Name: idx_sa_events_sa; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sa_events_sa ON public.self_assessment_events USING btree (self_assessment_id);


--
-- Name: idx_self_assessments_cycle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_self_assessments_cycle ON public.self_assessments USING btree (cycle_id);


--
-- Name: idx_self_assessments_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_self_assessments_employee ON public.self_assessments USING btree (employee_id);


--
-- Name: idx_self_assessments_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_self_assessments_status ON public.self_assessments USING btree (status);


--
-- Name: idx_services_department_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_services_department_id ON public.services USING btree (department_id);


--
-- Name: idx_session_expire; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_session_expire ON public.session USING btree (expire);


--
-- Name: idx_sites_country_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sites_country_id ON public.sites USING btree (country_id);


--
-- Name: idx_skill_assessments_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_skill_assessments_employee ON public.skill_assessments USING btree (employee_id);


--
-- Name: idx_skill_assessments_skill; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_skill_assessments_skill ON public.skill_assessments USING btree (skill_id);


--
-- Name: idx_skills_domain_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_skills_domain_id ON public.skills USING btree (domain_id);


--
-- Name: idx_snapshots_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_snapshots_created_at ON public.snapshots USING btree (created_at);


--
-- Name: idx_supervisor_reviews_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_supervisor_reviews_employee ON public.supervisor_reviews USING btree (employee_id);


--
-- Name: idx_supervisor_reviews_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_supervisor_reviews_priority ON public.supervisor_reviews USING btree (priority_index DESC);


--
-- Name: idx_supervisor_reviews_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_supervisor_reviews_status ON public.supervisor_reviews USING btree (status);


--
-- Name: idx_system_logs_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_logs_admin_id ON public.system_logs USING btree (admin_id);


--
-- Name: idx_system_logs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_logs_created_at ON public.system_logs USING btree (created_at);


--
-- Name: idx_talent_ratings_cycle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_talent_ratings_cycle ON public.talent_ratings USING btree (cycle_id);


--
-- Name: idx_talent_ratings_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_talent_ratings_employee ON public.talent_ratings USING btree (employee_id);


--
-- Name: idx_training_plan_items_plan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_training_plan_items_plan ON public.training_plan_items USING btree (training_plan_id);


--
-- Name: idx_training_plans_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_training_plans_employee ON public.training_plans USING btree (employee_id);


--
-- Name: admins trg_admins_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_admins_updated_at BEFORE UPDATE ON public.admins FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: app_settings trg_app_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_app_settings_updated_at BEFORE UPDATE ON public.app_settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: assessment_cycles trg_assessment_cycles_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_assessment_cycles_updated_at BEFORE UPDATE ON public.assessment_cycles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: assessment_history trg_assessment_history_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_assessment_history_immutable BEFORE DELETE OR UPDATE ON public.assessment_history FOR EACH ROW EXECUTE FUNCTION public.block_mutation();


--
-- Name: check_ins trg_check_ins_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_check_ins_updated_at BEFORE UPDATE ON public.check_ins FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: countries trg_countries_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_countries_updated_at BEFORE UPDATE ON public.countries FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: departments trg_departments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_departments_updated_at BEFORE UPDATE ON public.departments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: domains trg_domains_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_domains_updated_at BEFORE UPDATE ON public.domains FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: employees trg_employees_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_employees_updated_at BEFORE UPDATE ON public.employees FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: goals trg_goals_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_goals_updated_at BEFORE UPDATE ON public.goals FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: idp_actions trg_idp_actions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_idp_actions_updated_at BEFORE UPDATE ON public.idp_actions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: idp_objectives trg_idp_objectives_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_idp_objectives_updated_at BEFORE UPDATE ON public.idp_objectives FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: idp_plans trg_idp_plans_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_idp_plans_updated_at BEFORE UPDATE ON public.idp_plans FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: pips trg_pips_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_pips_updated_at BEFORE UPDATE ON public.pips FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: regions trg_regions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_regions_updated_at BEFORE UPDATE ON public.regions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: report_templates trg_report_templates_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_report_templates_updated_at BEFORE UPDATE ON public.report_templates FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: review_signatures trg_review_signatures_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_review_signatures_immutable BEFORE DELETE OR UPDATE ON public.review_signatures FOR EACH ROW EXECUTE FUNCTION public.block_mutation();


--
-- Name: roles trg_roles_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_roles_updated_at BEFORE UPDATE ON public.roles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: role_skill_requirements trg_rsr_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_rsr_updated_at BEFORE UPDATE ON public.role_skill_requirements FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: self_assessments trg_self_assessments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_self_assessments_updated_at BEFORE UPDATE ON public.self_assessments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: services trg_services_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_services_updated_at BEFORE UPDATE ON public.services FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: sites trg_sites_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sites_updated_at BEFORE UPDATE ON public.sites FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: skill_assessments trg_skill_assessment_history; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_skill_assessment_history AFTER INSERT OR UPDATE ON public.skill_assessments FOR EACH ROW EXECUTE FUNCTION public.fn_log_skill_assessment_change();


--
-- Name: skills trg_skills_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_skills_updated_at BEFORE UPDATE ON public.skills FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: system_logs trg_system_logs_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_system_logs_immutable BEFORE DELETE OR UPDATE ON public.system_logs FOR EACH ROW EXECUTE FUNCTION public.block_mutation();


--
-- Name: training_plan_items trg_training_plan_items_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_training_plan_items_updated_at BEFORE UPDATE ON public.training_plan_items FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: training_plans trg_training_plans_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_training_plans_updated_at BEFORE UPDATE ON public.training_plans FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: action_effectiveness action_effectiveness_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_effectiveness
    ADD CONSTRAINT action_effectiveness_action_id_fkey FOREIGN KEY (action_id) REFERENCES public.idp_actions(id) ON DELETE CASCADE;


--
-- Name: action_evidence action_evidence_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_evidence
    ADD CONSTRAINT action_evidence_action_id_fkey FOREIGN KEY (action_id) REFERENCES public.idp_actions(id) ON DELETE CASCADE;


--
-- Name: action_evidence action_evidence_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_evidence
    ADD CONSTRAINT action_evidence_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.employees(id) ON DELETE RESTRICT;


--
-- Name: action_skill_links action_skill_links_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_skill_links
    ADD CONSTRAINT action_skill_links_action_id_fkey FOREIGN KEY (action_id) REFERENCES public.idp_actions(id) ON DELETE CASCADE;


--
-- Name: action_skill_links action_skill_links_skill_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_skill_links
    ADD CONSTRAINT action_skill_links_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES public.skills(id) ON DELETE CASCADE;


--
-- Name: admin_scopes admin_scopes_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_scopes
    ADD CONSTRAINT admin_scopes_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.admins(id) ON DELETE CASCADE;


--
-- Name: admin_scopes admin_scopes_country_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_scopes
    ADD CONSTRAINT admin_scopes_country_id_fkey FOREIGN KEY (country_id) REFERENCES public.countries(id) ON DELETE CASCADE;


--
-- Name: admin_scopes admin_scopes_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_scopes
    ADD CONSTRAINT admin_scopes_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id) ON DELETE CASCADE;


--
-- Name: admin_scopes admin_scopes_region_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_scopes
    ADD CONSTRAINT admin_scopes_region_id_fkey FOREIGN KEY (region_id) REFERENCES public.regions(id) ON DELETE CASCADE;


--
-- Name: admin_scopes admin_scopes_service_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_scopes
    ADD CONSTRAINT admin_scopes_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.services(id) ON DELETE CASCADE;


--
-- Name: admin_scopes admin_scopes_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_scopes
    ADD CONSTRAINT admin_scopes_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: api_keys api_keys_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.admins(id) ON DELETE RESTRICT;


--
-- Name: app_settings app_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: assessment_cycles assessment_cycles_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_cycles
    ADD CONSTRAINT assessment_cycles_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.admins(id) ON DELETE RESTRICT;


--
-- Name: assessment_disputes assessment_disputes_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_disputes
    ADD CONSTRAINT assessment_disputes_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.employees(id) ON DELETE RESTRICT;


--
-- Name: assessment_disputes assessment_disputes_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_disputes
    ADD CONSTRAINT assessment_disputes_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: assessment_disputes assessment_disputes_supervisor_review_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_disputes
    ADD CONSTRAINT assessment_disputes_supervisor_review_id_fkey FOREIGN KEY (supervisor_review_id) REFERENCES public.supervisor_reviews(id) ON DELETE CASCADE;


--
-- Name: assessment_evidence assessment_evidence_self_assessment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_evidence
    ADD CONSTRAINT assessment_evidence_self_assessment_id_fkey FOREIGN KEY (self_assessment_id) REFERENCES public.self_assessments(id) ON DELETE CASCADE;


--
-- Name: assessment_history assessment_history_assessed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_history
    ADD CONSTRAINT assessment_history_assessed_by_fkey FOREIGN KEY (assessed_by) REFERENCES public.admins(id) ON DELETE RESTRICT;


--
-- Name: assessment_history assessment_history_cycle_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_history
    ADD CONSTRAINT assessment_history_cycle_fk FOREIGN KEY (cycle_id) REFERENCES public.assessment_cycles(id) ON DELETE SET NULL;


--
-- Name: assessment_history assessment_history_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_history
    ADD CONSTRAINT assessment_history_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: assessment_history assessment_history_sa_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_history
    ADD CONSTRAINT assessment_history_sa_fk FOREIGN KEY (self_assessment_id) REFERENCES public.self_assessments(id) ON DELETE SET NULL;


--
-- Name: assessment_history assessment_history_skill_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessment_history
    ADD CONSTRAINT assessment_history_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES public.skills(id) ON DELETE CASCADE;


--
-- Name: bias_alerts bias_alerts_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bias_alerts
    ADD CONSTRAINT bias_alerts_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.assessment_cycles(id) ON DELETE CASCADE;


--
-- Name: check_in_items check_in_items_check_in_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.check_in_items
    ADD CONSTRAINT check_in_items_check_in_id_fkey FOREIGN KEY (check_in_id) REFERENCES public.check_ins(id) ON DELETE CASCADE;


--
-- Name: check_ins check_ins_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.check_ins
    ADD CONSTRAINT check_ins_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: check_ins check_ins_manager_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.check_ins
    ADD CONSTRAINT check_ins_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: coaching_grow coaching_grow_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coaching_grow
    ADD CONSTRAINT coaching_grow_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.coaching_sessions(id) ON DELETE CASCADE;


--
-- Name: coaching_objectives coaching_objectives_carry_forward_of_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coaching_objectives
    ADD CONSTRAINT coaching_objectives_carry_forward_of_fkey FOREIGN KEY (carry_forward_of) REFERENCES public.coaching_objectives(id) ON DELETE SET NULL;


--
-- Name: coaching_objectives coaching_objectives_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coaching_objectives
    ADD CONSTRAINT coaching_objectives_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.coaching_sessions(id) ON DELETE CASCADE;


--
-- Name: coaching_plan_actions coaching_plan_actions_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coaching_plan_actions
    ADD CONSTRAINT coaching_plan_actions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.coaching_plans(id) ON DELETE CASCADE;


--
-- Name: coaching_plans coaching_plans_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coaching_plans
    ADD CONSTRAINT coaching_plans_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: coaching_plans coaching_plans_idp_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coaching_plans
    ADD CONSTRAINT coaching_plans_idp_id_fkey FOREIGN KEY (idp_id) REFERENCES public.idp_plans(id) ON DELETE SET NULL;


--
-- Name: coaching_plans coaching_plans_mentor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coaching_plans
    ADD CONSTRAINT coaching_plans_mentor_id_fkey FOREIGN KEY (mentor_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: coaching_plans coaching_plans_pip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coaching_plans
    ADD CONSTRAINT coaching_plans_pip_id_fkey FOREIGN KEY (pip_id) REFERENCES public.pips(id) ON DELETE SET NULL;


--
-- Name: coaching_plans coaching_plans_skill_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coaching_plans
    ADD CONSTRAINT coaching_plans_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES public.skills(id) ON DELETE SET NULL;


--
-- Name: coaching_sessions coaching_sessions_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coaching_sessions
    ADD CONSTRAINT coaching_sessions_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: coaching_sessions coaching_sessions_idp_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coaching_sessions
    ADD CONSTRAINT coaching_sessions_idp_id_fkey FOREIGN KEY (idp_id) REFERENCES public.idp_plans(id) ON DELETE SET NULL;


--
-- Name: coaching_sessions coaching_sessions_pip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coaching_sessions
    ADD CONSTRAINT coaching_sessions_pip_id_fkey FOREIGN KEY (pip_id) REFERENCES public.pips(id) ON DELETE SET NULL;


--
-- Name: coaching_sessions coaching_sessions_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coaching_sessions
    ADD CONSTRAINT coaching_sessions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.coaching_plans(id) ON DELETE SET NULL;


--
-- Name: coaching_sessions coaching_sessions_skill_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coaching_sessions
    ADD CONSTRAINT coaching_sessions_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES public.skills(id) ON DELETE SET NULL;


--
-- Name: coaching_signoffs coaching_signoffs_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coaching_signoffs
    ADD CONSTRAINT coaching_signoffs_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.coaching_sessions(id) ON DELETE CASCADE;


--
-- Name: countries countries_region_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.countries
    ADD CONSTRAINT countries_region_id_fkey FOREIGN KEY (region_id) REFERENCES public.regions(id) ON DELETE RESTRICT;


--
-- Name: departments departments_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE CASCADE;


--
-- Name: dsr_requests dsr_requests_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dsr_requests
    ADD CONSTRAINT dsr_requests_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: employees employees_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id) ON DELETE RESTRICT;


--
-- Name: employees employees_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE RESTRICT;


--
-- Name: employees employees_service_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.services(id) ON DELETE RESTRICT;


--
-- Name: employees employees_site_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_site_id_fkey FOREIGN KEY (site_id) REFERENCES public.sites(id) ON DELETE RESTRICT;


--
-- Name: employees employees_supervisor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_supervisor_id_fkey FOREIGN KEY (supervisor_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: goals goals_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goals
    ADD CONSTRAINT goals_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: goals goals_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goals
    ADD CONSTRAINT goals_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.goals(id) ON DELETE CASCADE;


--
-- Name: idp_actions idp_actions_idp_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idp_actions
    ADD CONSTRAINT idp_actions_idp_id_fkey FOREIGN KEY (idp_id) REFERENCES public.idp_plans(id) ON DELETE CASCADE;


--
-- Name: idp_actions idp_actions_objective_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idp_actions
    ADD CONSTRAINT idp_actions_objective_id_fkey FOREIGN KEY (objective_id) REFERENCES public.idp_objectives(id) ON DELETE SET NULL;


--
-- Name: idp_objectives idp_objectives_idp_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idp_objectives
    ADD CONSTRAINT idp_objectives_idp_id_fkey FOREIGN KEY (idp_id) REFERENCES public.idp_plans(id) ON DELETE CASCADE;


--
-- Name: idp_objectives idp_objectives_skill_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idp_objectives
    ADD CONSTRAINT idp_objectives_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES public.skills(id) ON DELETE SET NULL;


--
-- Name: idp_plans idp_plans_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idp_plans
    ADD CONSTRAINT idp_plans_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.assessment_cycles(id) ON DELETE SET NULL;


--
-- Name: idp_plans idp_plans_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idp_plans
    ADD CONSTRAINT idp_plans_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: idp_signoffs idp_signoffs_idp_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idp_signoffs
    ADD CONSTRAINT idp_signoffs_idp_id_fkey FOREIGN KEY (idp_id) REFERENCES public.idp_plans(id) ON DELETE CASCADE;


--
-- Name: lifecycle_events lifecycle_events_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lifecycle_events
    ADD CONSTRAINT lifecycle_events_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: maker_checker_requests maker_checker_requests_checker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maker_checker_requests
    ADD CONSTRAINT maker_checker_requests_checker_id_fkey FOREIGN KEY (checker_id) REFERENCES public.admins(id) ON DELETE RESTRICT;


--
-- Name: maker_checker_requests maker_checker_requests_maker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maker_checker_requests
    ADD CONSTRAINT maker_checker_requests_maker_id_fkey FOREIGN KEY (maker_id) REFERENCES public.admins(id) ON DELETE RESTRICT;


--
-- Name: nine_box_evaluations nine_box_evaluations_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nine_box_evaluations
    ADD CONSTRAINT nine_box_evaluations_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: nine_box_events nine_box_events_evaluation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nine_box_events
    ADD CONSTRAINT nine_box_events_evaluation_id_fkey FOREIGN KEY (evaluation_id) REFERENCES public.nine_box_evaluations(id) ON DELETE CASCADE;


--
-- Name: password_history password_history_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_history
    ADD CONSTRAINT password_history_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.admins(id) ON DELETE CASCADE;


--
-- Name: pii_cleanup_jobs pii_cleanup_jobs_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pii_cleanup_jobs
    ADD CONSTRAINT pii_cleanup_jobs_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: pip_milestones pip_milestones_pip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pip_milestones
    ADD CONSTRAINT pip_milestones_pip_id_fkey FOREIGN KEY (pip_id) REFERENCES public.pips(id) ON DELETE CASCADE;


--
-- Name: pips pips_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pips
    ADD CONSTRAINT pips_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.admins(id) ON DELETE RESTRICT;


--
-- Name: pips pips_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pips
    ADD CONSTRAINT pips_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: pips pips_initiated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pips
    ADD CONSTRAINT pips_initiated_by_fkey FOREIGN KEY (initiated_by) REFERENCES public.admins(id) ON DELETE RESTRICT;


--
-- Name: readiness_snapshots readiness_snapshots_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.readiness_snapshots
    ADD CONSTRAINT readiness_snapshots_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.assessment_cycles(id) ON DELETE SET NULL;


--
-- Name: readiness_snapshots readiness_snapshots_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.readiness_snapshots
    ADD CONSTRAINT readiness_snapshots_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: report_templates report_templates_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_templates
    ADD CONSTRAINT report_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.admins(id) ON DELETE CASCADE;


--
-- Name: review_delegations review_delegations_grantee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_delegations
    ADD CONSTRAINT review_delegations_grantee_id_fkey FOREIGN KEY (grantee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: review_delegations review_delegations_grantor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_delegations
    ADD CONSTRAINT review_delegations_grantor_id_fkey FOREIGN KEY (grantor_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: review_signatures review_signatures_review_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_signatures
    ADD CONSTRAINT review_signatures_review_id_fkey FOREIGN KEY (review_id) REFERENCES public.supervisor_reviews(id) ON DELETE CASCADE;


--
-- Name: role_skill_requirements role_skill_requirements_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_skill_requirements
    ADD CONSTRAINT role_skill_requirements_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: role_skill_requirements role_skill_requirements_skill_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_skill_requirements
    ADD CONSTRAINT role_skill_requirements_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES public.skills(id) ON DELETE CASCADE;


--
-- Name: self_assessment_comments self_assessment_comments_in_reply_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.self_assessment_comments
    ADD CONSTRAINT self_assessment_comments_in_reply_to_fkey FOREIGN KEY (in_reply_to) REFERENCES public.self_assessment_comments(id) ON DELETE SET NULL;


--
-- Name: self_assessment_comments self_assessment_comments_self_assessment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.self_assessment_comments
    ADD CONSTRAINT self_assessment_comments_self_assessment_id_fkey FOREIGN KEY (self_assessment_id) REFERENCES public.self_assessments(id) ON DELETE CASCADE;


--
-- Name: self_assessment_events self_assessment_events_self_assessment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.self_assessment_events
    ADD CONSTRAINT self_assessment_events_self_assessment_id_fkey FOREIGN KEY (self_assessment_id) REFERENCES public.self_assessments(id) ON DELETE CASCADE;


--
-- Name: self_assessments self_assessments_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.self_assessments
    ADD CONSTRAINT self_assessments_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: self_assessments self_assessments_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.self_assessments
    ADD CONSTRAINT self_assessments_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.assessment_cycles(id) ON DELETE RESTRICT;


--
-- Name: self_assessments self_assessments_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.self_assessments
    ADD CONSTRAINT self_assessments_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: self_assessments self_assessments_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.self_assessments
    ADD CONSTRAINT self_assessments_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: self_assessments self_assessments_reviewer_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.self_assessments
    ADD CONSTRAINT self_assessments_reviewer_fk FOREIGN KEY (current_reviewer_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: self_assessments self_assessments_skill_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.self_assessments
    ADD CONSTRAINT self_assessments_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES public.skills(id) ON DELETE CASCADE;


--
-- Name: services services_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.services
    ADD CONSTRAINT services_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id) ON DELETE CASCADE;


--
-- Name: sites sites_country_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sites
    ADD CONSTRAINT sites_country_id_fkey FOREIGN KEY (country_id) REFERENCES public.countries(id) ON DELETE RESTRICT;


--
-- Name: skill_assessments skill_assessments_assessed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_assessments
    ADD CONSTRAINT skill_assessments_assessed_by_fkey FOREIGN KEY (assessed_by) REFERENCES public.admins(id) ON DELETE RESTRICT;


--
-- Name: skill_assessments skill_assessments_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_assessments
    ADD CONSTRAINT skill_assessments_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: skill_assessments skill_assessments_skill_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_assessments
    ADD CONSTRAINT skill_assessments_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES public.skills(id) ON DELETE CASCADE;


--
-- Name: skills skills_domain_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_domain_id_fkey FOREIGN KEY (domain_id) REFERENCES public.domains(id) ON DELETE RESTRICT;


--
-- Name: snapshots snapshots_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshots
    ADD CONSTRAINT snapshots_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.admins(id) ON DELETE RESTRICT;


--
-- Name: supervisor_reviews supervisor_reviews_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_reviews
    ADD CONSTRAINT supervisor_reviews_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: supervisor_reviews supervisor_reviews_self_assessment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_reviews
    ADD CONSTRAINT supervisor_reviews_self_assessment_id_fkey FOREIGN KEY (self_assessment_id) REFERENCES public.self_assessments(id) ON DELETE CASCADE;


--
-- Name: supervisor_reviews supervisor_reviews_skill_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supervisor_reviews
    ADD CONSTRAINT supervisor_reviews_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES public.skills(id) ON DELETE CASCADE;


--
-- Name: system_logs system_logs_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_logs
    ADD CONSTRAINT system_logs_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: talent_placements talent_placements_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.talent_placements
    ADD CONSTRAINT talent_placements_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.assessment_cycles(id) ON DELETE CASCADE;


--
-- Name: talent_placements talent_placements_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.talent_placements
    ADD CONSTRAINT talent_placements_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: talent_placements talent_placements_placed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.talent_placements
    ADD CONSTRAINT talent_placements_placed_by_fkey FOREIGN KEY (placed_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: talent_ratings talent_ratings_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.talent_ratings
    ADD CONSTRAINT talent_ratings_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.assessment_cycles(id) ON DELETE SET NULL;


--
-- Name: talent_ratings talent_ratings_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.talent_ratings
    ADD CONSTRAINT talent_ratings_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: training_plan_items training_plan_items_skill_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_plan_items
    ADD CONSTRAINT training_plan_items_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES public.skills(id) ON DELETE CASCADE;


--
-- Name: training_plan_items training_plan_items_training_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_plan_items
    ADD CONSTRAINT training_plan_items_training_plan_id_fkey FOREIGN KEY (training_plan_id) REFERENCES public.training_plans(id) ON DELETE CASCADE;


--
-- Name: training_plans training_plans_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_plans
    ADD CONSTRAINT training_plans_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: training_plans training_plans_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_plans
    ADD CONSTRAINT training_plans_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id) ON DELETE RESTRICT;


--
-- Name: training_plans training_plans_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_plans
    ADD CONSTRAINT training_plans_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--



-- ============================================================================
-- Baseline metadata: complete consolidated schema; folded migrations pre-marked
-- applied so a fresh db:migrate:all loads this then finds 0 pending.
-- ============================================================================
SET search_path TO public;
INSERT INTO public.schema_meta(key, value, applied_at) VALUES
  ('schema_version','01-base', now()),
  ('source','consolidated baseline: pg_dump --schema-only of live the production database (2026-06-17)', now()),
  ('02_uam','applied', now()),
  ('03_cycles_evidence_disputes','applied', now()),
  ('04_idp_actions','applied', now()),
  ('05_talent_coaching_pip','applied', now()),
  ('06_lifecycle_notifications','applied', now()),
  ('07_dashboard_views','applied', now()),
  ('08_relax_reviewer_fks','applied', now()),
  ('09_employee_force_pw','applied', now()),
  ('09_hierarchy','applied', now()),
  ('10_self_assessment_workflow','applied', now()),
  ('11_coaching_plans','applied', now()),
  ('11_skill_review_history','applied', now()),
  ('12_ninebox','applied', now()),
  ('12_ninebox_cell_position','applied', now()),
  ('13_manager_polymorphic','applied', now()),
  ('13_ninebox_position_source','applied', now()),
  ('14_mfa_policy','applied', now()),
  ('15_coaching_context','applied', now()),
  ('16_coaching_session_context','applied', now()),
  ('17_sso_identity','applied', now()),
  ('18_okr_goals','applied', now()),
  ('19_checkins','applied', now())
ON CONFLICT (key) DO NOTHING;
