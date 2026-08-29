const pool = require("../../../../db");
const { getTables } = require("../tables");

const BRANCH_CODE = "004";
const DOCUMENT_TYPE = "standard_credit_quotation";

function effectKey(shopCode, orderNumber) {
  return JSON.stringify([BRANCH_CODE, shopCode, orderNumber, DOCUMENT_TYPE]);
}

async function listExistingEffects(shopCode, orderNumbers, client = null) {
  const db = client || pool;
  const uniqueOrderNumbers = [...new Set((Array.isArray(orderNumbers) ? orderNumbers : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))]
    .sort();
  if (!uniqueOrderNumbers.length) return [];

  const tables = getTables();
  const result = await db.query(
    `
      SELECT id, shop_code, order_number, current_status, created_at
      FROM ${tables.adaSmartShopeeJobs}
      WHERE branch_code = $1
        AND shop_code = $2
        AND document_type = $3
        AND order_number = ANY($4::text[])
      ORDER BY order_number ASC
    `,
    [BRANCH_CODE, shopCode, DOCUMENT_TYPE, uniqueOrderNumbers],
  );

  return result.rows.map((row) => ({
    effectKey: effectKey(row.shop_code, row.order_number),
    id: row.id,
    orderNumber: row.order_number,
    shopCode: row.shop_code,
    status: row.current_status,
  }));
}

async function queueDryRunPlan(plan, confirmation) {
  const readyOrders = (Array.isArray(plan?.orders) ? plan.orders : [])
    .filter((order) => order.status === "ready");
  const client = await pool.connect();
  const tables = getTables();
  const jobs = [];
  let duplicateCount = 0;

  try {
    await client.query("BEGIN");

    for (const order of readyOrders) {
      // The only persisted payload is the already-validated POS effect. Product names, source
      // rows, buyer data, addresses, tracking numbers, and storage locations are excluded.
      // eslint-disable-next-line no-await-in-loop
      const inserted = await client.query(
        `
          INSERT INTO ${tables.adaSmartShopeeJobs} (
            processing_record_id,
            upload_id,
            source_file_id,
            source_checksum_sha256,
            plan_digest,
            branch_code,
            shop_code,
            order_number,
            document_type,
            cycle_key,
            period_start,
            period_end,
            cycle_contract_revision,
            product_catalog_version,
            product_catalog_digest,
            erp_source_checksum,
            customer_policy_key,
            customer_code,
            customer_policy_revision,
            confirmed_by,
            confirmation_auth_source,
            payload,
            current_status
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
            $21, $22::jsonb, 'queued_dry_run'
          )
          ON CONFLICT (branch_code, shop_code, order_number, document_type) DO NOTHING
          RETURNING id, order_number, current_status
        `,
        [
          plan.processing.processingRecordId,
          plan.processing.uploadId,
          plan.processing.sourceUploadId,
          plan.processing.sourceChecksumSha256,
          plan.planDigest,
          BRANCH_CODE,
          plan.shop.code,
          order.orderNumber,
          DOCUMENT_TYPE,
          plan.cycle.cycleKey,
          plan.cycle.periodStart,
          plan.cycle.periodEnd,
          plan.cycle.cycleContractRevision,
          plan.catalog.catalogVersion,
          plan.catalog.catalogDigest,
          plan.catalog.erpSourceChecksum,
          plan.policies.customerPolicyKey,
          plan.policies.customerCode,
          plan.policies.customerPolicyRevision,
          confirmation.actor,
          confirmation.authSource,
          JSON.stringify({ lines: order.safeLines }),
        ],
      );

      if (!inserted.rows.length) {
        duplicateCount += 1;
        continue;
      }

      const job = inserted.rows[0];
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `
          INSERT INTO ${tables.adaSmartShopeeJobEvents} (job_id, status, actor, auth_source, metadata)
          VALUES
            ($1, 'draft', $2, $3, $4::jsonb),
            ($1, 'confirmed', $2, $3, $4::jsonb),
            ($1, 'queued_dry_run', $2, $3, $4::jsonb)
        `,
        [
          job.id,
          confirmation.actor,
          confirmation.authSource,
          JSON.stringify({ planDigest: plan.planDigest }),
        ],
      );
      jobs.push({
        id: job.id,
        orderNumber: job.order_number,
        status: job.current_status,
      });
    }

    await client.query("COMMIT");
    return {
      createdCount: jobs.length,
      duplicateCount,
      jobs,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  BRANCH_CODE,
  DOCUMENT_TYPE,
  effectKey,
  listExistingEffects,
  queueDryRunPlan,
};
