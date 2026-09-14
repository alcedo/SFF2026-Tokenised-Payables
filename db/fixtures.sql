-- Programme fixtures. Not the PRD §12 demo catalogue.
--
-- A hosted database that has the schema but no seed still has to render Shell
-- and run create-payable. Onboarding cannot create the first user: ledger.post
-- requires actor_user_id to reference app.app_user. The anchor and the platform
-- cannot be onboarded (post.sql ADA29). These rows are those fixtures.
--
-- IDs and the ADATA wallet match db/seed.sql so Reset world (drop + seed) and
-- the settlement screen's hardcoded anchor address stay consistent.
--
-- No psql meta-commands: the driver executes this file.

INSERT INTO app.world (t0, offset_days) VALUES (CURRENT_DATE, 0)
ON CONFLICT DO NOTHING;

INSERT INTO app.entity (id, name, entity_type, certification_status, programme_limit_base)
VALUES
  ('e0000000-0000-0000-0000-00000000ada7', 'ADATA Technology Co., Ltd.', 'anchor',   'certified', 250000000000),
  ('e0000000-0000-0000-0000-000000005787', 'StraitsX',                   'platform', 'certified', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO app.wallet (address, entity_id) VALUES
  ('0xada7a0000000000000000000000000000000c21d', 'e0000000-0000-0000-0000-00000000ada7'),
  ('0x57a715000000000000000000000000000000a001', 'e0000000-0000-0000-0000-000000005787')
ON CONFLICT (address) DO NOTHING;

INSERT INTO app.app_user (id, entity_id, name, role, mock_kyc_verified, institutional_eligible)
VALUES
  ('11111111-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-00000000ada7', 'Wei-Ling Chen', 'adata_preparer', true, false),
  ('11111111-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-00000000ada7', 'Hsu Po-Chun',   'adata_checker',  true, false),
  ('11111111-0000-0000-0000-000000000008', 'e0000000-0000-0000-0000-000000005787', 'Nadia Rahman',  'straitsx_admin', true, false)
ON CONFLICT (id) DO NOTHING;
