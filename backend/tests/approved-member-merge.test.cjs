const {buildMergeSql}=require('../lib/approvedMemberMerge');
const row={sourceId:'11111111-1111-4111-8111-111111111111',targetId:'22222222-2222-4222-8222-222222222222',arCode:'AR000-000123',sourcePhone:'081234567',primaryPhone:'0812345678'};
test('operator refuses missing approval, ambiguous cohort and invalid primary identity',()=>{
 expect(()=>buildMergeSql([row],'')).toThrow('MERGE_APPROVAL_REQUIRED');
 expect(()=>buildMergeSql([row,row],'approved')).toThrow('MERGE_OVERLAPPING_COHORT');
 expect(()=>buildMergeSql([{...row,primaryPhone:row.sourcePhone}],'approved')).toThrow('MERGE_IDENTITY_REFUSED');
});
test('merge is held until native aliases and authoritative Ada points are ready',()=>{
 const sql=buildMergeSql([row],"owner's approval");
 expect(sql).toContain('MERGE_APPROVED_NATIVE_CONTACT_NOT_SYNCED');
 expect(sql).toContain('MERGE_ADA_POINTS_NOT_READY');
 expect(sql).toContain('MERGE_SOURCE_HAS_DEPENDENCIES');
 expect(sql).toContain("owner''s approval");
 expect(sql).toContain('SET is_active=false');
 expect(sql).not.toMatch(/UPDATE public.users|INSERT INTO .*point_ledger|UPDATE ada_points|DELETE FROM/);
});
