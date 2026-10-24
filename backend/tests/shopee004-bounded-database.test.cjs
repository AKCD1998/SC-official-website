const {acquireBoundedStockClient:acquire}=require('../src/modules/seamless/services/shopee004BoundedDatabase');
const {createShopee004StockLedger}=require('../src/modules/seamless/services/shopee004StockLedger');
const {classifyRecoveryFailure}=require('../src/modules/seamless/services/shopee004RecoveryPolicy');
afterEach(()=>jest.useRealTimers());
const rawClient=query=>({query:jest.fn(query||(async()=>({rows:[]}))),release:jest.fn()});
const readTimeout=config=>new Promise((_resolve,reject)=>setTimeout(()=>reject(new Error('Query read timeout')),config.query_timeout));
test('acquisition stops at three seconds, limits pending connects, and releases late clients before any SQL',async()=>{
 jest.useFakeTimers();const resolves=[],pool={connect:jest.fn(()=>new Promise(resolve=>resolves.push(resolve)))};
 const pending=Array.from({length:4},()=>acquire(pool).catch(error=>error));
 await jest.advanceTimersByTimeAsync(3000);const errors=await Promise.all(pending);
 expect(errors.every(e=>e.code==='LEDGER_CONNECTION_ACQUIRE_TIMEOUT'&&e.definitiveNoWrite)).toBe(true);
 await expect(acquire(pool)).rejects.toMatchObject({code:'LEDGER_CONNECTION_QUEUE_FULL',definitiveNoWrite:true});
 expect(pool.connect).toHaveBeenCalledTimes(4);
 const late=Array.from({length:4},()=>rawClient());resolves.forEach((resolve,i)=>resolve(late[i]));
 await Promise.resolve();expect(late.every(c=>c.release.mock.calls.length===1&&!c.query.mock.calls.length)).toBe(true);
 const healthy=rawClient();pool.connect.mockResolvedValueOnce(healthy);const next=await acquire(pool);await next.query('SELECT 1');next.release();
 expect(healthy.query).toHaveBeenCalledWith({text:'SELECT 1',values:undefined,query_timeout:10000});
});
test('a fast acquisition rejects raw provider details with a bounded code and no write claim',async()=>{
 const pool={connect:jest.fn(async()=>{throw Error('private provider credentials in failure');})};
 const error=await acquire(pool).catch(e=>e);expect(error).toMatchObject({code:'LEDGER_CONNECTION_UNAVAILABLE',definitiveNoWrite:true});
 expect(error.message).not.toContain('private provider');
});
test('synchronous connection failure also releases the acquisition budget',async()=>{
 const pool={connect:jest.fn(()=>{throw Error('private');})};
 for(let i=0;i<6;i++)await expect(acquire(pool)).rejects.toMatchObject({code:'LEDGER_CONNECTION_UNAVAILABLE'});
 expect(pool.connect).toHaveBeenCalledTimes(6);
});
test('query read timeout uses node-postgres config, destroys once, and never claims a successful COMMIT',async()=>{
 jest.useFakeTimers();const raw=rawClient(readTimeout),wrapped=await acquire({connect:async()=>raw});
 const assertion=expect(wrapped.query('COMMIT')).rejects.toMatchObject({code:'LEDGER_QUERY_OUTCOME_UNKNOWN',outcomeUnknown:true});
 await jest.advanceTimersByTimeAsync(10000);await assertion;
 expect(wrapped.broken).toBe(true);expect(wrapped.outcomeUnknown).toBe(true);
 wrapped.release();wrapped.release(Error('finally'));expect(raw.release).toHaveBeenCalledTimes(1);
 expect(raw.query).toHaveBeenCalledTimes(1);expect(raw.query.mock.calls[0][0].query_timeout).toBe(10000);
});
test('connection loss destroys rather than reusing a client or echoing network details',async()=>{
 const raw=rawClient(async()=>{throw Object.assign(Error('private network payload'),{code:'ECONNRESET'});});
 const wrapped=await acquire({connect:async()=>raw});
 await expect(wrapped.query('SELECT 1')).rejects.toMatchObject({code:'LEDGER_QUERY_OUTCOME_UNKNOWN',outcomeUnknown:true});
 expect(wrapped.broken).toBe(true);expect(raw.release).toHaveBeenCalledTimes(1);
});
test('server-acknowledged statement timeout leaves rollback usable and does not invent an unknown outcome',async()=>{
 const raw=rawClient(async config=>{if(config.text==='SELECT 1')throw Object.assign(Error('cancelled'),{code:'57014'});return {rows:[]};});
 const wrapped=await acquire({connect:async()=>raw});await expect(wrapped.query('SELECT 1')).rejects.toMatchObject({code:'57014'});
 expect(wrapped.broken).toBe(false);expect(wrapped.outcomeUnknown).toBe(false);await wrapped.query('ROLLBACK');wrapped.release();
 expect(raw.release).toHaveBeenCalledWith(undefined);
});
test('caller query config is not mutated and cannot extend the ten-second read bound',async()=>{
 const raw=rawClient(),wrapped=await acquire({connect:async()=>raw}),config={text:'SELECT $1',values:[1],query_timeout:60000};
 await wrapped.query(config);expect(config.query_timeout).toBe(60000);expect(raw.query.mock.calls[0][0].query_timeout).toBe(10000);
 await wrapped.query({...config,query_timeout:250});expect(raw.query.mock.calls[1][0].query_timeout).toBe(250);wrapped.release();
});
test('ledger read timeout skips an unbounded rollback and releases the broken connection',async()=>{
 jest.useFakeTimers();const raw=rawClient(config=>config.text.includes('AS held_lines')?readTimeout(config):Promise.resolve({rows:[]}));
 const ledger=createShopee004StockLedger({pool:{connect:async()=>raw},schema:'synthetic',enabled:true});
 const assertion=expect(ledger.projection([])).rejects.toMatchObject({code:'LEDGER_QUERY_OUTCOME_UNKNOWN',outcomeUnknown:true});
 await jest.advanceTimersByTimeAsync(10000);await assertion;
 expect(raw.query.mock.calls.some(([config])=>config.text==='ROLLBACK')).toBe(false);expect(raw.release).toHaveBeenCalledTimes(1);
});
test('uncertain ledger write commit is returned as unknown, never retried automatically or labelled no-write',async()=>{
 jest.useFakeTimers();const raw=rawClient(config=>config.text==='COMMIT'?readTimeout(config):Promise.resolve({rows:[{mode:'paused'}],rowCount:1}));
 const pool={connect:jest.fn(async()=>raw)},ledger=createShopee004StockLedger({pool,schema:'synthetic',enabled:true});
 let error;const pending=ledger.pause({actor:'synthetic-admin'}).catch(e=>error=e);
 await jest.advanceTimersByTimeAsync(10000);await pending;
 expect(error).toMatchObject({code:'LEDGER_QUERY_OUTCOME_UNKNOWN',outcomeUnknown:true});expect(error.definitiveNoWrite).not.toBe(true);
 expect(pool.connect).toHaveBeenCalledTimes(1);expect(raw.query.mock.calls.filter(([config])=>config.text.startsWith('UPDATE')).length).toBe(1);
 expect(raw.query.mock.calls.some(([config])=>config.text==='ROLLBACK')).toBe(false);
 expect(raw.release).toHaveBeenCalledTimes(1);expect(classifyRecoveryFailure(error).retryable).toBe(true);
});
test('background serialization conflict remains transient without authorizing automatic POST retries',()=>{
 expect(classifyRecoveryFailure({code:'IDENTITY_REVISION_CONFLICT'})).toMatchObject({retryable:true,issueClass:'temporary'});
});
