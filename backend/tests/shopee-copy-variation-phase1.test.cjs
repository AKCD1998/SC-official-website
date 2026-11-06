'use strict';

const { buildCopyVariationMatcher, groupCopyVariationReviews } = require('../src/modules/seamless/services/shopeeCopyVariationMatcher');
const registry = require('../src/modules/seamless/data/shopeeAdaSmartCopyRules.v1.json');
const SC = 'sc-drug-store';
const november = { orderedAt:'2026-11-03T00:00:00Z' };
const seed = registry.supplementalCopyIdentities.filter(row => row.variationReusePeriods?.length);
const orderItem = (row, identity = { sourceSku:row.companySku }) => ({
  name:row.productName, variant:row.variant, copySourceIdentity:identity,
});

test.each(seed)('one evidenced Seller variation bridges the renamed $companySku at its POS base factor', row => {
  const matcher = buildCopyVariationMatcher();
  const item = orderItem(row);
  const match = matcher.resolve(SC,item,november);
  expect(match).toMatchObject({ status:'matched',product:{ sku:row.companySku,unit:row.evidence.pos.smallUnit,
    factor:row.quantityPerSale,matchingProvenance:{ method:'unique_seller_alias',variationId:row.evidence.variationId,
      anchorProductName:row.variationReusePeriods[0].prior.productName } } });
  expect(matcher.resolve(SC,{ ...item,name:'Another new title',variant:'New display label',
    copySourceIdentity:{ sourceSku:row.companySku,listingId:row.evidence.listingId,variationId:row.evidence.variationId } },november))
    .toMatchObject({ status:'matched',product:{ sku:row.companySku,matchingProvenance:{ method:'order_variation_id' } } });
  expect(matcher.resolve(SC,{ ...item,name:'Similar title' },november)).toMatchObject({
    status:'review',reasonCode:'no_verified_variation_rule',candidates:expect.arrayContaining([expect.objectContaining({ sku:row.companySku })]),
  });
  expect(matcher.resolve(SC,{ ...item,copySourceIdentity:undefined },november))
    .toMatchObject({ status:'review',reasonCode:'missing_or_invalid_order_identity' });
  expect(matcher.resolve(SC,orderItem(row,{ sourceSku:'WRONG',variationId:row.evidence.variationId }),november))
    .toMatchObject({ status:'review',reasonCode:'order_variation_conflict' });
  expect(matcher.resolve(SC,orderItem(row,{ sourceSku:row.companySku,listingId:'999' }),november))
    .toMatchObject({ status:'review',reasonCode:'order_variation_conflict' });
  expect(matcher.resolve(SC,orderItem(row,{ sourceSku:row.companySku,variationId:'999' }),november))
    .toMatchObject({ status:'review',reasonCode:'order_variation_conflict' });
  expect(matcher.resolve('dr-morepen',item,november)).toBeNull();
});

function offer(name, variationId, factor, validFrom, validThrough) {
  // Simulate approved Air-X offers sharing a base blister SKU.
  const old = seed[0];
  const master = { companySku:'630010147',unit:'แผง',name:'Air-X orange 10-tablet blister' };
  const prior = { ...old.variationReusePeriods[0].prior, productName:`Prior ${name}`, variant:name,
    listingId:'10',variationId,sellerSku:master.companySku };
  const evidence = { ...old.evidence, listingId:prior.listingId,variationId,sellerSku:master.companySku,
    pos:{ ...old.evidence.pos,companySku:master.companySku,smallUnit:master.unit } };
  const anchor = { ...old, productName:prior.productName,variant:prior.variant,
    companySku:master.companySku,quantityPerSale:factor,authority:'verified_synthetic_pack' };
  const current = { ...anchor,productName:'Air-X',variant:name,evidence,variationReusePeriods:[{
    validFrom,validThrough,packBasis:'Synthetic verified pack count',sellerAliasUnique:true,prior,
  }] };
  return { master,anchor,current };
}

function setup(...offers) {
  return buildCopyVariationMatcher({ masters:[offers[0].master],rules:offers.map(o=>o.anchor),
    supplementalCopyIdentities:offers.map(o=>o.current) });
}

test('shared Air-X SKU does not collapse one blister and a 50-blister case', () => {
  const single = offer('1 แผง','101',1,'2026-11-01','2026-11-04');
  const box = offer('50 แผง','102',50,'2026-11-01','2026-11-04');
  const matcher = setup(single,box);
  expect(matcher.resolve(SC,orderItem(single.current),november).product.factor).toBe(1);
  expect(matcher.resolve(SC,orderItem(box.current),november).product.factor).toBe(50);
  const unknown = matcher.resolve(SC,{ ...orderItem(box.current),variant:'Other pack' },november);
  expect(unknown.status).toBe('review');
  expect(unknown.candidates.map(row=>row.variationId)).toEqual(['101','102']);
  expect(matcher.resolve(SC,orderItem(box.current,{sourceSku:'630010147',variationId:'101'}),november))
    .toMatchObject({status:'review',reasonCode:'order_variation_conflict'});
});

test('the same variation uses the verified pack at creation time and holds gaps and overlaps', () => {
  const before = offer('Old package','101',1,'2026-11-01','2026-11-02');
  const after = offer('New package','101',50,'2026-11-03','2026-11-04');
  const matcher = setup(before,after);
  const item = { name:'Renamed again', variant:'',copySourceIdentity:{ sourceSku:'630010147',listingId:'10',variationId:'101' } };
  expect(matcher.resolve(SC,item,{ orderedAt:'2026-11-02T16:59:59Z',paidAt:'2026-11-03T02:00:00Z' }).product.factor).toBe(1);
  expect(matcher.resolve(SC,item,{ orderedAt:'2026-11-02T17:00:00Z' }).product.factor).toBe(50);
  expect(matcher.resolve(SC,{ ...item,name:before.current.productName,variant:before.current.variant },
    { orderedAt:'2026-11-02T17:00:00Z' })).toMatchObject({status:'review',reasonCode:'order_variation_conflict'});
  expect(matcher.resolve(SC,item,{ orderedAt:'2026-11-04T17:00:00Z' }))
    .toMatchObject({status:'review',reasonCode:'outside_verified_pack_period'});
  const overlap = offer('Overlapping package','101',50,'2026-11-02','2026-11-04');
  expect(setup(before,overlap).resolve(SC,item,{ orderedAt:'2026-11-02T16:59:59Z' }))
    .toMatchObject({status:'review',reasonCode:'ambiguous_variation_or_pack_period'});
});

test('a prior explicit identity hold remains a hold with matching source IDs', () => {
  const row = seed[0];
  const matcher = buildCopyVariationMatcher({ ...registry, copyIdentityHolds:[row] });
  const item = orderItem(row,{ sourceSku:row.companySku,listingId:row.evidence.listingId,variationId:row.evidence.variationId });
  expect(matcher.resolve(SC,item,november)).toMatchObject({ status:'review',reasonCode:'existing_copy_identity_hold' });
});

test('ambiguous seller labels and conflicted POS evidence become grouped reviews', () => {
  const one = offer('Identical label','101',1,'2026-11-01','2026-11-04');
  const two = offer('Other prior package','102',1,'2026-11-01','2026-11-04');
  two.current.variant = one.current.variant;
  const ambiguous = setup(one,two).resolve(SC,orderItem(one.current),november);
  expect(ambiguous).toMatchObject({status:'review',reasonCode:'ambiguous_variation_or_pack_period'});
  one.current.evidence.pos.smallUnit = 'กล่อง';
  const matcher = setup(one);
  const conflict = matcher.resolve(SC,orderItem(one.current),november);
  const missing = matcher.resolve(SC,orderItem(one.current,{}),november);
  expect(conflict).toMatchObject({status:'review',reasonCode:'seller_pos_pack_evidence_conflict'});
  const entry = (decision,orderNumber) => ({decision,orderNumber,productName:'Air-X',variant:one.current.variant});
  expect(groupCopyVariationReviews([entry(conflict,'ORDER-A'),entry(conflict,'ORDER-A'),entry(missing,'ORDER-B')]))
    .toEqual([expect.objectContaining({lineCount:3,orderNumbers:['ORDER-A','ORDER-B'],
      reasonCodes:['missing_or_invalid_order_identity','seller_pos_pack_evidence_conflict']})]);
});
