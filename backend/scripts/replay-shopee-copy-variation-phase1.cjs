'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { readSalesSourceBuffer } = require('../src/modules/seamless/services/shopeeSalesSourceService');
const { enrichShopeeOrderItems } = require('../src/modules/seamless/services/shopeeProductMatcher');
const { buildAdaSmartCopyPlan } = require('../src/modules/seamless/services/shopeeAdaSmartCopyService');
const { buildCopyVariationMatcher, groupCopyVariationReviews, selectCopyVariationShadowResult } =
  require('../src/modules/seamless/services/shopeeCopyVariationMatcher');

const lineKey = (orderNumber, sourceRow) => JSON.stringify([orderNumber, sourceRow]);
const signature = (sku, unit, factor) => JSON.stringify([sku,unit,factor]);
const reviewedLine = decision => decision?.product?.matchingProvenance?.method === 'reviewed_order_line';
const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u,''));
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

async function withWorkbookIdentities(capture, sources) {
  const lineage = new Map(capture.cohort.orders.map(order => [order.sourceSha256,order]));
  const workbooks = new Map();
  for (const file of sources) {
    const bytes = fs.readFileSync(file);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const order = lineage.get(sha);
    assert.ok(order && !workbooks.has(sha), 'Provide each original Order All XLSX part from the captured cohort once');
    const parsed = await readSalesSourceBuffer(bytes, {
      shopCode:capture.filters.shopCode, sourceFilename:order.sourceFilename,
      sourceSha256:sha, observedAt:new Date(order.observedAt).toISOString(),
    });
    workbooks.set(sha,new Map(parsed.facts.map(fact => [fact.orderNumber,fact])));
  }
  assert.equal(workbooks.size,lineage.size,'Order All workbook coverage');
  return capture.cohort.orders.map(order => {
    const workbook = workbooks.get(order.sourceSha256).get(order.orderNumber);
    assert.ok(workbook,'Order All order identity');
    assert.equal(Date.parse(workbook.orderedAt),Date.parse(order.orderedAt));
    assert.equal(Date.parse(workbook.paidAt || '') || null,Date.parse(order.paidAt || '') || null);
    assert.deepEqual(workbook.sourceRows,order.sourceRows);
    const items = workbook.items.map(({ copySourceIdentity, ...item }, index) => {
      const saved = order.items[index];
      for (const field of ['name','variant','quantity','unitPrice']) assert.equal(item[field],saved[field],field);
      return copySourceIdentity ? { ...saved,copySourceIdentity } : saved;
    });
    return { ...order,items:enrichShopeeOrderItems(order.shopCode,items) };
  });
}

function checkIndependentEvidence(lines, decisions, historical) {
  const expected = new Map();
  for (const line of lines) {
    const key = lineKey(line.orderNumber,line.sourceRow);
    const actual = decisions.get(key);
    assert.ok(actual && line.sourceSha256 === actual.order.sourceSha256 && !expected.has(key), 'Verified line does not bind to one workbook row');
    assert.ok(typeof line.evidenceRef === 'string' && line.evidenceRef.trim(), 'Independent evidence reference is required');
    assert.ok(['matched','held','fallback'].includes(line.outcome), 'Unknown verified outcome');
    expected.set(key,line);
  }
  if (!historical) assert.ok(expected.size,'Provide independently verified sample outcomes');
  for (const [key, actual] of decisions) {
    const line = expected.get(key);
    const { decision } = actual;
    if (!line && (historical ? !reviewedLine(decision) : !selectCopyVariationShadowResult(decision))) continue;
    assert.ok(line, 'Independent evidence is missing for a proposed match or hold');
    const outcome = decision.status === 'matched' ? 'matched' : decision.inScope ? 'held' : 'fallback';
    assert.equal(outcome,line.outcome,'Verified line outcome');
    if (outcome === 'matched') {
      const { sku,unit,factor } = decision.product;
      assert.equal(signature(sku,unit,factor),signature(line.sku,line.unit,line.factor),'Verified SKU, POS unit and multiplier');
    }
    if (outcome === 'held') {
      assert.ok(line.reasonCode,'A verified hold requires its expected reason');
      assert.equal(decision.reasonCode,line.reasonCode,'Verified hold reason');
    }
  }
  return expected.size;
}

async function runReplay({ capture, proofs, baseline, sources, before, verifiedLines, expectedCounts }) {
  const { filters,cohort,confirmed } = capture;
  assert.equal(filters.shopCode,'sc-drug-store');
  for (const key of ['shopCode','startDate','endDate']) assert.equal(filters[key],baseline[key]);
  assert.ok(before || verifiedLines,'Provide a historical benchmark or independently verified new lines');
  if (!before) {
    assert.equal(confirmed.status,'source_backed','The new cohort needs confirmed Business Insights');
    assert.ok(Number.isSafeInteger(baseline.targetCents),'The new cohort needs a verified Business Insights target');
  }
  const orders = await withWorkbookIdentities(capture,sources);
  const matcher = buildCopyVariationMatcher();
  const context = { ...cohort,copyIdentityEvidence:{ status:baseline.copyIdentityReadStatus,records:proofs } };
  const run = shadowProductResolver => buildAdaSmartCopyPlan(orders,confirmed,filters,
    cohort.businessDateCorrections,cohort.lineFinancialEvidence,{ ...context,shadowProductResolver });
  const legacy = run();
  for (const field of ['rows','issues','dailyReconciliation','columns','status','targetCents','sourceLineCount']) {
    assert.deepEqual(legacy[field],baseline[field],`Captured baseline ${field}`);
  }
  const failed = new Set(before?.issues.filter(i => i.productName).map(i => lineKey(i.orderNumber,i.sourceRow)));
  const baselineAllocations = allocations(baseline);
  // The copy plan uses paid/verified business dates. Only source rows that the
  // baseline actually evaluated participate in the shadow comparison.
  const inCohort = new Set([...baselineAllocations.keys(), ...baseline.issues
    .filter(i => i.sourceRow && i.productName).map(i => lineKey(i.orderNumber,i.sourceRow))]);
  const decisions = new Map();
  let incorrect = 0;
  let priorPassingAlsoMatchedByNewRule = 0;
  for (const order of orders) order.items.forEach((item,index) => {
    const key = lineKey(order.orderNumber,order.sourceRows[index]);
    if (!inCohort.has(key)) return;
    assert.ok(!decisions.has(key),'Ambiguous source line key');
    const decision = matcher.resolve(order.shopCode,item,order,order.sourceRows[index]);
    decisions.set(key,{ decision,order,item });
    if (!before || decision.status !== 'matched' || reviewedLine(decision)) return;
    const { sku,unit,factor } = decision.product;
    const exact = [...(baselineAllocations.get(key) || [])].map(value => JSON.parse(value)[0]);
    if (exact.length !== 1 || exact[0] !== signature(sku,unit,factor)) incorrect++;
    if (!failed.has(key)) priorPassingAlsoMatchedByNewRule++;
  });
  const verifiedCount = checkIndependentEvidence(verifiedLines || [],decisions,Boolean(before));
  assert.equal(decisions.size,baseline.sourceLineCount,'Shadow comparison must account for every source line');
  assert.equal(incorrect,0,'Historical matches diverged from PR #121');
  const shadow = (order,index) => decisions.get(lineKey(order.orderNumber,order.sourceRows[index]))?.decision;
  const combined = run((_shop,_item,order,index) => selectCopyVariationShadowResult(shadow(order,index)));
  const combinedAllocations = allocations(combined);
  for (const [key,value] of baselineAllocations) {
    if (selectCopyVariationShadowResult(decisions.get(key)?.decision)) continue;
    assert.deepEqual(combinedAllocations.get(key),value,'Legacy fallback allocation changed');
  }
  for (const [key,{ decision }] of decisions) {
    if (decision.status === 'review' && decision.inScope) {
      assert.ok(!combinedAllocations.has(key),'A held line must not reach copy output');
      assert.equal(combined.columns,null,'A held line must block copy columns');
    }
    if (decision.status === 'matched') {
      const { sku,unit,factor } = decision.product;
      const accepted = [...(combinedAllocations.get(key) || [])].map(value => JSON.parse(value)[0]);
      assert.deepEqual(accepted,[signature(sku,unit,factor)],'Matched identity must be in the accounting output');
      if (reviewedLine(decision) && baselineAllocations.has(key)) {
        const amounts = lines => [...lines].map(line => JSON.parse(line).slice(1));
        assert.deepEqual(amounts(combinedAllocations.get(key)),amounts(baselineAllocations.get(key)),
          'An audited identity must keep its listing quantity and financial attribution');
      }
    }
  }
  const isolated = before && run((_shop,_item,order,index) => {
    const decision = shadow(order,index);
    return selectCopyVariationShadowResult(decision)
      || (decision && failed.has(lineKey(order.orderNumber,order.sourceRows[index])) ? { reason:decision.reasonCode } : null);
  });
  const reviewed = [...decisions].filter(([key]) => !before || failed.has(key));
  const evidence = reviewed.filter(([key,x]) => x.decision.status === 'review'
    && (before || x.decision.inScope || !combinedAllocations.has(key))).map(([,x]) => ({
    decision:x.decision,orderNumber:x.order.orderNumber,productName:x.item.name,variant:x.item.variant,
  }));
  const review = groupCopyVariationReviews(evidence);
  const matched = reviewed.filter(([,x]) => x.decision.status === 'matched');
  const held = reviewed.filter(([,x]) => x.decision.status === 'review' && x.decision.inScope);
  const fallback = reviewed.filter(([key,x]) => x.decision.status === 'review' && !x.decision.inScope && combinedAllocations.has(key));
  const totals = { reviewedLines:reviewed.length,correctByNewRule:matched.length,heldInCombined:held.length,
    legacyFallbackLines:fallback.length,unresolvedOutsidePilot:reviewed.length - matched.length - held.length - fallback.length,
    reviewGroups:review.length,incorrect,reviewedOrderLineMatches:[...decisions.values()].filter(x => reviewedLine(x.decision)).length };
  if (before) {
    assert.equal(reviewed.length,failed.size);
    for (const [key,value] of baselineAllocations) {
      const decision = decisions.get(key)?.decision;
      if ((decision?.status === 'review' && decision.inScope) || reviewedLine(decision)) continue;
      assert.deepEqual(combinedAllocations.get(key),value,'An accepted historical allocation changed');
    }
    assert.deepEqual(combined.allocationPolicies,baseline.allocationPolicies);
    assert.equal(isolated.status,'review_required');
    assert.equal(isolated.columns,null);
  }
  for (const [key,value] of Object.entries(expectedCounts || {})) assert.equal(totals[key],value,key);
  const days = combined.dailyReconciliation || [{
    date:filters.startDate,status:combined.status,totalCents:combined.totalCents,targetCents:combined.targetCents,
  }];
  if (!before) assert.ok(days.every(day => Number.isSafeInteger(day.targetCents)),'A confirmed Business Insights target is required for each day');
  const hardReviews = [...decisions.values()].filter(x => x.decision.status === 'review' && x.decision.inScope);
  const heldGroups = groupCopyVariationReviews(hardReviews.map(x => ({ decision:x.decision,
    orderNumber:x.order.orderNumber,productName:x.item.name,variant:x.item.variant })));
  const priorPassing = before && allocations(before);
  const previouslyPassingHeld = before ? [...priorPassing.keys()].filter(key => !combinedAllocations.has(key)).length : null;
  const previouslyPassingChanged = before ? [...priorPassing].filter(([key,value]) =>
    combinedAllocations.has(key) && !isDeepStrictEqual(combinedAllocations.get(key),value)).length : null;
  return { filters,nativeVariationIdLines:[...decisions.values()].filter(x => x.item.copySourceIdentity?.variationId).length,
    ...totals,independentlyVerifiedSampleLines:verifiedCount,
    ...(before ? { heldWithout121Aliases:evidence.length,previouslyPassingHeld,previouslyPassingChanged,
      priorPassingLinesUnchanged:priorPassing.size - previouslyPassingHeld - previouslyPassingChanged,
      priorPassingAlsoMatchedByNewRule,variationOnlyCents:isolated.totalCents } : {}),
    hardHeldLines:hardReviews.length,
    hardReviewGroups:heldGroups.map(({ productName,variant,lineCount,reasonCodes }) => ({ productName,variant,lineCount,reasonCodes })),
    allSourceLinesCompared:decisions.size,combinedCents:combined.totalCents,businessInsightsCents:combined.targetCents,
    copyReady:combined.status === 'ready',daily:days.map(day => ({
      date:day.date,matchedCents:day.totalCents,targetCents:day.targetCents,status:day.status,
    })) };
}

async function main(files) {
  assert.equal(files.length,1,'Provide the read-only replay manifest JSON');
  const manifest = json(files[0]);
  const base = path.dirname(path.resolve(files[0]));
  const read = file => json(path.resolve(base,file));
  const result = await runReplay({ capture:read(manifest.capture),proofs:read(manifest.proofRecords),
    baseline:read(manifest.baseline),sources:manifest.sources.map(file => path.resolve(base,file)),
    before:manifest.before && read(manifest.before),verifiedLines:manifest.verifiedLines && read(manifest.verifiedLines),
    expectedCounts:manifest.expectedCounts });
  console.log(JSON.stringify(result,null,2));
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(error.message.split('\n')[0]);
  process.exitCode = 1;
});

module.exports = { runReplay };
