-- Private operational queue. Contains no customer, receipt, point or Ada data.
CREATE SCHEMA sccrm_fleet;
REVOKE ALL ON SCHEMA sccrm_fleet FROM PUBLIC, anon, authenticated;
CREATE TABLE sccrm_fleet.settings (id integer PRIMARY KEY CHECK(id=1), enabled boolean NOT NULL DEFAULT false);
INSERT INTO sccrm_fleet.settings(id) VALUES(1);
CREATE TABLE sccrm_fleet.admin_keys (
 id uuid PRIMARY KEY, token_hash char(64) UNIQUE NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 station text NOT NULL CHECK(station='SCPRODUCTDEV'), created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
CREATE TABLE sccrm_fleet.nodes (
 node_id text PRIMARY KEY, branch_code text NOT NULL CHECK(branch_code IN('001','003','004','005')),
 pos_code text NOT NULL CHECK(pos_code IN('001','002')), hostname text NOT NULL, UNIQUE(branch_code,pos_code)
);
INSERT INTO sccrm_fleet.nodes VALUES
 ('nKAsnKMrkZ11CNTRL','001','001','SC_001'),('nEdQXowQ4t11CNTRL','001','002','POS2'),
 ('nFCuxvTVA521CNTRL','003','001','POSSRV'),('nFQPDepQTh11CNTRL','003','002','POS2'),
 ('n3AqXUmdkF11CNTRL','004','001','SERVER004'),('noJJCWPrL221CNTRL','004','002','POS002'),
 ('nSKeeNSVgt11CNTRL','005','001','POSSRV'),('nkbfkybTAP11CNTRL','005','002','FRONT2');
CREATE TABLE sccrm_fleet.devices (
 staff_device_id uuid PRIMARY KEY REFERENCES public.staff_devices(id), node_id text UNIQUE NOT NULL REFERENCES sccrm_fleet.nodes(node_id),
 protocol integer NOT NULL CHECK(protocol=1), version text NOT NULL CHECK(length(version)<=60),
 binary_hash char(64) NOT NULL CHECK(binary_hash ~ '^[a-f0-9]{64}$'),
 readiness text NOT NULL CHECK(readiness IN('idle','busy','waiting_for_user')),
 first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sccrm_fleet.batches (
 id uuid PRIMARY KEY, request_hash char(64) NOT NULL, created_by uuid NOT NULL REFERENCES sccrm_fleet.admin_keys(id),
 release_version text NOT NULL, release_hash char(64) NOT NULL, targets jsonb NOT NULL, result jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sccrm_fleet.jobs (
 id uuid PRIMARY KEY, batch_id uuid NOT NULL REFERENCES sccrm_fleet.batches(id),
 staff_device_id uuid NOT NULL REFERENCES sccrm_fleet.devices(staff_device_id), node_id text NOT NULL REFERENCES sccrm_fleet.nodes(node_id),
 release_version text NOT NULL, release_hash char(64) NOT NULL, release_envelope text NOT NULL CHECK(length(release_envelope)<=65536),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','downloading','waiting_for_idle','installing','restarting','succeeded','failed','cancelled','expired')),
 result_code text CHECK(result_code IS NULL OR result_code ~ '^[A-Z0-9_]{1,80}$'),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '14 days', completed_at timestamptz,
 UNIQUE(batch_id,staff_device_id)
);
CREATE UNIQUE INDEX fleet_one_active_job ON sccrm_fleet.jobs(staff_device_id)
 WHERE state IN('pending','downloading','waiting_for_idle','installing','restarting');
CREATE TABLE sccrm_fleet.events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, job_id uuid NOT NULL REFERENCES sccrm_fleet.jobs(id),
 state text NOT NULL, code text, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sccrm_fleet.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_fleet.admin_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_fleet.nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_fleet.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_fleet.batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_fleet.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sccrm_fleet.events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA sccrm_fleet FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA sccrm_fleet FROM PUBLIC, anon, authenticated;
-- Existing backend uses its private database-owner connection. No browser role
-- or native client receives schema access, a function capability or a DB key.
