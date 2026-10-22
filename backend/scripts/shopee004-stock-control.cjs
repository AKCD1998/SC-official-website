#!/usr/bin/env node
'use strict';
// An operator tool, not a cron, ingest command or stock writer. Inputs stay in a
// private local file; output is operational counts only. Never accepts secrets
// in command-line arguments or prints HTTP bodies/errors.
const fs = require('node:fs/promises');
const path = require('node:path');
const COMMANDS = new Set(['status','plan','activate','pause','resume','review']);
async function run({ command, inputFile, receiptFile, env = process.env, fetchImpl = fetch }) {
  if (!COMMANDS.has(command)) throw Error('CONTROL_COMMAND_INVALID');
  const user = env.SHOPEE004_ADMIN_USER, password = env.SHOPEE004_ADMIN_PASSWORD;
  if (!user || !password || user.includes(':')) throw Error('HUMAN_ADMIN_CREDENTIAL_REQUIRED');
  let input = {};
  if (inputFile) {
    const stat = await fs.stat(inputFile);
    if (!stat.isFile() || stat.size > 500000) throw Error('PRIVATE_INPUT_INVALID');
    input = JSON.parse(await fs.readFile(inputFile,'utf8'));
  }
  if (['plan','activate','resume','review'].includes(command) && !inputFile) throw Error('PRIVATE_INPUT_REQUIRED');
  if (command === 'plan' && !receiptFile) throw Error('PRIVATE_PLAN_RECEIPT_REQUIRED');
  const response = await fetchImpl(`https://sc-official-website.onrender.com/api/app/shopee/stock-commitments/${command}`, {
    method: command === 'status' ? 'GET' : 'POST', redirect:'error', signal:AbortSignal.timeout(15000),
    headers:{'Authorization':'Basic '+Buffer.from(user+':'+password).toString('base64'),
      'Content-Type':'application/json','x-shopee-stock-action':'1'},
    ...(command === 'status' ? {} : {body:JSON.stringify(input)})
  });
  const data = await response.json();
  if (!response.ok) throw Error(/^[A-Z0-9_]+$/.test(data?.error?.code || '') ? data.error.code : 'CONTROL_REQUEST_FAILED');
  if (command === 'plan') {
    // Exclusive create prevents a stale approval file being replaced silently.
    await fs.writeFile(path.resolve(receiptFile),JSON.stringify({planId:data.planId,
      openingOrdersVerified:false,olderShippedReconciledInPosBasis:false,emailFeedChecked:false,unpostedPosWorkflow:false},null,2),{flag:'wx',mode:0o600});
  }
  return Object.fromEntries(['mode','status','pendingOrders','legacyOrders','reviewOrders','cutoverAt',
    'activated','alreadyActivated','recorded','duplicate','holdsRetained','availabilityBlocked','existingHoldsRetained']
    .filter(k=>Object.hasOwn(data,k)).map(k=>[k,data[k]]));
}
if (require.main === module) {
  const args=process.argv.slice(2), command=args.shift();
  const read = key => {const i=args.indexOf(key);return i < 0 ? undefined : args[i+1];};
  run({command,inputFile:read('--input'),receiptFile:read('--receipt')})
    .then(result=>console.log(JSON.stringify(result)))
    .catch(error=>{console.log(JSON.stringify({status:'CONTROL_STOPPED',
      code:/^[A-Z_]{3,64}$/.test(error.message || '') ? error.message : 'CONTROL_REQUEST_FAILED',
      detailsWithheld:true}));process.exitCode=1;});
}
module.exports={run};
