const {buildReceiptSnapshot,parseHistoryCursor,makeHistoryCursor,mapPurchase}=require('../lib/purchaseHistory');
const items=[{seq:7,productCode:'A',productName:'วิตามิน',qty:2,unitPrice:130,lineTotal:250,barcode:'TEST',lineDiscount:10},
 {seq:9,productCode:'B',productName:'เภสัช test',qty:1,unitPrice:100,lineTotal:100}];
test('original paid amount and line order are distinct from eligible lines and pre-header-discount sum',()=>{
 const snapshot=buildReceiptSnapshot({receiptTotalAmount:340,receiptDiscount:10,posCode:'01',receiptCashierCode:'C1'},items);
 expect(snapshot).toMatchObject({totalAmount:340,totalAmountSource:'pos_header',receiptDiscount:10,posCode:'01',receiptCashierCode:'C1'});
 expect(snapshot.items).toMatchObject(items);expect(snapshot.items.map(i=>i.seq)).toEqual([7,9]);
 const mapped=mapPurchase({id:'claim',receipt_total_amount:'340',total_amount:'250',receipt_snapshot:snapshot},[],[]);
 expect(mapped).toMatchObject({claimId:'claim',totalAmount:340,eligibleAmount:250,items:snapshot.items});
});
test('old request and historical rows retain all items with an explicitly labelled total estimate',()=>{
 expect(buildReceiptSnapshot({},items)).toMatchObject({totalAmount:350,totalAmountSource:'item_sum',receiptDiscount:null});
 expect(mapPurchase({total_amount:'250'},items,[])).toMatchObject({totalAmount:350,eligibleAmount:250,totalAmountSource:'item_sum'});
 expect(mapPurchase({total_amount:'250'},[],[])).toMatchObject({totalAmount:250,totalAmountSource:'legacy_claim'});
});
test.each([-1,Infinity,'NaN',10000001])('rejects invalid receipt totals %s',value=>{
 expect(()=>buildReceiptSnapshot({receiptTotalAmount:value},items)).toThrow();
 expect(()=>buildReceiptSnapshot({receiptDiscount:value},items)).toThrow();
 expect(()=>buildReceiptSnapshot({},[{...items[0],lineDiscount:value}])).toThrow();
});
test('cursor retains PostgreSQL microseconds instead of rounding dates through JavaScript',()=>{
 const row={id:'page-1',sort_sold_at:'2026-10-21 10:12:13.123456+00',sort_created_at:'2026-10-21 10:12:14.654321+00'};
 expect(parseHistoryCursor(makeHistoryCursor(row))).toEqual({v:1,id:row.id,soldAt:row.sort_sold_at,createdAt:row.sort_created_at});
 expect(()=>parseHistoryCursor('invalid')).toThrow('Invalid history cursor');
 expect(()=>parseHistoryCursor(Buffer.from(JSON.stringify({v:1,id:'x',soldAt:'bad',createdAt:row.sort_created_at})).toString('base64url'))).toThrow();
});
