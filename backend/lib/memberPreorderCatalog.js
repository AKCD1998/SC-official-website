'use strict';
const {text,fail}=require('./memberPreorderModel');
function createCatalog({fetcher=globalThis.fetch,clock=Date.now}={}){
 const cache=new Map();
 async function search(query){
  const q=text(query,100,true);if(q.length<2)fail(400,'พิมพ์ชื่อหรือรหัสสินค้าอย่างน้อย 2 ตัว','CATALOG_QUERY');
  let res,raw;try{res=await fetcher('https://paasrtsm-project.onrender.com/api/products/search?'+new URLSearchParams({q}),{signal:AbortSignal.timeout(5000)});if(!res.ok)throw Error();raw=await res.text();if(raw.length>250000)throw Error()}catch{fail(503,'ค้นหาสินค้าไม่ได้ตอนนี้ กรุณาลองใหม่','CATALOG_UNAVAILABLE')}
  let rows;try{rows=JSON.parse(raw)}catch{fail(503,'ข้อมูลสินค้ายังไม่พร้อม กรุณาลองใหม่','CATALOG_UNAVAILABLE')}
  if(!Array.isArray(rows)||rows.length>100)fail(503,'ข้อมูลสินค้ายังไม่พร้อม กรุณาลองใหม่','CATALOG_UNAVAILABLE');
  const items=rows.filter(r=>typeof r.productCode==='string'&&typeof r.productName==='string').slice(0,30).map(r=>({productCode:r.productCode,productName:r.productName,unit:r.unit||''}));
  for(const row of items){cache.delete(row.productCode);cache.set(row.productCode,{...row,at:clock()})}while(cache.size>1000)cache.delete(cache.keys().next().value);
  return items;
 }
 async function lookup(code){let r=cache.get(code);if(!r||clock()-r.at>3600000)r=(await search(code)).find(p=>p.productCode===code);if(!r)fail(400,'ไม่พบสินค้ารหัส '+code+' กรุณาค้นหาสินค้าใหม่','PRODUCT_NOT_FOUND');return r}
 async function validate(items){
  const codes=[...new Set(items.flatMap(i=>i.productCodes))],known=new Map();
  for(let start=0;start<codes.length;start+=4)await Promise.all(codes.slice(start,start+4).map(async code=>known.set(code,await lookup(code))));
  return items.map(item=>{if(!item.productCodes.length)return {...item,matchStatus:'unresolved'};
   const rows=item.productCodes.map(code=>known.get(code));const key=r=>r.productName.normalize('NFC').replace(/\s+/g,' ').trim()+'|'+r.unit;
   if(new Set(rows.map(key)).size!==1)fail(400,'รหัสอ้างอิงหลายรหัสต้องเป็นสินค้ารายการเดียวกัน','DIFFERENT_CATALOG_PRODUCTS');
   return {...item,productName:rows[0].productName,matchStatus:rows.length>1?'ambiguous':'verified'};
  });
 }
 return {search,validate};
}
module.exports={createCatalog};
