const fs=require('fs'),path=require('path'),crypto=require('crypto'),{Client}=require('pg');
const {buildExistingArMergeSql}=require('../lib/approvedExistingArMerge');
const aliases=require('../lib/memberCodeAliases'),contacts=require('../lib/memberContactPhones');
const url=process.env.SCCRM_CONTACT_MERGE_TEST_DATABASE_URL,run=url?describe:describe.skip;
jest.setTimeout(30000);
run('explicit existing AR family operator',()=>{
 let db,admin,name;const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222',c='33333333-3333-4333-8333-333333333333';
 const fixture=()=>[{member_id:b,current_code:'ADA-AR001-000123',primary_code:'AR001-000123',phone:'0812345678',native_codes:[{code:'AR001-000123',hash:'a'.repeat(64),owner:b},{code:'AR003-000456',hash:'b'.repeat(64),owner:c}],retire_members:[{id:a,code:'SCM-11111111',phone:'0812345678',stub:false},{id:c,code:'AR003-000456',phone:null,stub:true}]}];
 beforeAll(async()=>{
  const u=new URL(url);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||!u.pathname.startsWith('/sccrm_contact_merge_test'))throw Error('ISOLATED_EXISTING_AR_TEST_REQUIRED');
  name='sccrm_contact_merge_test_'+crypto.randomBytes(6).toString('hex');u.pathname='/postgres';admin=new Client({connectionString:u.href});await admin.connect();await admin.query('CREATE DATABASE '+name);u.pathname='/'+name;db=new Client({connectionString:u.href});await db.connect();
  await db.query(`CREATE SCHEMA ada_history;CREATE SCHEMA ada_points;CREATE SCHEMA sccrm_member_codes;
   CREATE TABLE users(id uuid PRIMARY KEY,full_name text,phone_number text,email text,is_verified bool DEFAULT false,password_hash text);
   CREATE TABLE member_profiles(user_id uuid PRIMARY KEY REFERENCES users,member_code text UNIQUE,is_active bool DEFAULT true,contact_phone text,remark text,updated_at timestamptz DEFAULT now());
   CREATE TABLE crm_member_consents(id uuid PRIMARY KEY,user_id uuid REFERENCES users,consent_version text);
   CREATE TABLE loyalty_claims(id uuid PRIMARY KEY,user_id uuid REFERENCES users,receipt_no text,total numeric);
   CREATE TABLE ada_history.customers(source_id text,ada_code text,payload_hash text,active text,phone text);
   CREATE TABLE ada_history.member_links(member_id uuid,source_id text,ada_code text,approval_reference text,PRIMARY KEY(source_id,ada_code));
   CREATE TABLE ada_points.balance_cache(ada_code text,balance numeric,state text,observed_at timestamptz DEFAULT now());
   CREATE TABLE sccrm_member_codes.assignments(member_id uuid);CREATE TABLE sccrm_member_codes.aliases(code text,member_id uuid);
   CREATE TABLE ada_history.member_merges(source_member_id uuid PRIMARY KEY REFERENCES users,target_member_id uuid REFERENCES users,source_code text,target_code text,source_phone text,primary_phone text,approval_reference text,before_state jsonb);`);
 },30000);
 afterAll(async()=>{delete process.env.SC_OFFICIAL_MEMBER_CODE_ALIASES_ENABLED;delete process.env.SC_OFFICIAL_ADA_SYNC_ENABLED;if(db)await db.end();if(admin){if(name)await admin.query('DROP DATABASE '+name);await admin.end();}});
 beforeEach(async()=>{
  await db.query('TRUNCATE ada_history.member_merges,crm_member_consents,loyalty_claims,member_profiles,users,ada_history.member_links,ada_history.customers,ada_points.balance_cache CASCADE');
  await db.query("INSERT INTO users(id,full_name,phone_number,is_verified,password_hash) VALUES($1,'Synthetic Person','0812345678',true,'fixture only'),($2,'Synthetic Person',NULL,false,NULL),($3,'Synthetic Person',NULL,false,NULL)",[a,b,c]);
  await db.query("INSERT INTO member_profiles(user_id,member_code) VALUES($1,'SCM-11111111'),($2,'ADA-AR001-000123'),($3,'AR003-000456')",[a,b,c]);
  await db.query("INSERT INTO ada_history.customers VALUES('hq000/AdaAcc','AR001-000123',$1,'1','0812345678'),('hq000/AdaAcc','AR003-000456',$2,'1','081-2345678')",['a'.repeat(64),'b'.repeat(64)]);
  await db.query("INSERT INTO ada_history.member_links VALUES($1,'hq000/AdaAcc','AR001-000123','old primary approval'),($2,'hq000/AdaAcc','AR003-000456','old alias approval')",[b,c]);
  await db.query("INSERT INTO ada_points.balance_cache(ada_code,balance,state) VALUES('AR001-000123',0,'ready'),('AR003-000456',0,'ready')");
 });
 test('keeps canonical bill owner, joins old AR codes and preserves native point rows',async()=>{
  const claim=crypto.randomUUID(),consent=crypto.randomUUID();await db.query("INSERT INTO loyalty_claims VALUES($1,$2,'S-SYNTHETIC',150)",[claim,b]);await db.query("INSERT INTO crm_member_consents VALUES($1,$2,'original')",[consent,a]);
  await db.query(buildExistingArMergeSql(fixture(),'explicit fixture approval'));
  expect((await db.query('SELECT user_id,total FROM loyalty_claims WHERE id=$1',[claim])).rows[0]).toEqual({user_id:b,total:'150'});
  expect((await db.query('SELECT member_id FROM ada_history.member_links ORDER BY ada_code')).rows.map(x=>x.member_id)).toEqual([b,b]);
  expect((await db.query('SELECT source_member_id FROM ada_history.member_merges ORDER BY source_member_id')).rows.map(x=>x.source_member_id)).toEqual([a,c]);
  expect((await db.query('SELECT balance FROM ada_points.balance_cache')).rows.map(x=>x.balance)).toEqual(['0','0']);
  expect((await db.query('SELECT user_id,consent_version FROM crm_member_consents')).rows[0]).toEqual({user_id:b,consent_version:'original'});
  process.env.SC_OFFICIAL_MEMBER_CODE_ALIASES_ENABLED='true';process.env.SC_OFFICIAL_ADA_SYNC_ENABLED='true';
  for(const code of ['AR001-000123','AR003-000456','ADA-AR001-000123'])expect(await aliases.findMemberIdByCode(db,code)).toBe(b);
  const q=`SELECT user_id FROM member_profiles m WHERE m.is_active AND ${contacts.linkedCodesMatchSql('m.user_id','$1')}`;
  expect((await db.query(q,['%AR003-000456%'])).rows.map(x=>x.user_id)).toEqual([b]);
 });
 test('unowned approved AR link is prepared for the normal worker, without fabricating an assignment',async()=>{
  await db.query('DELETE FROM ada_history.member_links');const f=fixture()[0];f.member_id=a;f.current_code='SCM-11111111';f.native_codes=[{code:'AR001-000123',hash:'a'.repeat(64),owner:null}];f.retire_members=[];
  await db.query(buildExistingArMergeSql([f],'explicit adoption approval'));
  expect((await db.query('SELECT member_id FROM ada_history.member_links')).rows[0].member_id).toBe(a);
  expect((await db.query('SELECT member_code FROM member_profiles WHERE user_id=$1',[a])).rows[0].member_code).toBe('SCM-11111111');
  expect((await db.query('SELECT count(*) FROM sccrm_member_codes.assignments')).rows[0].count).toBe('0');
 });
 test('new source bills or changed native ownership abort the whole transaction',async()=>{
  await db.query("INSERT INTO loyalty_claims VALUES($1,$2,'S-NEW',20)",[crypto.randomUUID(),a]);
  await expect(db.query(buildExistingArMergeSql(fixture(),'approved'))).rejects.toThrow('EXISTING_AR_SOURCE_HAS_DATA');await db.query('ROLLBACK');
  expect((await db.query('SELECT count(*) FROM ada_history.member_merges')).rows[0].count).toBe('0');
  await db.query('DELETE FROM loyalty_claims');await db.query("UPDATE ada_history.member_links SET member_id=$1 WHERE ada_code='AR003-000456'",[a]);
  await expect(db.query(buildExistingArMergeSql(fixture(),'approved'))).rejects.toThrow('EXISTING_AR_OWNER_CHANGED');await db.query('ROLLBACK');
  expect((await db.query('SELECT is_active FROM member_profiles WHERE user_id=$1',[a])).rows[0].is_active).toBe(true);
 });
 test('native code lookup still refuses two active owners',async()=>{
  process.env.SC_OFFICIAL_MEMBER_CODE_ALIASES_ENABLED='true';process.env.SC_OFFICIAL_ADA_SYNC_ENABLED='true';
  await db.query("UPDATE member_profiles SET member_code='AR001-000123' WHERE user_id=$1",[a]);
  await expect(aliases.findMemberIdByCode(db,'AR001-000123')).rejects.toMatchObject({code:'MEMBER_CODE_AMBIGUOUS',status:409});
 });
});
