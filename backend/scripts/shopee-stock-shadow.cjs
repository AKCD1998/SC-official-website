// Offline shadow input only. No file discovery, network, DB writes or production activation.
const { projectShopeeStockShadow, summarizeStockShadow } = require('../src/modules/seamless/services/shopeeStockReservationShadow');
async function run({ argv = process.argv.slice(2), stdin = process.stdin, output = console.log } = {}) {
  if (argv.length !== 1 || argv[0] !== '--stdin') {
    output(JSON.stringify({ status: 'usage', command: 'node scripts/shopee-stock-shadow.cjs --stdin',
      input: 'private JSON snapshot on stdin; aggregate output only', liveActivationSupported: false }));
    return 2;
  }
  try {
    const chunks = []; let bytes = 0;
    for await (const chunk of stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 16 * 1024 * 1024) throw new Error('limit');
      chunks.push(buffer);
    }
    const result = projectShopeeStockShadow(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    output(JSON.stringify(summarizeStockShadow(result))); return 0;
  } catch {
    output(JSON.stringify({ status: 'SHADOW_INPUT_REJECTED', detailsWithheld: true,
      websiteQuantitiesChanged: false, stockWritesRequested: false })); return 1;
  }
}
if (require.main === module) run().then(code => { process.exitCode = code; });
module.exports = { run };
