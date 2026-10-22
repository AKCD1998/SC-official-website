const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {run}=require('../scripts/shopee004-stock-control.cjs');
const env={SHOPEE004_ADMIN_USER:'synthetic-human',SHOPEE004_ADMIN_PASSWORD:'synthetic-private-password'};
test('operator tool requires human credentials and never uses an internal token',async()=>{
  const fetchImpl=jest.fn();await expect(run({command:'status',env:{INTERNAL_API_TOKEN:'not-human'},fetchImpl})).rejects.toThrow('HUMAN_ADMIN_CREDENTIAL_REQUIRED');
  expect(fetchImpl).not.toHaveBeenCalled();
});
test('status output is aggregate only even if an upstream body includes private records',async()=>{
  const result=await run({command:'status',env,fetchImpl:async(url,options)=>{
    expect(url).toMatch(/^https:\/\/sc-official-website\.onrender\.com\/api\/app\/shopee\/stock-commitments\/status$/);
    expect(options.redirect).toBe('error');return {ok:true,json:async()=>({status:'available',records:[{orderNumber:'PRIVATE'}],planId:'private',pendingOrders:0})};
  }});expect(result).toEqual({status:'available',pendingOrders:0});
});
test('plan stores approval privately with exclusive-create and leaves it out of console result',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'stock004-control-'));
  const input=path.join(dir,'input.json'),receipt=path.join(dir,'receipt.json');
  try{
    await fs.writeFile(input,JSON.stringify({openingOrderNumbers:[],posCatalog:[]}));
    const fetchImpl=async()=>({ok:true,json:async()=>({mode:'planned',planId:'synthetic-approval',pendingOrders:0,activated:false})});
    const result=await run({command:'plan',inputFile:input,receiptFile:receipt,env,fetchImpl});
    expect(result).not.toHaveProperty('planId');expect(JSON.parse(await fs.readFile(receipt,'utf8'))).toMatchObject({planId:'synthetic-approval',
      openingOrdersVerified:false,olderShippedReconciledInPosBasis:false,emailFeedChecked:false,unpostedPosWorkflow:false});
    await expect(run({command:'plan',inputFile:input,receiptFile:receipt,env,fetchImpl})).rejects.toThrow('PRIVATE_RECEIPT_ALREADY_EXISTS');
  }finally{await fs.unlink(input);await fs.unlink(receipt).catch(()=>{});await fs.rmdir(dir);}
});
test('review queue goes only to a new private file; console output has no order or cursor',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'stock004-queue-')),receipt=path.join(dir,'queue.json');
  try {
    const result=await run({command:'review-queue',receiptFile:receipt,env,fetchImpl:async(url,options)=>{
      expect(url).not.toContain('?');expect(options.method).toBe('POST');
      return {ok:true,json:async()=>({records:[{orderNumber:'PRIVATEORDER',reasons:['confirmation-missing']}],hasMore:false,nextCursor:null})};
    }});
    expect(result).toEqual({pendingReviewCount:1,hasMore:false});
    expect(JSON.stringify(result)).not.toContain('PRIVATEORDER');
    expect(JSON.parse(await fs.readFile(receipt,'utf8')).records).toHaveLength(1);
  }finally{await fs.unlink(receipt).catch(()=>{});await fs.rmdir(dir);}
});
