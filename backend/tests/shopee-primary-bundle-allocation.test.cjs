jest.mock('../db',()=>({query:jest.fn()}));
const {bundleAllocation}=require('../src/modules/seamless/services/shopeeCopyAllocation');
const {buildAdaSmartCopyPlan}=require('../src/modules/seamless/services/shopeeAdaSmartCopyService');
const {copyIdentityKey}=require('../src/modules/seamless/services/shopeeCopyIdentityEvidence');
const shop='sc-drug-store';
const item={name:'Synthetic verified meter kit',variant:'meter+50 strips+100 needles',quantity:1,unitPrice:850,productMatch:{status:'unmapped'}};
// Deliberately use canonical SKU order, where the first component is not the meter.
const parts=[{sku:'IC-001230',factor:2,unit:'กล่อง',name:'needles box of 50'},
 {sku:'IC-004131',factor:1,unit:'กล่อง',name:'meter'},
 {sku:'IC-006009',factor:1,unit:'กล่อง',name:'strips box of 50'}];
const policy=()=>({shopCode:shop,policyKey:'synthetic-main-and-nominal-lines',enabled:true,
 approvedBy:'synthetic-owner',approvedAt:'2026-11-01T00:00:00Z',
 approval:{kind:'user_confirmed_allocation',caseId:'synthetic',responseSha256:'b'.repeat(64)},
 policy:{type:'bundle',productName:item.name,variant:item.variant,method:'primary_component_with_nominal_secondary_lines',
  primarySku:'IC-004131',components:parts.map(p=>({sku:p.sku,factor:p.factor,
   weight:p.sku==='IC-004131'?1:0,...(p.sku==='IC-004131'?{}:{nominalLineCentsPerSale:10})}))}});
const allocate=(p=policy(),i=item,ps=parts,total=85000)=>bundleAllocation([p],shop,i,ps,total);

test('850 becomes 849.80 meter + 0.10 strips + 0.10 for two needle boxes, independent of component order',()=>{
 const result=allocate(),bySku=new Map(result.components.map(c=>[c.sku,c]));
 expect(bySku.get('IC-004131')).toMatchObject({amountCents:84980,factor:1,allocationRole:'primary',freeGift:false});
 expect(bySku.get('IC-006009')).toMatchObject({amountCents:10,factor:1,allocationRole:'nominal_secondary',freeGift:false});
 expect(bySku.get('IC-001230')).toMatchObject({amountCents:10,factor:2,allocationRole:'nominal_secondary',freeGift:false});
 expect(allocate(policy(),item,[...parts].reverse()).components.map(c=>c.amountCents)).toEqual([10,84980,10]);
 expect(result.components.reduce((s,c)=>s+c.amountCents,0)).toBe(85000);
});

function build(quantity=1,amount=85000,{proof=true,biCents=amount,extra=[]}={}){
 const date='2026-10-17',source={sourceSha256:'a'.repeat(64),sourceFilename:'synthetic.xlsx',observedAt:'2026-11-01T00:00:00Z'},
  filters={shopCode:shop,startDate:date,endDate:date},input={...item,quantity,unitPrice:amount/100/quantity},
  order={...source,shopCode:shop,orderNumber:'SYNTHETIC-METER-KIT',paidAt:date+'T03:00:00Z',items:[input,...extra],
   sourceRows:[2,...extra.map((_,i)=>i+3)],itemSubtotal:amount/100+extra.reduce((s,i)=>s+i.unitPrice*i.quantity,0),sellerVoucher:0,shopeeProductDiscount:0},
  confirmed={...filters,status:'source_backed',salesTotal:biCents/100+extra.reduce((s,i)=>s+i.unitPrice*i.quantity,0),orderCount:1,
   shops:[{shopCode:shop,sources:[source]}]},
  context={allocationPolicies:[policy()],copyIdentityEvidence:{status:'available',records:proof?[{key:copyIdentityKey(shop,input),status:'verified',
   basis:'canonical_sc004_seller_pos',snapshotSha256:'c'.repeat(64),components:parts}]:[]}};
 const original=JSON.stringify(order),plan=buildAdaSmartCopyPlan([order],confirmed,filters,[],[],context);
 expect(JSON.stringify(order)).toBe(original);return{plan,again:()=>buildAdaSmartCopyPlan([order],confirmed,filters,[],[],context)};
}

test('real copy builder preserves source money and units and exposes the accounting role without calling components gifts',()=>{
 const {plan,again}=build();expect(plan.status).toBe('ready');expect(plan.totalCents).toBe(85000);
 expect(plan.rows.find(r=>r.sku==='IC-001230')).toMatchObject({quantity:2,unitPrice:'0.05',amountCents:10});
 expect(plan.rows.find(r=>r.sku==='IC-006009')).toMatchObject({quantity:1,unitPrice:'0.10'});
 expect(plan.rows.find(r=>r.sku==='IC-004131')).toMatchObject({quantity:1,unitPrice:'849.80'});
 expect(plan.rows.every(r=>!r.freeGift)).toBe(true);
 expect(plan.rows.find(r=>r.sku==='IC-001230').sources[0]).toMatchObject({bundleAllocationRole:'nominal_secondary',amountCents:10,quantityPerSale:2});
 expect(again()).toEqual(plan);
});

test('purchased-set quantities scale fixed line amounts and the exact odd-satang remainder',()=>{
 const {plan}=build(3,255001);expect(plan.status).toBe('ready');expect(plan.totalCents).toBe(255001);
 expect(plan.rows.filter(r=>r.sku==='IC-004131').map(r=>[r.quantity,r.unitPrice])).toEqual([[1,'849.81'],[2,'849.80']]);
 expect(plan.rows.find(r=>r.sku==='IC-001230')).toMatchObject({quantity:6,unitPrice:'0.05',amountCents:30});
 expect(plan.rows.find(r=>r.sku==='IC-006009')).toMatchObject({quantity:3,unitPrice:'0.10',amountCents:30});
});

test('ordinary secondary-SKU sales consolidate using real source amounts, preserving original line amounts in provenance',()=>{
 const {plan}=build(1,85000,{extra:[{name:'synthetic ordinary needles',variant:'',quantity:1,unitPrice:20,productMatch:{status:'matched',companySku:'IC-001230'}}]});
 expect(plan.status).toBe('ready');expect(plan.totalCents).toBe(87000);
 expect(plan.rows.filter(r=>r.sku==='IC-001230').reduce((s,r)=>s+r.amountCents,0)).toBe(2010);
 const sources=plan.rows.find(r=>r.sku==='IC-001230').sources;
 expect(sources.map(s=>s.amountCents)).toEqual([10,2000]);
});

test('money approval cannot supply missing component identity or waive the daily BI control',()=>{
 expect(build(1,85000,{proof:false}).plan.columns).toBeNull();
 expect(build(1,85000,{biCents:85001}).plan.columns).toBeNull();
 const p=policy();expect(bundleAllocation([],shop,item,parts,85000)).toBeNull();
 expect(bundleAllocation([p,p],shop,item,parts,85000)).toBeNull();
 expect(allocate({...p,enabled:false})).toBeNull();
 expect(bundleAllocation([p],'dr-morepen',item,parts,85000)).toBeNull();
 expect(allocate(p,{...item,name:item.name+' changed'})).toBeNull();
 expect(allocate(p,item,parts.map(c=>({...c,factor:1})))).toBeNull();
});

test.each([0,-1,1.5,undefined,Number.MAX_SAFE_INTEGER+1])('invalid secondary amount %s is rejected',value=>{
 const p=policy();p.policy.components[0].nominalLineCentsPerSale=value;expect(allocate(p)).toBeNull();
});

test('unknown main SKU, competing mains, gift semantics, zero-price precision and overflow stay blocked',()=>{
 const invalid=[];let p=policy();p.policy.primarySku='UNKNOWN';invalid.push(p);
 p=policy();p.policy.components[0].weight=1;invalid.push(p);
 p=policy();p.policy.components[0].freeGift=true;invalid.push(p);
 p=policy();p.policy.components[0].giftUnitPriceCents=5;invalid.push(p);
 p=policy();p.policy.components[1].nominalLineCentsPerSale=10;invalid.push(p);
 p=policy();p.policy.components[0].nominalLineCentsPerSale=1;invalid.push(p);
 for(const v of invalid)expect(allocate(v)).toBeNull();
 expect(allocate(policy(),item,parts,20)).toBeNull();
 expect(allocate(policy(),{...item,quantity:0})).toBeNull();
 expect(allocate(policy(),item,[parts[0],parts[0],parts[1]])).toBeNull();
 expect(allocate(policy(),item,parts,Number.MAX_SAFE_INTEGER+1)).toBeNull();
 // The line allocations must still afford at least one satang per ERP unit.
 p=policy();p.policy.components[0].factor=11;
 expect(allocate(p,item,[{...parts[0],factor:11},...parts.slice(1)])).toBeNull();
});
