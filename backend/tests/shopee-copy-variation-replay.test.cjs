'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { HEADERS, readSalesSourceBuffer } = require('../src/modules/seamless/services/shopeeSalesSourceService');
const { buildAdaSmartCopyPlan } = require('../src/modules/seamless/services/shopeeAdaSmartCopyService');
const { enrichShopeeOrderItems } = require('../src/modules/seamless/services/shopeeProductMatcher');
const { runReplay } = require('../scripts/replay-shopee-copy-variation-phase1.cjs');
const registry = require('../src/modules/seamless/data/shopeeAdaSmartCopyRules.v1.json');

test('prospective replay reads multiple original hashes and requires independent match and hold evidence', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'shopee-copy-replay-'));
  try {
    const shopCode='sc-drug-store', date='2026-11-05';
    const rule = registry.supplementalCopyIdentities.find(r => r.companySku === '630020295' && r.variationReusePeriods);
    const orders = [], sources = [], verifiedLines = [];
    for (const [index,sku] of ['630020295','630020296'].entries()) {
      const orderNumber = `SYNTHETIC0${index}`;
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('orders');
      sheet.addRow([...Object.values(HEADERS),'SKU Reference No.']);
      sheet.addRow([orderNumber,'สำเร็จแล้ว',`${date} 12:00`,`${date} 12:01`,rule.productName,rule.variant,
        1,100,100,0,0,'-','-',sku]);
      const sourceFilename = `Order.all.20261105_20261105_part_${index+1}_of_2.xlsx`;
      const observedAt = '2026-11-06T02:42:00.000Z';
      const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
      const file = path.join(dir,sourceFilename);
      await fs.writeFile(file,bytes);
      sources.push(file);
      const source = await readSalesSourceBuffer(bytes,{ shopCode,sourceFilename,observedAt });
      const fact = source.facts[0];
      orders.push({ ...fact,sourceFilename,observedAt,sourceSha256:source.sourceSha256,
        items:fact.items.map(({copySourceIdentity,...item}) => item) });
      verifiedLines.push({ orderNumber,sourceRow:2,sourceSha256:source.sourceSha256,evidenceRef:'synthetic',
        ...(index === 0 ? { outcome:'matched',sku,unit:'ขวด',factor:1 }
          : { outcome:'held',reasonCode:'order_variation_conflict' }) });
    }
    const filters = { shopCode,startDate:date,endDate:date };
    const confirmed = { ...filters,status:'source_backed',salesTotal:200,orderCount:2,
      shops:[{ shopCode,sources:[{ sourceSha256:'a'.repeat(64) }] }] };
    const baseline = buildAdaSmartCopyPlan(orders.map(order => ({
      ...order,items:enrichShopeeOrderItems(shopCode,order.items),
    })),confirmed,filters);
    expect(baseline.status).toBe('ready');
    const input = { capture:{ filters,confirmed,cohort:{ orders,businessDateCorrections:[],lineFinancialEvidence:[] } },
      baseline,sources,verifiedLines,proofs:[] };
    await expect(runReplay(input)).resolves.toMatchObject({
      correctByNewRule:1,heldInCombined:1,independentlyVerifiedSampleLines:2,
      combinedCents:10000,businessInsightsCents:20000,copyReady:false,
    });
    await expect(runReplay({ ...input,sources:sources.slice(0,1) })).rejects.toThrow('workbook coverage');
    await expect(runReplay({ ...input,verifiedLines:verifiedLines.slice(0,1) })).rejects.toThrow('Independent evidence is missing');
    await expect(runReplay({ ...input,verifiedLines:[{ ...verifiedLines[0],factor:10 },verifiedLines[1]] }))
      .rejects.toThrow('Verified SKU, POS unit and multiplier');
  } finally {
    await Promise.all((await fs.readdir(dir)).map(name => fs.unlink(path.join(dir,name))));
    await fs.rmdir(dir);
  }
});
