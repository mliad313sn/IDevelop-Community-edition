-- FMEA (criticality 720), (432) and (189) — local-content reporting.
--
-- `employees.nationality` is free text; the classifier compared it to the country's
-- DISPLAY NAME (`countries.name`, French). Nothing a human types matches that except
-- the exact French spelling: "Ivory Coast" != "Côte d'Ivoire", and so does every
-- demonym ("Ivoirien", "Ivorian") and every ISO code ("CI").
--
-- Verified on this instance: 55 of 77 active employees are Ivorian and work on
-- Ivorian sites, and the report declared 0 nationals / 71 expatriates. That CSV is
-- the artifact handed to the ministry, and the "positions to nationalise" list
-- proposed nationalising posts already held by nationals.
--
-- The fix is to resolve a nationality to a COUNTRY, not to a string. This table holds
-- the accepted spellings; matching is case- and accent-insensitive.

CREATE TABLE IF NOT EXISTS country_aliases (
    id          BIGSERIAL PRIMARY KEY,
    country_id  BIGINT NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
    alias       TEXT   NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_country_aliases_country ON country_aliases (country_id);

-- Every country's own code and display name are always accepted.
INSERT INTO country_aliases (country_id, alias)
SELECT c.id, v.alias
  FROM countries c
  CROSS JOIN LATERAL (VALUES (c.code), (c.name)) AS v(alias)
 WHERE v.alias IS NOT NULL AND btrim(v.alias) <> ''
   AND NOT EXISTS (
        SELECT 1 FROM country_aliases ca
         WHERE ca.country_id = c.id
           AND lower(unaccent(ca.alias)) = lower(unaccent(v.alias)));

-- Curated spellings: ISO alpha-3, English name, and the French and English demonyms.
-- Seeded only for countries this installation actually has, so the list is safe to
-- extend without assuming any particular customer footprint.
INSERT INTO country_aliases (country_id, alias)
SELECT c.id, a.alias
  FROM (VALUES
    ('CI','CIV'),('CI','Ivory Coast'),('CI','Cote d''Ivoire'),('CI','Ivoirien'),('CI','Ivoirienne'),('CI','Ivorian'),
    ('BF','BFA'),('BF','Burkina Faso'),('BF','Burkinabe'),('BF','Burkinabè'),('BF','Burkinabé'),
    ('ML','MLI'),('ML','Mali'),('ML','Malien'),('ML','Malienne'),('ML','Malian'),
    ('SN','SEN'),('SN','Senegal'),('SN','Sénégal'),('SN','Senegalais'),('SN','Sénégalais'),('SN','Senegalese'),
    ('GH','GHA'),('GH','Ghana'),('GH','Ghaneen'),('GH','Ghanéen'),('GH','Ghanaian'),
    ('GN','GIN'),('GN','Guinea'),('GN','Guinee'),('GN','Guinée'),('GN','Guineen'),('GN','Guinéen'),('GN','Guinean'),
    ('NE','NER'),('NE','Niger'),('NE','Nigerien'),('NE','Nigérien'),('NE','Nigerien (Niger)'),
    ('TG','TGO'),('TG','Togo'),('TG','Togolais'),('TG','Togolese'),
    ('BJ','BEN'),('BJ','Benin'),('BJ','Bénin'),('BJ','Beninois'),('BJ','Béninois'),('BJ','Beninese'),
    ('NG','NGA'),('NG','Nigeria'),('NG','Nigerian'),('NG','Nigerian (Nigeria)'),
    ('CM','CMR'),('CM','Cameroon'),('CM','Cameroun'),('CM','Camerounais'),('CM','Cameroonian'),
    ('CD','COD'),('CD','Democratic Republic of the Congo'),('CD','RDC'),('CD','Congolais (RDC)'),('CD','Congolese'),
    ('CG','COG'),('CG','Republic of the Congo'),('CG','Congo'),('CG','Congolais'),
    ('GA','GAB'),('GA','Gabon'),('GA','Gabonais'),('GA','Gabonese'),
    ('TD','TCD'),('TD','Chad'),('TD','Tchad'),('TD','Tchadien'),('TD','Chadian'),
    ('MR','MRT'),('MR','Mauritania'),('MR','Mauritanie'),('MR','Mauritanien'),('MR','Mauritanian'),
    ('SL','SLE'),('SL','Sierra Leone'),('SL','Sierra Leonean'),
    ('LR','LBR'),('LR','Liberia'),('LR','Liberien'),('LR','Libérien'),('LR','Liberian'),
    ('ZA','ZAF'),('ZA','South Africa'),('ZA','Afrique du Sud'),('ZA','Sud-Africain'),('ZA','South African'),
    ('MA','MAR'),('MA','Morocco'),('MA','Maroc'),('MA','Marocain'),('MA','Moroccan'),
    ('DZ','DZA'),('DZ','Algeria'),('DZ','Algerie'),('DZ','Algérie'),('DZ','Algerien'),('DZ','Algérien'),('DZ','Algerian'),
    ('TN','TUN'),('TN','Tunisia'),('TN','Tunisie'),('TN','Tunisien'),('TN','Tunisian'),
    ('FR','FRA'),('FR','France'),('FR','Francais'),('FR','Français'),('FR','French'),
    ('GB','GBR'),('GB','United Kingdom'),('GB','Royaume-Uni'),('GB','Britannique'),('GB','British'),
    ('US','USA'),('US','United States'),('US','Etats-Unis'),('US','États-Unis'),('US','Americain'),('US','Américain'),('US','American'),
    ('CA','CAN'),('CA','Canada'),('CA','Canadien'),('CA','Canadian'),
    ('AU','AUS'),('AU','Australia'),('AU','Australie'),('AU','Australien'),('AU','Australian')
  ) AS a(code, alias)
  JOIN countries c ON lower(c.code) = lower(a.code)
 WHERE NOT EXISTS (
        SELECT 1 FROM country_aliases ca
         WHERE ca.country_id = c.id
           AND lower(unaccent(ca.alias)) = lower(unaccent(a.alias)));
