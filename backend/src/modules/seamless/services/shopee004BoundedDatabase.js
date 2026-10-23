'use strict';
const pendingByPool=new WeakMap();
const NETWORK=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','ENETUNREACH','EHOSTUNREACH','57P01','57P02','57P03']);
const safeError=(code,extra={})=>Object.assign(new Error(code),{code,statusCode:503,detailsWithheld:true,...extra});
const connectionError=error=>NETWORK.has(error?.code)||/^08[0-9A-Z]{3}$/.test(error?.code||'')
  ||error?.message==='Query read timeout'||error?.message==='Connection terminated unexpectedly'
  ||error?.message==='Connection terminated'||error?.message==='Client was closed and is not queryable'
  ||error?.message==='Client has encountered a connection error and is not queryable';
function wrapClient(raw,queryTimeoutMs) {
 let released=false,broken=false,outcomeUnknown=false;
 function release(error) {
  if(released)return;released=true;
  raw.release(error||(broken?new Error('STOCK_CONNECTION_NOT_REUSABLE'):undefined));
 }
 return {
  get broken(){return broken;},get outcomeUnknown(){return outcomeUnknown;},
  release,
  async query(text,values) {
   if(released||broken)throw safeError('LEDGER_QUERY_OUTCOME_UNKNOWN',{outcomeUnknown:true});
   const config=typeof text==='string'?{text,values}:{...text,...(values===undefined?{}:{values})};
   const requested=config.query_timeout;
   config.query_timeout=typeof requested==='number'&&requested>0?Math.min(requested,queryTimeoutMs):queryTimeoutMs;
   try{return await raw.query(config);}
   catch(error){
    if(connectionError(error)){
     broken=true;outcomeUnknown=true;
     // node-postgres read timeout does not prove server cancellation. Destroy
     // this connection, never reuse it or wait on an unbounded ROLLBACK.
     try{release(new Error('STOCK_CONNECTION_NOT_REUSABLE'));}catch{}
     throw safeError('LEDGER_QUERY_OUTCOME_UNKNOWN',{outcomeUnknown:true});
    }
    throw error;
   }
  },
 };
}
function acquireBoundedStockClient(pool,{acquisitionTimeoutMs=3000,maxPending=4,queryTimeoutMs=10000}={}) {
 if(!pool||typeof pool.connect!=='function'||!Number.isFinite(acquisitionTimeoutMs)||acquisitionTimeoutMs<=0
  ||!Number.isInteger(maxPending)||maxPending<1||!Number.isFinite(queryTimeoutMs)||queryTimeoutMs<=0)
  return Promise.reject(safeError('LEDGER_CONNECTION_UNAVAILABLE',{definitiveNoWrite:true}));
 let state=pendingByPool.get(pool);if(!state){state={pending:0};pendingByPool.set(pool,state);}
 if(state.pending>=maxPending)return Promise.reject(safeError('LEDGER_CONNECTION_QUEUE_FULL',{definitiveNoWrite:true}));
 state.pending++;
 return new Promise((resolve,reject)=>{
  let expired=false;
  const timer=setTimeout(()=>{expired=true;reject(safeError('LEDGER_CONNECTION_ACQUIRE_TIMEOUT',{definitiveNoWrite:true}));},acquisitionTimeoutMs);
  let pending;try{pending=pool.connect();}catch{pending=Promise.reject(safeError('LEDGER_CONNECTION_UNAVAILABLE'));}
  Promise.resolve(pending).then(client=>{
   state.pending--;clearTimeout(timer);
   if(expired){try{client.release();}catch{}return;}
   resolve(wrapClient(client,queryTimeoutMs));
  },()=>{
   state.pending--;clearTimeout(timer);
   if(!expired)reject(safeError('LEDGER_CONNECTION_UNAVAILABLE',{definitiveNoWrite:true}));
  });
 });
}
module.exports={acquireBoundedStockClient};
