const {createShopee004IdentityStore}=require('../src/modules/seamless/services/shopee004IdentityStore');
const copyRules=require('../src/modules/seamless/data/shopeeAdaSmartCopyRules.v1.json');

test('numeric SKU search discovers existing physical copy variants without changing mapping or stock',async()=>{
 const queries=[];
 const product={companySku:'630010105',stockCode:'630010105',productName:'TYLENOL synthetic POS metadata',smallUnit:'แผง',stockFactor:1,smallFactor:1,active:true};
 const client={release:jest.fn(),query:async(input)=>{
  const sql=typeof input==='string'?input:input.text;
  queries.push(sql);
  if(sql.includes('stock_control'))return{rows:[{mode:'live',pos_catalog:[product]}]};
  if(/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK)/.test(sql)||sql.includes('identity_rule_versions')||sql.includes('identity_evidence'))return{rows:[]};
  throw Error('UNEXPECTED_QUERY');
 }};
 const store=createShopee004IdentityStore({pool:{connect:async()=>client},schema:'test_search',ledger:()=>{throw Error('NO_LEDGER_WRITES');}});
 const aliases=await store.stockSearchAliases('630010105');
 const expected=copyRules.rules.filter(r=>r.companySku==='630010105').map(r=>({productName:r.productName,variantName:r.variant}));
 expect(aliases).toEqual(expected);expect(aliases).toHaveLength(3);
 expect(await store.stockSearchAliases('630010106')).toEqual([]);
 product.smallUnit='กล่อง';expect(await store.stockSearchAliases('630010105')).toEqual([]);
 expect(queries.every(q=>/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK|SELECT)/.test(q))).toBe(true);
 expect(client.release).toHaveBeenCalledTimes(3);
});
