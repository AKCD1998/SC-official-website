const orders=jest.fn(async()=>[]),confirmed=jest.fn(async()=>({salesTotal:123,orderCount:4}));
const documents=jest.fn(async()=>({finance:[],returns:[]}));
const reconciliation=jest.fn(async()=>({status:'incomplete',orders:[],shops:[],dateBasis:{salesBatch:'paid_at'}}));
jest.mock('../src/modules/seamless/db/shopeeOrderRepository',()=>({listOrdersForSalesSummary:(...a)=>orders(...a)}));
jest.mock('../src/modules/seamless/services/shopeeConfirmedSalesService',()=>({getConfirmedSalesSummary:(...a)=>confirmed(...a)}));
jest.mock('../src/modules/seamless/services/shopeeOfficialDocumentSummaryService',()=>({getOfficialDocumentSummary:(...a)=>documents(...a)}));
jest.mock('../src/modules/seamless/services/shopeeFinancialReconciliationService',()=>({getShopeeFinancialReconciliation:(...a)=>reconciliation(...a)}));
const {getShopeeSalesSummary}=require('../src/modules/seamless/services/shopeeSalesSummaryService');
beforeEach(()=>jest.clearAllMocks());
test.each([['2026-10-31',31],['2026-10-08',8]])('large primary reports keep source summaries and explicitly defer full order history (%s)',async(endDate,days)=>{
 const result=await getShopeeSalesSummary({shopCode:'sc-drug-store',startDate:'2026-10-01',endDate,includeConfirmed:true,includeOfficialDocuments:true,includeReconciliation:true});
 expect(orders).toHaveBeenCalledTimes(1);expect(confirmed).toHaveBeenCalledTimes(1);expect(documents).toHaveBeenCalledTimes(1);
 expect(reconciliation).not.toHaveBeenCalled();expect(result.confirmedSales).toEqual({salesTotal:123,orderCount:4});
 expect(result.reconciliation).toBeNull();expect(result.reconciliationDeferred).toMatchObject({maxDays:7,requestedDays:days});
 expect(result.accounting.periodReconciliation).toBe('not_evaluated');expect(result.accounting.periodReconciliationDetails).not.toHaveProperty('variance');
});
test.each(['2026-10-01','2026-10-07'])('daily and seven-day reports preserve the existing financial reconciliation (%s)',async(endDate)=>{
 const result=await getShopeeSalesSummary({shopCode:'sc-drug-store',startDate:'2026-10-01',endDate,includeReconciliation:true});
 expect(reconciliation).toHaveBeenCalledTimes(1);expect(result.reconciliation).toMatchObject({status:'incomplete',orderLedgerCount:0});
 expect(result).not.toHaveProperty('reconciliationDeferred');
});
