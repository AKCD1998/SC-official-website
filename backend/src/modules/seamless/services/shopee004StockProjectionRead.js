'use strict';

// Batch the existing projection reads on its transaction client. One statement
// avoids a network round trip for every small metadata query; it adds no cache,
// stock authority, retry or database object. The caller retains its repeatable-
// read transaction for the optional identity matcher and recovery-product fence.
async function readShopee004ProjectionSnapshot(client,{schema,productCodes}) {
 const table=name=>`"${schema}".shopee004_stock_${name}`;
 const result=await client.query(`WITH
  control AS (SELECT mode,cutover_at,pos_catalog,plan->'openingBasis' AS opening_basis
    FROM ${table('control')} WHERE singleton=1),
  pending AS (SELECT count(*)::int AS count,
    count(*) FILTER(WHERE recovery_revision IS DISTINCT FROM revision OR recovery_state='ready')::int AS ready,
    count(*) FILTER(WHERE recovery_revision=revision AND recovery_state='retry_wait')::int AS retrying,
    count(*) FILTER(WHERE recovery_revision=revision AND recovery_state='blocked')::int AS blocked,
    min(retry_after) FILTER(WHERE recovery_revision=revision AND recovery_state='retry_wait') AS next_retry_at
    FROM ${table('dirty')}),
  review AS (SELECT count(*) FILTER(WHERE state='review_required')::int AS count,
    count(*) FILTER(WHERE warnings ? 'owner-confirmed-source-label-mismatch')::int AS warning_count,
    count(*) FILTER(WHERE warnings ? 'late-legacy-excluded-under-owner-accepted-estimate')::int AS estimate_excluded_count
    FROM ${table('positions')}),
  rule_jobs AS (SELECT count(*)::int AS count FROM "${schema}".shopee004_stock_identity_recovery_jobs WHERE NOT completed),
  held AS (SELECT product_code,min(unit) AS unit,count(DISTINCT unit)::int AS units,
    sum(reserved_quantity)::text AS reserved,sum(shipped_unposted_quantity)::text AS shipped
    FROM ${table('lines')} WHERE product_code=ANY($1::text[]) GROUP BY product_code),
  blocked AS (SELECT o.items,p.source_snapshot,count(*) OVER()::int AS scope_order_count,
    ARRAY(SELECT l.product_code FROM ${table('lines')} l WHERE l.order_number=b.order_number) AS retained_codes
    FROM (SELECT order_number FROM ${table('dirty')} UNION
      SELECT order_number FROM ${table('positions')} WHERE state='review_required') b
    LEFT JOIN "${schema}".shopee_orders o ON o.order_number=b.order_number AND o.shop_code='sc-drug-store'
    LEFT JOIN ${table('positions')} p ON p.order_number=b.order_number
    WHERE EXISTS(SELECT 1 FROM control WHERE mode='live')
      AND ((SELECT count FROM pending)>0 OR (SELECT count FROM review)>0)
    ORDER BY b.order_number LIMIT 100)
  SELECT control.mode,control.cutover_at,control.pos_catalog,control.opening_basis,
    pending.count AS pending_count,pending.ready,pending.retrying,pending.blocked,pending.next_retry_at,
    review.count AS review_count,review.warning_count,review.estimate_excluded_count,rule_jobs.count AS rule_jobs,
    transaction_timestamp() AS at,COALESCE((SELECT max(revision) FROM ${table('audit')}),0)::text AS revision,
    (SELECT max(created_at) FROM "${schema}".shopee_order_events WHERE shop_code='sc-drug-store') AS last_ingested_at,
    COALESCE((SELECT jsonb_agg(to_jsonb(h)) FROM held h),'[]'::jsonb) AS held_lines,
    COALESCE((SELECT jsonb_agg(to_jsonb(b)) FROM blocked b),'[]'::jsonb) AS blocked_scope
  FROM pending CROSS JOIN review CROSS JOIN rule_jobs LEFT JOIN control ON true`,[productCodes]);
 const row=result.rows[0];
 return {
  control:row.mode?{mode:row.mode,cutover_at:row.cutover_at,pos_catalog:row.pos_catalog,opening_basis:row.opening_basis}:undefined,
  pending:{count:row.pending_count,ready:row.ready,retrying:row.retrying,blocked:row.blocked,next_retry_at:row.next_retry_at},
  review:{count:row.review_count,warning_count:row.warning_count,estimate_excluded_count:row.estimate_excluded_count},
  ruleJobs:row.rule_jobs,stamp:{at:row.at,revision:row.revision},feed:{last_ingested_at:row.last_ingested_at},
  heldLines:row.held_lines,blockedScope:row.blocked_scope,
 };
}
module.exports={readShopee004ProjectionSnapshot};
