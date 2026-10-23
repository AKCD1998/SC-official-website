const {selectExceptionItem,publicException}=require('../src/modules/seamless/services/shopee004ExceptionReadModel');
const catalog=new Map(['P1','P2'].map(code=>[code,{companySku:code,stockCode:code,active:true,stockFactor:1,smallFactor:1,smallUnit:'box'}]));
const A={name:'Synthetic valid A',variant:'box',quantity:1},B={name:'Synthetic unmapped B',variant:'pack',quantity:2};
const matched=code=>({status:'matched',companySku:code,quantityUnit:'box'});
const matcher=(_shop,item)=>item.name===A.name?matched('P1'):{status:'unmapped',reasonCode:'product_mapping_unverified'};
const row=items=>({exception_id:'opaque',order_number:'PRIVATEORDER1',items,reasons:['product_mapping_unverified'],audit_revision:'1'});
test('selects the failed second item instead of suggesting the already-valid first item',()=>{
 const source=row([A,B]),selection=selectExceptionItem(source,catalog,{matchItem:matcher}),record=publicException(source,{selection});
 expect(record).toMatchObject({productName:B.name,variantName:B.variant,itemContext:'current-issue',itemIssueConfirmed:true,
  canApproveMapping:true,unresolvedItemCount:1});expect(JSON.stringify(record)).not.toContain('PRIVATEORDER1');
});
test('a fixed mapping naturally exposes the next failed item, without approving an unrelated identity',()=>{
 const C={name:'Synthetic unresolved C',variant:'bottle',quantity:1};
 const matchItem=(_shop,item)=>item.name===A.name?matched('P1'):item.name===B.name?matched('P2'):{status:'unmapped'};
 const source=row([A,B,C]),selection=selectExceptionItem(source,catalog,{matchItem});
 expect(publicException(source,{selection})).toMatchObject({productName:C.name,canApproveMapping:true,unresolvedItemCount:1});
});
test('current and original copies of the same failed item count once',()=>{
 const source={...row([A,B]),source_snapshot:{items:[A,B]}};
 expect(selectExceptionItem(source,catalog,{matchItem:matcher})).toMatchObject({item:B,source:'current-issue',unresolvedItemCount:1});
});
test('an unresolved original identity can be shown without granting a lifecycle approval',()=>{
 const source={...row([A]),reasons:['product_mapping_unverified','order-items-changed-needs-review'],source_snapshot:{items:[B]}};
 const selection=selectExceptionItem(source,catalog,{matchItem:matcher});
 expect(publicException(source,{selection})).toMatchObject({productName:B.name,itemContext:'original-issue',canApproveMapping:true,requiresLifecycleReview:true});
});
test.each(['cancel-dispatch-unverified','mapping-held-contract-changed-needs-review','source-order-time-changed-needs-review'])(
 'a %s exception uses an explicitly unqualified reference, not a fabricated first-item culprit',reason=>{
  const source={...row([A,B]),reasons:[reason]},selection=selectExceptionItem(source,catalog,{matchItem:matcher});
  expect(publicException(source,{selection})).toMatchObject({itemContext:'reference-only',itemIssueConfirmed:false,canApproveMapping:false,unresolvedItemCount:0});
 });
test('a mapping already repaired in the current snapshot cannot offer approval for its valid first item',()=>{
 const source=row([A,B]),matchItem=()=>matched('P1'),selection=selectExceptionItem(source,catalog,{matchItem});
 expect(publicException(source,{selection})).toMatchObject({itemContext:'reference-only',itemIssueConfirmed:false,canApproveMapping:false});
});
test('invalid source quantity is visible but is not repairable by unit/mapping approval',()=>{
 const invalid={...B,quantity:0},source=row([A,invalid]);
 const selection=selectExceptionItem(source,catalog,{matchItem:matcher});
 expect(publicException(source,{selection})).toMatchObject({productName:B.name,itemIssueConfirmed:true,canApproveMapping:false,itemReasonCodes:['sale_quantity_invalid']});
});
test('matcher failures do not leak raw exceptions or certify a guessed target',()=>{
 const source=row([A,B]),selection=selectExceptionItem(source,catalog,{matchItem:()=>{throw Error('private provider failure');}});
 const record=publicException(source,{selection});expect(record.canApproveMapping).toBe(false);
 expect(JSON.stringify(record)).not.toContain('private provider failure');
});
