'use strict';

// Offline only. Arguments are the captured cohort, canonical proof records,
// pre-121 plan, verified 121 plan, and the exact native part-2 XLSX.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readSalesSourceBuffer } = require('../src/modules/seamless/services/shopeeSalesSourceService');
const { enrichShopeeOrderItems } = require('../src/modules/seamless/services/shopeeProductMatcher');
const { buildAdaSmartCopyPlan } = require('../src/modules/seamless/services/shopeeAdaSmartCopyService');
const { buildCopyVariationMatcher, groupCopyVariationReviews } = require('../src/modules/seamless/services/shopeeCopyVariationMatcher');

const lineKey = (orderNumber, sourceRow) => JSON.stringify([orderNumber, sourceRow]);
const signature = (sku, unit, factor) => JSON.stringify([sku,unit,factor]);
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function allocations(plan) {
  const byLine = new Map();
  for (const row of plan.rows) for (const source of row.sources) {
    const key = lineKey(source.orderNumber, source.sourceRow);
    const values = byLine.get(key) || new Set();
    values.add(JSON.stringify([signature(row.sku,row.unit,source.quantityPerSale),
      source.listingQuantity, source.amountCents, source.priceBasis, source.businessDate, !!row.freeGift,
      source.bundleAllocationPolicyKey, source.sellerAllocationPolicyKey, source.bundleAllocationRole]));
    byLine.set(key, values);
  }
  return byLine;
}

async function main(files) {
  assert.equal(files.length, 5, 'Provide cohort, proof records, pre-121 plan, verified plan, native XLSX');
  const [capture, proofs, before, golden] = files.slice(0,4).map(json);
  const { filters, cohort, confirmed } = capture;
  const { sourceFilename, sourceSha256, observedAt } = golden.sourceEvidence[0];
  const source = await readSalesSourceBuffer(fs.readFileSync(path.resolve(files[4])), {
    shopCode:filters.shopCode, sourceFilename, sourceSha256, observedAt:new Date(observedAt).toISOString(),
  });
  const raw = new Map(source.facts.map(order => [order.orderNumber, order]));
  const orders = cohort.orders.map(order => {
    const workbook = raw.get(order.orderNumber);
    assert.equal(order.sourceSha256, source.sourceSha256);
    assert.deepEqual(workbook.sourceRows, order.sourceRows);
    const items = workbook.items.map(({ copySourceIdentity, ...item }, index) => {
      const saved = order.items[index];
      for (const field of ['name','variant','quantity','unitPrice']) assert.equal(item[field],saved[field]);
      return copySourceIdentity ? { ...saved, copySourceIdentity } : saved;
    });
    return { ...order, items:enrichShopeeOrderItems(order.shopCode, items) };
  });
  const candidate = buildCopyVariationMatcher();
  const context = { ...cohort, copyIdentityEvidence:{ status:'available',records:proofs } };
  const run = shadowProductResolver => buildAdaSmartCopyPlan(orders, confirmed, filters,
    cohort.businessDateCorrections, cohort.lineFinancialEvidence, { ...context, shadowProductResolver });
  const legacy = run();
  assert.deepEqual(legacy.rows,golden.rows);
  assert.deepEqual(legacy.dailyReconciliation,golden.dailyReconciliation);
  assert.deepEqual(legacy.columns,golden.columns);
  assert.equal(legacy.status,'ready');
  const failed = new Set(before.issues.filter(i => i.productName).map(i => lineKey(i.orderNumber,i.sourceRow)));
  assert.equal(failed.size,208);
  const expected = allocations(golden);
  const beforeSupported = allocations(before);
  const decisions = new Map();
  const previouslyPassingMatches = new Map();
  const evidence = [];
  let incorrect = 0;
  for (const order of orders) order.items.forEach((item,index) => {
    const key = lineKey(order.orderNumber,order.sourceRows[index]);
    const decision = candidate.resolve(order.shopCode,item,order);
    if (failed.has(key)) decisions.set(key,decision);
    if (decision.status !== 'matched') {
      if (failed.has(key)) evidence.push({ decision, orderNumber:order.orderNumber, productName:item.name, variant:item.variant });
      return;
    }
    const { sku, unit, factor } = decision.product;
    const exact = [...expected.get(key)].map(value => JSON.parse(value)[0]);
    if (exact.length !== 1 || exact[0] !== signature(sku,unit,factor)) incorrect++;
    if (!failed.has(key)) previouslyPassingMatches.set(key,decision.product);
  });
  assert.equal(decisions.size,failed.size);
  assert.equal(incorrect,0);
  const combined = run((_shop, _item, order, index) => {
    const key = lineKey(order.orderNumber,order.sourceRows[index]);
    return decisions.get(key)?.product || previouslyPassingMatches.get(key);
  });
  const isolated = run((_shop, _item, order, index) => {
    const decision = decisions.get(lineKey(order.orderNumber,order.sourceRows[index]));
    return decision && (decision.product || { reason:decision.reasonCode });
  });
  assert.deepEqual(allocations(combined),expected);
  assert.deepEqual(combined.dailyReconciliation,golden.dailyReconciliation);
  assert.deepEqual(combined.allocationPolicies,golden.allocationPolicies);
  assert.deepEqual(combined.columns,golden.columns);
  for (const [key, value] of beforeSupported) assert.deepEqual(expected.get(key),value);
  assert.equal(combined.status,'ready');
  assert.equal(isolated.status,'review_required');
  assert.equal(isolated.columns,null);
  const review = groupCopyVariationReviews(evidence);
  const matched = [...decisions.values()].filter(d => d.status === 'matched');
  assert.equal(matched.length,69);
  assert.equal(review.reduce((sum,g) => sum+g.lineCount,0),139);
  assert.equal(isolated.issues.filter(i => i.productName).length,139);
  const exact121Lines = new Set(golden.rows.flatMap(row => row.sources)
    .filter(source => source.authority === 'verified_seller_pos_copy_only')
    .map(source => lineKey(source.orderNumber,source.sourceRow)));
  assert.ok([...failed].every(key => exact121Lines.has(key)));
  const examples = [...new Map(matched.map(d => [d.product.matchingProvenance.variationId,d.product])).values()]
    .map(({ sku, unit, factor, matchingProvenance:p }) => ({ sku,unit,factor,variationId:p.variationId,method:p.method }));
  console.log(JSON.stringify({ filters, fileSha256:source.sourceSha256, nativeVariationIdLines:orders
    .flatMap(order => order.items).filter(item => item.copySourceIdentity?.variationId).length,
    reviewedLines:failed.size, correctByNewRule:matched.length, heldWithout121Aliases:evidence.length,
    matchedBy121Fallback:evidence.length, incorrect, reviewGroups:review.length,
    priorPassingLinesUnchanged:beforeSupported.size, priorPassingAlsoMatchedByNewRule:previouslyPassingMatches.size,
    allSourceLinesCompared:expected.size,
    pre121Cents:before.totalCents, variationOnlyCents:isolated.totalCents,
    combinedCents:combined.totalCents, businessInsightsCents:combined.targetCents,
    daily:combined.dailyReconciliation.map(day => {
      const partial = isolated.dailyReconciliation.find(row => row.date === day.date);
      return { date:day.date, matchedCents:day.totalCents,targetCents:day.targetCents,
        variationOnlyCents:partial.totalCents, status:day.status };
    }), examples },null,2));
}

main(process.argv.slice(2)).catch(error => {
  console.error(error.message.split('\n')[0]);
  process.exitCode = 1;
});
