"use strict";

const { randomBytes } = require("node:crypto");
const { createId, createOpaqueToken, hashOpaqueToken } = require("./sccrm");

const INVALID = "STAFF_DEVICE_ENROLLMENT_REQUIRED";
const DEVICE_ID = /^[A-Za-z0-9_-]{8,100}$/;
const NODE_ID = /^[A-Za-z0-9]{8,80}$/;
const CODE = /^[A-Za-z0-9_-]{20}$/;

function error(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

function hasFields(body, fields) {
  return body && typeof body === "object" && !Array.isArray(body) &&
    Object.keys(body).length === fields.length && fields.every(field => Object.hasOwn(body, field));
}

async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '8s'");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function lockNode(db, nodeId) {
  const { rows: [node] } = await db.query(
    "SELECT node_id, branch_code, hostname FROM sccrm_fleet.nodes WHERE node_id = $1 FOR UPDATE",
    [nodeId],
  );
  return node;
}

async function readAccess(db, nodeId) {
  const { rows: [access] } = await db.query(
    `SELECT a.staff_device_id, a.code_hash, a.code_expires_at > now() AS code_valid, a.pending_device_id,
            d.staff_device_id AS fleet_device_id, s.revoked_at, b.code AS staff_branch
       FROM sccrm_fleet.nodes n
       LEFT JOIN sccrm_fleet.staff_device_access a USING (node_id)
       LEFT JOIN sccrm_fleet.devices d USING (node_id)
       LEFT JOIN public.staff_devices s ON s.id = COALESCE(a.staff_device_id, d.staff_device_id)
       LEFT JOIN public.branches b ON b.id = s.branch_id
      WHERE n.node_id = $1`,
    [nodeId],
  );
  if (access.staff_device_id && access.fleet_device_id && access.staff_device_id !== access.fleet_device_id) {
    throw error("STAFF_DEVICE_BINDING_CONFLICT", 409);
  }
  return { ...access, device: access.staff_device_id ?? access.fleet_device_id };
}

async function approveCurrent(pool, body, actor) {
  if (!hasFields(body, ["nodeId"]) || typeof body.nodeId !== "string" || !NODE_ID.test(body.nodeId)) {
    throw error("INVALID_STAFF_DEVICE_REQUEST");
  }
  return transaction(pool, async db => {
    const node = await lockNode(db, body.nodeId);
    if (!node) throw error("UNAPPROVED_NODE", 404);
    const access = await readAccess(db, node.node_id);
    if (!access.device || access.revoked_at || access.staff_branch !== node.branch_code) {
      throw error("ACTIVE_STAFF_DEVICE_REQUIRED", 409);
    }
    await db.query(
      `INSERT INTO sccrm_fleet.staff_device_access (node_id, staff_device_id, approved_at, approved_by)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (node_id) DO UPDATE
         SET staff_device_id = EXCLUDED.staff_device_id,
             approved_at = COALESCE(staff_device_access.approved_at, EXCLUDED.approved_at),
             approved_by = COALESCE(staff_device_access.approved_by, EXCLUDED.approved_by),
             pending_device_id = NULL, code_hash = NULL, code_expires_at = NULL, issued_by = NULL`,
      [node.node_id, access.device, actor],
    );
    return { ok: true, state: "approved" };
  });
}

async function issueCode(pool, body, actor) {
  if (!hasFields(body, ["nodeId", "deviceId"]) || typeof body.nodeId !== "string" ||
      typeof body.deviceId !== "string" || !NODE_ID.test(body.nodeId) || !DEVICE_ID.test(body.deviceId)) {
    throw error("INVALID_STAFF_DEVICE_REQUEST");
  }
  return transaction(pool, async db => {
    const node = await lockNode(db, body.nodeId);
    if (!node) throw error("UNAPPROVED_NODE", 404);
    const access = await readAccess(db, node.node_id);
    if (access.device && !access.revoked_at) throw error("STAFF_DEVICE_ALREADY_ACTIVE", 409);

    const { rows: [prior] } = await db.query("SELECT id FROM public.staff_devices WHERE device_id = $1", [body.deviceId]);
    if (prior && prior.id !== access.device) throw error("STAFF_DEVICE_ID_IN_USE", 409);

    const enrollmentCode = randomBytes(15).toString("base64url");
    const { rows: [ticket] } = await db.query(
      `INSERT INTO sccrm_fleet.staff_device_access
         (node_id, staff_device_id, pending_device_id, code_hash, code_expires_at, issued_by)
       VALUES ($1, $2, $3, $4, now() + interval '30 minutes', $5)
       ON CONFLICT (node_id) DO UPDATE
         SET staff_device_id = EXCLUDED.staff_device_id, pending_device_id = EXCLUDED.pending_device_id,
             code_hash = EXCLUDED.code_hash, code_expires_at = EXCLUDED.code_expires_at, issued_by = EXCLUDED.issued_by
       RETURNING code_expires_at`,
      [node.node_id, access.device ?? null, body.deviceId, hashOpaqueToken(enrollmentCode), actor],
    );
    return { ok: true, enrollmentCode, expiresAt: ticket.code_expires_at };
  });
}

async function revoke(pool, body, actor) {
  if (!hasFields(body, ["nodeId"]) || typeof body.nodeId !== "string" || !NODE_ID.test(body.nodeId)) {
    throw error("INVALID_STAFF_DEVICE_REQUEST");
  }
  return transaction(pool, async db => {
    const node = await lockNode(db, body.nodeId);
    if (!node) throw error("UNAPPROVED_NODE", 404);
    const access = await readAccess(db, node.node_id);
    if (access.device) {
      await db.query("UPDATE public.staff_devices SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1", [access.device]);
      await db.query(
        `WITH cancelled AS (
           UPDATE sccrm_fleet.jobs
              SET state = 'cancelled', result_code = 'STAFF_ACCESS_REVOKED', updated_at = now(), completed_at = now()
            WHERE staff_device_id = $1 AND state IN ('pending','downloading','waiting_for_idle','installing','restarting')
           RETURNING id
         )
         INSERT INTO sccrm_fleet.events (job_id, state, code)
         SELECT id, 'cancelled', 'STAFF_ACCESS_REVOKED' FROM cancelled`,
        [access.device],
      );
    }
    await db.query(
      `INSERT INTO sccrm_fleet.staff_device_access (node_id, staff_device_id, last_revoked_at, last_revoked_by)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (node_id) DO UPDATE
         SET pending_device_id = NULL, code_hash = NULL, code_expires_at = NULL, issued_by = NULL,
             last_revoked_at = now(), last_revoked_by = EXCLUDED.last_revoked_by`,
      [node.node_id, access.device ?? null, actor],
    );
    return { ok: true, state: "revoked" };
  });
}

function validateRedemption(body) {
  if (!hasFields(body, ["deviceId", "deviceName", "pin"]) ||
      typeof body.deviceId !== "string" || !DEVICE_ID.test(body.deviceId) ||
      typeof body.deviceName !== "string" || !body.deviceName.trim() || body.deviceName.length > 128 ||
      typeof body.pin !== "string" || !CODE.test(body.pin)) {
    throw error(INVALID, 401);
  }
}

async function redeem(pool, body) {
  validateRedemption(body);
  const codeHash = hashOpaqueToken(body.pin);
  const { rows: [ticket] } = await pool.query("SELECT node_id FROM sccrm_fleet.staff_device_access WHERE code_hash = $1", [codeHash]);
  if (!ticket) throw error(INVALID, 401);
  return transaction(pool, async db => {
    const node = await lockNode(db, ticket.node_id);
    if (!node) throw error(INVALID, 401);
    const access = await readAccess(db, node.node_id);
    if (access.code_hash !== codeHash || access.pending_device_id !== body.deviceId ||
        !access.code_valid || (access.device && !access.revoked_at)) {
      throw error(INVALID, 401);
    }
    const { rows: [branch] } = await db.query(
      "SELECT id, name, code FROM public.branches WHERE code = $1 AND is_active = TRUE",
      [node.branch_code],
    );
    if (!branch) throw error("STAFF_DEVICE_BRANCH_UNAVAILABLE", 409);

    const staffToken = createOpaqueToken();
    const device = access.device ?? createId();
    const params = [device, body.deviceId, node.hostname, hashOpaqueToken(staffToken), branch.id];
    if (access.device) {
      await db.query(
        `UPDATE public.staff_devices
            SET device_id = $2, device_name = $3, token_hash = $4, branch_id = $5,
                last_seen_at = now(), revoked_at = NULL
          WHERE id = $1`,
        params,
      );
    } else {
      await db.query(
        `INSERT INTO public.staff_devices
           (id, device_id, device_name, token_hash, branch_id, last_seen_at, created_at)
         VALUES ($1, $2, $3, $4, $5, now(), now())`,
        params,
      );
    }
    await db.query(
      `UPDATE sccrm_fleet.staff_device_access
          SET staff_device_id = $2, approved_at = now(), approved_by = issued_by,
              pending_device_id = NULL, code_hash = NULL, code_expires_at = NULL, issued_by = NULL
        WHERE node_id = $1`,
      [node.node_id, device],
    );
    return { ok: true, staffToken, branch };
  });
}

module.exports = { approveCurrent, issueCode, revoke, redeem, INVALID };
