-- FMEA (criticality 360) — a certificate dated in the FUTURE masked an
-- expired one.
--
-- `v_certification_current` picks, per (employee, skill), the row with the latest
-- `issued_on`. Nothing required that date to have arrived. A certificate issued
-- "on 2027-10-01" therefore became the CURRENT one today, and:
--
--   * cert_status read 'valid' (its expiry is far away),
--   * the person dropped out of v_certification_lapsed,
--   * their skill level stopped being degraded by migration 78, so
--     v_employee_skill_gaps flipped is_met back to 1,
--   * and a safe-shift coverage rule went from BREACHED back to SATISFIED.
--
-- Nobody is notified of any of that: it is a silent restoration of a qualification
-- the person does not hold. Verified by probe: an expired-2021 ticket plus a
-- certificate dated CURRENT_DATE + 400 produced cert_status='valid', lapsed=0,
-- is_met=1 and v_coverage_status.satisfied=true.
--
-- A certificate that has not been issued yet is not current. `CertificationService`
-- additionally refuses to record one, so the data stops being created as well as
-- stopping being believed.

CREATE OR REPLACE VIEW v_certification_current AS
 SELECT c.id AS certification_id,
    ed.employee_id,
    ed.full_name,
    ed.site_id,
    ed.site_name,
    ed.department_id,
    ed.department_name,
    ed.service_id,
    ed.service_name,
    c.skill_id,
    s.name AS skill_name,
    c.cert_number,
    c.issued_on,
    c.expires_on,
    c.verified_by_type,
    c.verified_by,
    c.verified_at,
    c.av_status,
    c.alert_stage,
    p.revalidation_window_days,
    c.expires_on - CURRENT_DATE AS days_to_expiry,
        CASE
            WHEN c.expires_on IS NULL THEN 'no_expiry'::text
            WHEN c.expires_on < CURRENT_DATE THEN 'expired'::text
            WHEN (c.expires_on - CURRENT_DATE) <= COALESCE(p.revalidation_window_days, 90) THEN 'expiring'::text
            ELSE 'valid'::text
        END AS cert_status
   FROM ( SELECT DISTINCT ON (employee_certifications.employee_id, employee_certifications.skill_id)
            employee_certifications.id,
            employee_certifications.employee_id,
            employee_certifications.skill_id,
            employee_certifications.cert_number,
            employee_certifications.issued_on,
            employee_certifications.expires_on,
            employee_certifications.is_revoked,
            employee_certifications.revoked_reason,
            employee_certifications.verified_by_type,
            employee_certifications.verified_by,
            employee_certifications.verified_at,
            employee_certifications.notes,
            employee_certifications.file_uri,
            employee_certifications.original_name,
            employee_certifications.mime,
            employee_certifications.size_bytes,
            employee_certifications.av_status,
            employee_certifications.av_signature,
            employee_certifications.quarantine_uri,
            employee_certifications.scanned_at,
            employee_certifications.alert_stage,
            employee_certifications.created_by,
            employee_certifications.created_at,
            employee_certifications.updated_at
           FROM employee_certifications
          WHERE NOT employee_certifications.is_revoked
            -- A certificate not yet issued is not the current one.
            AND employee_certifications.issued_on <= CURRENT_DATE
          ORDER BY employee_certifications.employee_id, employee_certifications.skill_id,
                   employee_certifications.issued_on DESC, employee_certifications.id DESC) c
     JOIN v_employee_details ed ON ed.employee_id = c.employee_id
     JOIN skills s ON s.id = c.skill_id
     LEFT JOIN skill_certification_policies p ON p.skill_id = c.skill_id;
