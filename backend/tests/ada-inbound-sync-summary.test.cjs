const logs=require('../lib/sccrmSyncLog');
const id='11111111-1111-4111-8111-111111111111';
afterEach(()=>{delete process.env.SC_OFFICIAL_SCCRM_HISTORY_FIRST_ENABLED;delete process.env.SC_OFFICIAL_ADA_POINTS_MODE;});
test.each([false,true])('native history profiles are existing Ada contacts, including branch fallback %s',async branch=>{
 process.env.SC_OFFICIAL_SCCRM_HISTORY_FIRST_ENABLED='true';process.env.SC_OFFICIAL_ADA_POINTS_MODE='ada-primary';
 const db={query:jest.fn(async()=>({rows:[{id,imported_code:'AR001-000001',branch_profile:branch,branches:[]}]}))};
 const result=(await logs.summaries(db,[id])).get(id);
 expect(result).toMatchObject({state:'existing',code:branch?'ADA_BRANCH_PROFILE_VERIFIED':'ADA_EXISTING',hqReady:!branch,adaCode:'AR001-000001'});
 expect(result.label).not.toContain('SCCRM บันทึกแล้ว');
 expect(db.query.mock.calls[0][0]).toContain("d.source='ada'");
 expect(db.query.mock.calls[0][0]).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/);
});
