const {mapShopeeStockLines}=require('./shopeeStockReservationShadow');
const {resolveStockProductMatch}=require('./shopeeStockProductMatch');
const {matchShopeeProduct}=require('./shopeeProductMatcher');
const EXACT=new Set(['exact_name_variant','catalog_identity_alias','catalog_name_alias','unique_name']);

// Identity qualification is separate from quantity qualification. Never invent a
// quantity or release an old hold to localize a review.
function resolveReviewScope(entries,catalog,{matchItem=resolveStockProductMatch,identityMatch=matchShopeeProduct}={}){
 const affected=new Set();let unallocatedOrders=0;
 if(!entries.length||entries.length>100)return {complete:false,affected,unallocatedOrders};
 for(const entry of entries){
  if(!Array.isArray(entry.items)||!entry.items.length)return {complete:false,affected,unallocatedOrders};
  let unallocated=false;
  for(const items of [entry.items,...(entry.source_snapshot?[entry.source_snapshot.items]:[])]){
   if(!Array.isArray(items)||!items.length||items.length>1000)return {complete:false,affected,unallocatedOrders};
   for(const item of items){
    if(!item||typeof item!=='object'||Array.isArray(item)){unallocated=true;continue;}
    const mapped=mapShopeeStockLines({items:[item],posCatalog:catalog,matchItem});
    if(mapped.status==='mapped'){for(const line of mapped.lines)affected.add(line.stockCode);continue;}
    const stockMatch=matchItem('sc-drug-store',item,{posCatalog:catalog});
    if(stockMatch.status==='matched'&&catalog.has(stockMatch.companySku)){
     affected.add(catalog.get(stockMatch.companySku).stockCode);continue;
    }
    // Only an exact catalog identity with no contradictory caller identifiers
    // can fence a missing-unit review. Fuzzy names are never stock authority.
    const supplied=['productId','listingProductId','variationId','listingVariationId','barcode','sourceBarcode','variantSku','sourceSku']
      .some(k=>item?.[k]!=null&&String(item[k]).trim());
    const conflicting=['source_identifier_conflict','source_barcode_unverified','verified_mapping_evidence_conflict'].includes(stockMatch.reasonCode);
    const identity=supplied||conflicting?null:identityMatch('sc-drug-store',item);
    if(identity?.status==='matched'&&EXACT.has(identity.matchSource)&&catalog.has(identity.companySku)){
     affected.add(catalog.get(identity.companySku).stockCode);continue;
    }
    unallocated=true;
   }
  }
  for(const code of entry.retained_codes||[])affected.add(code);
  if(unallocated)unallocatedOrders++;
 }
 return {complete:true,affected,unallocatedOrders};
}
module.exports={resolveReviewScope};
