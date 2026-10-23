'use strict';
const {randomUUID}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {createIdentityRuleMatcher,appendIdentityRule,revokeIdentityRule,normalizeIdentityText,normalizeIdentityUnit}=require('./shopee004IdentityRules');
const {resolveStockProductMatch,getStockBaseUnit}=require('./shopeeStockProductMatch');
const {validateCatalog,fail}=require('./shopee004StockPolicy');
const {normalizeTrustedEvidenceFact,deriveTrustedEvidenceSnapshot}=require('./shopee004TrustedEvidence');
const {buildCatalogIdentityApproval}=require('./shopee004CatalogApproval');
const {itemMatchesIdentity}=require('./shopee004ExceptionReadModel');
const {createLegacyEvidenceGuard}=require('./shopee004LegacyEvidenceGuard');
const {classifyRecoveryFailure}=require('./shopee004RecoveryPolicy');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const aliasKey=x=>JSON.stringify([normalizeIdentityText(x.productName??x.name),normalizeIdentityText(x.variantName??x.variant)]);
const identity=x=>JSON.stringify([x.listingId,x.variationId]);
const sameComponents=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every(x=>b.some(y=>x.productCode===y.productCode&&x.quantityPerSale===y.quantityPerSale&&normalizeIdentityUnit(x.unit)===normalizeIdentityUnit(y.unit)));

function createShopee004IdentityStore({pool,schema,ledger,now=()=>new Date()}){
 if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema))fail('IDENTITY_SCHEMA_INVALID');
 const table=name=>`"${schema}".shopee004_stock_identity_${name}`;
 async function transaction(fn,readOnly=false,background=false){
  const c=await pool.connect();let broken=false;
  try{await c.query(readOnly?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN ISOLATION LEVEL SERIALIZABLE');await c.query("SET LOCAL statement_timeout='8s'");await c.query("SET LOCAL lock_timeout='3s'");const result=await fn(c);await c.query('COMMIT');return result;}
  catch(e){try{await c.query('ROLLBACK');}catch{broken=true;}if(background&&classifyRecoveryFailure(e).retryable)throw Object.assign(Error('IDENTITY_RECOVERY_UNAVAILABLE'),{code:e.code});if(e?.statusCode===409)throw e;if(['40001','40P01','55P03','23505'].includes(e?.code))fail('IDENTITY_REVISION_CONFLICT');fail('IDENTITY_OPERATION_FAILED');}
  finally{c.release(broken?new Error('TRANSACTION_NOT_CLOSED'):undefined);}
 }
 async function snapshot(c,control){
  const [rules,proofs]=await Promise.all([
   c.query(`SELECT DISTINCT ON(rule_id) rule FROM ${table('rule_versions')} ORDER BY rule_id,version DESC LIMIT 5001`),
   c.query(`SELECT reference,kind,details FROM ${table('evidence')} ORDER BY created_at DESC LIMIT 20001`)
  ]);
  if(rules.rows.length>5000||proofs.rows.length>20000)fail('IDENTITY_SNAPSHOT_LIMIT');
  const evidenceRefs=deriveTrustedEvidenceSnapshot(new Map(proofs.rows.map(r=>[r.reference,{...r.details,kind:r.kind}])));
  return {versions:rules.rows.map(r=>r.rule),evidenceRefs,posCatalog:validateCatalog(control.pos_catalog)};
 }
 async function mappingContextProvider(c,control){
  const data=await snapshot(c,control),exact=createIdentityRuleMatcher({rules:data.versions,...data}),legacyGuard=createLegacyEvidenceGuard(data);
  const match=(shop,item,options)=>exact(shop,item,options)||legacyGuard(shop,item,resolveStockProductMatch(shop,item,options));
  match.baseUnit=(shop,code)=>exact.baseUnit(shop,code)||getStockBaseUnit(shop,code);
  return match;
 }
 function actorRequired(actor){if(typeof actor!=='string'||!actor.trim()||actor.length>200)fail('HUMAN_ADMIN_REQUIRED');}
 async function control(c,lock=true){const row=(await c.query(`SELECT mode,cutover_at,plan,pos_catalog FROM "${schema}".shopee004_stock_control WHERE singleton=1 ${lock?'FOR SHARE':''}`)).rows[0];if(!['live','paused'].includes(row?.mode))fail('ACTIVE_CUTOVER_REQUIRED');return row;}
 async function duplicate(c,operationId,request){
  if(!UUID.test(operationId||''))fail('IDENTITY_OPERATION_ID_INVALID');
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[operationId]);
  const old=(await c.query(`SELECT request,outcome FROM ${table('operations')} WHERE operation_id=$1`,[operationId])).rows[0];
  if(old&&!isDeepStrictEqual(old.request,request))fail('IDENTITY_IDEMPOTENCY_CONFLICT');return old?{...old.outcome,duplicate:true}:null;
 }
 async function storeRule(c,{rule,operationId,actor,exceptionId}){
  await c.query(`INSERT INTO ${table('rule_versions')}(rule_id,version,operation_id,listing_id,variation_id,state,rule,actor,exception_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
   [rule.ruleId,rule.version,operationId,rule.listingId,rule.variationId,rule.state,JSON.stringify(rule),actor,exceptionId||null]);
 }
 async function enqueueRecovery(c,rule,previous,operationId,posCatalog=[]){
  const aliases=[...new Map([...(previous?.aliases||[]),...rule.aliases].map(a=>[aliasKey(a),{productName:a.productName,variantName:a.variantName}])).values()];
  const pos=new Map(posCatalog.map(p=>[p.companySku,p]));
  const identities=[{listingId:rule.listingId,variationId:rule.variationId,aliases}],productCodes=[...new Set([...(previous?.components||[]),...rule.components].flatMap(x=>[x.productCode,pos.get(x.productCode)?.stockCode].filter(Boolean)))];
  await c.query(`INSERT INTO ${table('recovery_jobs')}(operation_id,identities,product_codes) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[operationId,JSON.stringify(identities),JSON.stringify(productCodes)]);
  // The existing maintenance worker resumes the durable cursor. No new job or
  // task is started by an approval request, and lifecycle proof is never added.
 }
 async function approveMapping({operationId,exceptionId,expectedRevision,listingId,variationId,components,evidenceRefs,acknowledgeUnitEvidence,actor}){
  actorRequired(actor);
  if(!UUID.test(exceptionId||'')||acknowledgeUnitEvidence!==true||typeof expectedRevision!=='string'||!expectedRevision||expectedRevision.length>200
   ||typeof listingId!=='string'||typeof variationId!=='string'||!Array.isArray(components)||!Array.isArray(evidenceRefs)||components.length<1||components.length>20||evidenceRefs.length<2||evidenceRefs.length>50)fail('IDENTITY_APPROVAL_INVALID');
  const request={type:'mapping',exceptionId,expectedRevision,listingId,variationId,components,evidenceRefs,acknowledgeUnitEvidence:true};
  return transaction(async c=>{
   const old=await duplicate(c,operationId,request);if(old)return old;
   // Serialize edits to exact identities, including different operation IDs.
   await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[identity({listingId,variationId})]);
   const context=await ledger().exceptionContext({exceptionId,expectedRevision,client:c});
   if(!context.record.canApproveMapping)fail('MAPPING_NOT_APPLICABLE_TO_EXCEPTION');
   await c.query(`SELECT order_number FROM "${schema}".shopee_orders WHERE shop_code='sc-drug-store' AND order_number=$1 FOR SHARE`,[context.orderNumber]);
   await c.query(`SELECT order_number FROM "${schema}".shopee004_stock_dirty WHERE order_number=$1 FOR UPDATE`,[context.orderNumber]);
   const fresh=await ledger().exceptionContext({exceptionId,expectedRevision,client:c});
   const data=await snapshot(c,fresh.control),facts=evidenceRefs.map(ref=>data.evidenceRefs.get(ref));
   if(facts.some(f=>!f||f.verified!==true||f.listingId!==listingId||f.variationId!==variationId))fail('IDENTITY_EVIDENCE_SCOPE_CONFLICT');
   const catalog=facts.find(f=>f.kind==='seller_catalog');if(!catalog)fail('IDENTITY_CATALOG_EVIDENCE_REQUIRED');
   const unitFacts=facts.filter(f=>['seller_description','owner_unit','reviewed_stock_rule'].includes(f.kind)&&sameComponents(f.components,components));
   const aliases=[...new Map(unitFacts.flatMap(f=>f.aliases||[]).map(a=>[aliasKey(a),{productName:a.productName,variantName:a.variantName,evidenceRefs:evidenceRefs.filter(ref=>(data.evidenceRefs.get(ref)?.aliases||[]).some(x=>aliasKey(x)===aliasKey(a)))}])).values()];
   // Bind this approval to the actual failed item selected by the read model.
   // Repeated lines for the same verified variant are not competing identities.
   if(!aliases.some(a=>aliasKey(a)===aliasKey(fresh.record)))fail('IDENTITY_EXCEPTION_TARGET_CONFLICT');
   const matching=[...(fresh.items||[]),...(fresh.originalItems||[])].filter(item=>aliases.some(a=>aliasKey(a)===aliasKey(item)));
   if(!matching.length)fail('IDENTITY_SOURCE_ALIAS_NOT_UNIQUE');
   for(const item of matching){
    const ls=[item.listingId,item.listingProductId,item.productId].filter(x=>x!=null).map(String),vs=[item.variationId,item.listingVariationId].filter(x=>x!=null).map(String);
    if(ls.some(x=>x!==listingId)||vs.some(x=>x!==variationId))fail('SOURCE_IDENTIFIER_CONFLICT');
   }
   const previous=data.versions.find(r=>r.listingId===listingId&&r.variationId===variationId);
   const next=buildCatalogIdentityApproval(data,{listingId,variationId,components,evidenceRefs,acknowledgeUnitEvidence:true,expectedVersion:previous?.version||0,expectedCatalogVersion:catalog.catalogVersion},{now});
   await storeRule(c,{rule:next.rule,operationId,actor,exceptionId});await enqueueRecovery(c,next.rule,previous,operationId,fresh.control.pos_catalog);
   const outcome={recorded:true,duplicate:false,ruleId:next.rule.ruleId,ruleVersion:next.version,requeuedOrders:0,requeuePending:true};
   await c.query(`INSERT INTO ${table('operations')}(operation_id,request,outcome,actor) VALUES($1,$2,$3,$4)`,[operationId,JSON.stringify(request),JSON.stringify(outcome),actor]);
   await c.query(`INSERT INTO "${schema}".shopee004_stock_audit(action,order_number,actor,outcome) VALUES('identity-mapping-approved',$1,$2,$3)`,[fresh.orderNumber,actor,JSON.stringify({ruleId:next.rule.ruleId,ruleVersion:next.version,lifecycleApprovalsAdded:false,openingBoundaryPreserved:true})]);
   return outcome;
  });
 }
 async function approveCatalogMapping({operationId,listingId,variationId,components,evidenceRefs,acknowledgeUnitEvidence,expectedVersion,expectedCatalogVersion,actor}){
  actorRequired(actor);
  const request={type:'catalog-mapping',listingId,variationId,components,evidenceRefs,acknowledgeUnitEvidence,expectedVersion,expectedCatalogVersion};
  return transaction(async c=>{
   const old=await duplicate(c,operationId,request);if(old)return old;
   if(typeof listingId!=='string'||typeof variationId!=='string')fail('CATALOG_MAPPING_APPROVAL_INVALID');
   await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[identity({listingId,variationId})]);
   const ctrl=await control(c),data=await snapshot(c,ctrl),next=buildCatalogIdentityApproval(data,request,{now});
   await storeRule(c,{rule:next.rule,operationId,actor});await enqueueRecovery(c,next.rule,next.previous,operationId,ctrl.pos_catalog);
   const outcome={recorded:true,duplicate:false,ruleId:next.rule.ruleId,ruleVersion:next.version,requeuedOrders:0,requeuePending:true};
   await c.query(`INSERT INTO ${table('operations')}(operation_id,request,outcome,actor) VALUES($1,$2,$3,$4)`,[operationId,JSON.stringify(request),JSON.stringify(outcome),actor]);
   await c.query(`INSERT INTO "${schema}".shopee004_stock_audit(action,actor,outcome) VALUES('identity-catalog-mapping-approved',$1,$2)`,[actor,JSON.stringify({ruleVersion:next.version,lifecycleApprovalsAdded:false,openingBoundaryPreserved:true})]);
   return outcome;
  });
 }
 async function revoke({operationId,ruleId,expectedVersion,reason,actor}){
  actorRequired(actor);if(!UUID.test(ruleId||'')||!Number.isSafeInteger(expectedVersion)||expectedVersion<1||typeof reason!=='string')fail('IDENTITY_REVOCATION_INVALID');
  const request={type:'revoke',ruleId,expectedVersion,reason};
  return transaction(async c=>{
   const prior=await duplicate(c,operationId,request);if(prior)return prior;
   const ctrl=await control(c),data=await snapshot(c,ctrl),previous=data.versions.find(x=>x.ruleId===ruleId);if(!previous)fail('IDENTITY_RULE_NOT_FOUND');
   await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[identity(previous)]);
   let next;try{next=revokeIdentityRule({...data,ruleId,expectedVersion,reason,createdAt:now().toISOString()});}catch{fail('IDENTITY_RULE_REVISION_CONFLICT');}
   await storeRule(c,{rule:next.rule,operationId,actor});await enqueueRecovery(c,next.rule,previous,operationId,ctrl.pos_catalog);
   const outcome={recorded:true,duplicate:false,ruleId,ruleVersion:next.version,requeuedOrders:0,requeuePending:true};
   await c.query(`INSERT INTO ${table('operations')}(operation_id,request,outcome,actor) VALUES($1,$2,$3,$4)`,[operationId,JSON.stringify(request),JSON.stringify(outcome),actor]);return outcome;
  });
 }
 async function drainRecovery(){
  return transaction(async c=>{
   const job=(await c.query(`SELECT * FROM ${table('recovery_jobs')} WHERE NOT completed ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];if(!job)return {queuedOrders:0};
   const result=await ledger().requeueRuleAffected({identities:job.identities,productCodes:job.product_codes,cursor:job.cursor,limit:100,client:c});
   await c.query(`UPDATE ${table('recovery_jobs')} SET cursor=$2,scanned=scanned+$3,completed=$4,updated_at=now() WHERE operation_id=$1`,[job.operation_id,result.nextCursor||job.cursor,result.scannedOrders,!result.hasMore]);
   return {queuedOrders:result.queuedOrders,requeuePending:result.hasMore};
  },false,true);
 }
 async function exceptions(options){
  const base=await ledger().exceptions(options);
  return transaction(async c=>{
   const ctrl=await control(c,false),data=await snapshot(c,ctrl);
   const refs=[...data.evidenceRefs].filter(([,f])=>f.verified===true);
   const ruleIds=data.versions.map(r=>r.ruleId);
   const history=ruleIds.length?(await c.query(`SELECT rule FROM ${table('rule_versions')} WHERE rule_id=ANY($1::uuid[]) ORDER BY created_at DESC,version DESC LIMIT 1250`,[ruleIds])).rows.map(r=>r.rule):[];
   const records=base.records.map(record=>{
    const relevant=refs.filter(([,f])=>(f.aliases||[]).some(a=>aliasKey(a)===aliasKey(record))),catalog=relevant.filter(([,f])=>f.kind==='seller_catalog');
    const scope=new Set(catalog.map(([,f])=>identity(f)));if(scope.size!==1)return {...record,canApproveMapping:false};
    const cat=catalog[0][1],proofs=refs.filter(([,f])=>identity(f)===identity(cat)),unitFact=proofs.find(([,f])=>['seller_description','owner_unit','reviewed_stock_rule'].includes(f.kind)&&(f.aliases||[]).some(a=>aliasKey(a)===aliasKey(record)));
    const current=data.versions.find(r=>identity(r)===identity(cat));
    const proposedMatches=(unitFact?.[1].components||[]).map(component=>({...component,productName:data.posCatalog.get(component.productCode)?.productName||'',evidenceRefs:proofs.map(([ref])=>ref)}));
    let candidateVerified=false;
    if(unitFact)try{buildCatalogIdentityApproval(data,{listingId:cat.listingId,variationId:cat.variationId,components:unitFact[1].components,evidenceRefs:proofs.map(([ref])=>ref),expectedVersion:current?.version||0,expectedCatalogVersion:cat.catalogVersion,acknowledgeUnitEvidence:true},{now});candidateVerified=true;}catch{}
    return {...record,listingId:cat.listingId,variationId:cat.variationId,canApproveMapping:record.canApproveMapping&&candidateVerified,
     evidence:proofs.map(([reference,f])=>({reference,kind:f.kind,label:{seller_catalog:'Seller Centre catalog',seller_description:'Seller description unit evidence',pos_unit:'POS unit metadata',owner_unit:'Owner-confirmed unit evidence',reviewed_stock_rule:'Previously reviewed stock unit rule'}[f.kind],verifiedAt:f.observedAt})),proposedMatches,
     ruleId:current?.ruleId||null,ruleVersion:current?.version||null,auditHistory:history.filter(r=>r.ruleId===current?.ruleId).slice(0,50).map(r=>({action:r.state==='revoked'?'rule_revoked':'mapping_approved',at:r.createdAt,ruleVersion:r.version,reason:r.revocationReason||''}))};
   });return {...base,records};
  },true);
 }
 async function importEvidence({facts,humanEvidenceVerified,actor}){
  actorRequired(actor);if(humanEvidenceVerified!==true||!Array.isArray(facts)||facts.length<1||facts.length>200)fail('TRUSTED_EVIDENCE_IMPORT_INVALID');
  let normalized;try{normalized=facts.map(f=>normalizeTrustedEvidenceFact(f,{now}));}catch{fail('TRUSTED_EVIDENCE_IMPORT_INVALID');}
  return transaction(async c=>{
   const ctrl=await control(c),before=await snapshot(c,ctrl);let added=0;
   const changedScopes=new Map();
   for(const f of normalized){const old=(await c.query(`SELECT kind,details FROM ${table('evidence')} WHERE reference=$1`,[f.reference])).rows[0];if(old){if(old.kind!==f.kind||!isDeepStrictEqual(old.details,f.details))fail('TRUSTED_EVIDENCE_REFERENCE_CONFLICT');continue;}
    await c.query(`INSERT INTO ${table('evidence')}(reference,kind,details,actor) VALUES($1,$2,$3,$4)`,[f.reference,f.kind,JSON.stringify(f.details),actor]);added++;
    const previous=before.versions.find(r=>identity(r)===identity(f.details));
    const key=identity(f.details),scope=changedScopes.get(key)||{previous,aliases:[],components:[]};
    scope.aliases.push(...(f.details.aliases||[]));scope.components.push(...(f.details.components||[]),...(f.details.productCode?[{productCode:f.details.productCode}]:[]));changedScopes.set(key,scope);}
   if(changedScopes.size){
    const held=(await c.query(`SELECT p.source_snapshot,o.items,ARRAY(SELECT l.product_code FROM "${schema}".shopee004_stock_lines l WHERE l.order_number=p.order_number) AS retained_codes
     FROM "${schema}".shopee004_stock_positions p LEFT JOIN "${schema}".shopee_orders o ON o.order_number=p.order_number AND o.shop_code='sc-drug-store'
     WHERE p.state IN ('reserved','shipped_unposted','review_required') LIMIT 20001`)).rows;
    if(held.length>20000)fail('IDENTITY_RECOVERY_SCOPE_LIMIT');
    const pos=new Map(ctrl.pos_catalog.map(p=>[p.companySku,p]));let identities=[],codes=new Set();
    const flush=async()=>{if(!identities.length)return;await c.query(`INSERT INTO ${table('recovery_jobs')}(operation_id,identities,product_codes) VALUES($1,$2,$3)`,[randomUUID(),JSON.stringify(identities),JSON.stringify([...codes])]);identities=[];codes=new Set();};
    for(const [key,scope] of changedScopes){
     const ids=JSON.parse(key),aliases=[...new Map([...(scope.previous?.aliases||[]),...scope.aliases].map(a=>[aliasKey(a),{productName:a.productName,variantName:a.variantName}])).values()];
     const target={listingId:ids[0],variationId:ids[1],aliases};
     const productCodes=new Set([...(scope.previous?.components||[]),...scope.components].flatMap(x=>[x.productCode,pos.get(x.productCode)?.stockCode].filter(Boolean)));
     const related=held.filter(row=>(row.retained_codes||[]).some(code=>productCodes.has(code))||[row.items,row.source_snapshot?.items].filter(Array.isArray).some(items=>items.some(item=>itemMatchesIdentity(item,target))));
     if(!related.length)continue;for(const row of related)for(const code of row.retained_codes||[])productCodes.add(code);
     if(productCodes.size>100)fail('IDENTITY_RECOVERY_SCOPE_LIMIT');
     if(identities.length>=100||new Set([...codes,...productCodes]).size>100)await flush();
     identities.push(target);for(const code of productCodes)codes.add(code);
    }
    await flush();
   }
   return {recorded:true,addedEvidence:added,lifecycleApprovalsAdded:false,openingBoundaryPreserved:true};
  });
 }
 return {mappingContextProvider,approveMapping,approveCatalogMapping,revoke,drainRecovery,exceptions,importEvidence};
}
module.exports={createShopee004IdentityStore};
