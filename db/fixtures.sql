-- Programme fixtures. Not the PRD §12 demo catalogue.
--
-- A hosted database that has the schema but no seed still has to render Shell
-- and run create-payable. Onboarding cannot create the first user: ledger.post
-- requires actor_user_id to reference app.app_user. The anchor and the platform
-- cannot be onboarded (post.sql ADA29). These rows are those fixtures.
--
-- Keyed on natural predicates ("an anchor exists", "the platform has a wallet",
-- "an active checker exists at an anchor"), not on ids. A schema-only database
-- that a ledger test already populated with a differently-id'd ADATA would
-- otherwise collide on entity_name_unique. Canonical ids and the ADATA wallet
-- from db/seed.sql are used when a row is created, so Reset world and the
-- settlement screen's hardcoded anchor address stay consistent.
--
-- No psql meta-commands: the driver executes this file.

INSERT INTO app.world (t0, offset_days) VALUES (CURRENT_DATE, 0)
ON CONFLICT (only_row) DO NOTHING;

INSERT INTO app.entity (id, name, entity_type, certification_status, programme_limit_base)
SELECT 'e0000000-0000-0000-0000-00000000ada7',
       'ADATA Technology Co., Ltd.',
       'anchor',
       'certified',
       250000000000
 WHERE NOT EXISTS (SELECT 1 FROM app.entity WHERE entity_type = 'anchor');

INSERT INTO app.entity (id, name, entity_type, certification_status)
SELECT 'e0000000-0000-0000-0000-000000005787',
       'StraitsX',
       'platform',
       'certified'
 WHERE NOT EXISTS (SELECT 1 FROM app.entity WHERE entity_type = 'platform');

-- One wallet per fixture entity that has none. Prefer the canonical address;
-- mint one if that address is already attached to someone else.
INSERT INTO app.wallet (address, entity_id)
SELECT CASE
         WHEN EXISTS (
           SELECT 1 FROM app.wallet
            WHERE address = '0xada7a0000000000000000000000000000000c21d'
         )
         THEN '0x' || encode(gen_random_bytes(20), 'hex')
         ELSE '0xada7a0000000000000000000000000000000c21d'
       END,
       e.id
  FROM app.entity e
 WHERE e.entity_type = 'anchor'
   AND NOT EXISTS (SELECT 1 FROM app.wallet w WHERE w.entity_id = e.id)
 ORDER BY e.name
 LIMIT 1;

INSERT INTO app.wallet (address, entity_id)
SELECT CASE
         WHEN EXISTS (
           SELECT 1 FROM app.wallet
            WHERE address = '0x57a715000000000000000000000000000000a001'
         )
         THEN '0x' || encode(gen_random_bytes(20), 'hex')
         ELSE '0x57a715000000000000000000000000000000a001'
       END,
       e.id
  FROM app.entity e
 WHERE e.entity_type = 'platform'
   AND NOT EXISTS (SELECT 1 FROM app.wallet w WHERE w.entity_id = e.id)
 ORDER BY e.name
 LIMIT 1;

-- One account per (fixture entity type, role) that lacks an active holder.
-- Names and ids are seed.sql's, so the persona switcher still shows Wei-Ling
-- Chen and Nadia Rahman on a fresh programme.
INSERT INTO app.app_user (id, entity_id, name, role, mock_kyc_verified, institutional_eligible)
SELECT '11111111-0000-0000-0000-000000000001', e.id, 'Wei-Ling Chen', 'adata_preparer', true, false
  FROM app.entity e
 WHERE e.entity_type = 'anchor'
   AND NOT EXISTS (
     SELECT 1 FROM app.app_user u
     JOIN app.entity x ON x.id = u.entity_id
      WHERE x.entity_type = 'anchor'
        AND u.role = 'adata_preparer'
        AND u.deactivated_at IS NULL
   )
 ORDER BY e.name
 LIMIT 1
ON CONFLICT (id) DO NOTHING;

INSERT INTO app.app_user (id, entity_id, name, role, mock_kyc_verified, institutional_eligible)
SELECT '11111111-0000-0000-0000-000000000002', e.id, 'Hsu Po-Chun', 'adata_checker', true, false
  FROM app.entity e
 WHERE e.entity_type = 'anchor'
   AND NOT EXISTS (
     SELECT 1 FROM app.app_user u
     JOIN app.entity x ON x.id = u.entity_id
      WHERE x.entity_type = 'anchor'
        AND u.role = 'adata_checker'
        AND u.deactivated_at IS NULL
   )
 ORDER BY e.name
 LIMIT 1
ON CONFLICT (id) DO NOTHING;

INSERT INTO app.app_user (id, entity_id, name, role, mock_kyc_verified, institutional_eligible)
SELECT '11111111-0000-0000-0000-000000000008', e.id, 'Nadia Rahman', 'straitsx_admin', true, false
  FROM app.entity e
 WHERE e.entity_type = 'platform'
   AND NOT EXISTS (
     SELECT 1 FROM app.app_user
      WHERE role = 'straitsx_admin' AND deactivated_at IS NULL
   )
 ORDER BY e.name
 LIMIT 1
ON CONFLICT (id) DO NOTHING;
