-- 45_local_content.sql — optional Local Content / Nationalization module.
-- Adds employees.nationality and the module's settings rows (feature OFF by
-- default; activated from Settings). An employee counts as "national" when
-- their nationality matches the configured home country (case-insensitive).
-- Additive & idempotent.

ALTER TABLE employees ADD COLUMN IF NOT EXISTS nationality varchar(80);

INSERT INTO app_settings (setting_key, setting_value, setting_type, description, category)
VALUES
    ('featureLocalContent', '0', 'boolean',
     'Enable the Local Content / Nationalization module (report + nationality field). 0 = off.',
     'modules'),
    ('localContentHomeCountry', '', 'string',
     'Home country for local-content reporting (employees with this nationality count as nationals).',
     'modules')
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO schema_meta(key, value) VALUES ('45_local_content', 'applied')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, applied_at = now();
