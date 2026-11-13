const fs=require('fs'),path=require('path'),crypto=require('crypto'),{Client}=require('pg');
const {buildMergeSql}=require('../lib/approvedMemberMerge'),contacts=require('../lib/memberContactPhones');
const url=process.env.SCCRM_CONTACT_MERGE_TEST_DATABASE_URL;
const run=url?describe:describe.skip;
run('approved contact merge on isolated PostgreSQL',()=>{
 let db,admin,name;
 const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
 const row={sourceId:a,targetId:b,arCode:'AR000-000123',sourcePhone:'081234567',primaryPhone:'0812345678'};
 beforeAll(async()=>{
  const u=new URL(url);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||!u.pathname.startsWith('/sccrm_contact_merge_test'))throw Error('ISOLATED_CONTACT_TEST_REQUIRED');
  name='sccrm_contact_merge_test_'+crypto.randomBytes(6).toString('hex');u.pathname='/postgres';admin=new Client({connectionString:u.href});await admin.connect();await admin.query('CREATE DATABASE '+name);
  u.pathname='/'+name;db=new Client({connectionString:u.href});await db.connect();
  await db.query(`CREATE SCHEMA ada_history;CREATE SCHEMA ada_points;
   CREATE TABLE users(id uuid PRIMARY KEY,full_name text,phone_number text);
   CREATE TABLE member_profiles(user_id uuid PRIMARY KEY REFERENCES users,member_code text,is_active bool DEFAULT true,remark text,contact_phone varchar,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
   CREATE TABLE crm_member_consents(id uuid PRIMARY KEY,user_id uuid REFERENCES users,consent_version text,consented_at timestamptz);
   CREATE TABLE transactions(id uuid PRIMARY KEY,user_id uuid REFERENCES users,amount numeric);
   CREATE TABLE ada_history.member_links(member_id uuid,source_id text,ada_code text);
   CREATE TABLE ada_history.customers(source_id text,ada_code text,phone text);
   CREATE TABLE ada_points.balance_cache(ada_code text,balance numeric,state text,observed_at timestamptz DEFAULT now());
   CREATE VIEW ada_points.approved_owner_links AS SELECT member_id::text,ada_code,ada_code canonical_code FROM ada_history.member_links;
   CREATE TABLE ada_history.customer_profiles(source_id text,ada_code text,phone varchar,name text,active text,directory_id uuid,updated_at timestamptz);
   DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon;END IF;IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated;END IF;END$$;`);
  const migration=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261113102853_approved_member_contact_merges.sql'),'utf8');
  await db.query(migration);
 },30000);
 afterAll(async()=>{if(db)await db.end();if(admin){if(name)await admin.query('DROP DATABASE '+name);await admin.end();}});
 beforeEach(async()=>{
  await db.query('TRUNCATE ada_history.member_merges,crm_member_consents,transactions,member_profiles,users,ada_history.member_links,ada_history.customers,ada_points.balance_cache CASCADE');
  await db.query("INSERT INTO users VALUES($1,'Synthetic Person','081234567'),($2,'Synthetic Person','0812345678')",[a,b]);
  await db.query("INSERT INTO member_profiles(user_id,member_code) VALUES($1,'SCM-11111111'),($2,'AR000-000123')",[a,b]);
  await db.query("INSERT INTO ada_history.member_links VALUES($1,'hq000/AdaAcc','AR000-000123')",[b]);
  await db.query("INSERT INTO ada_history.customers VALUES('hq000/AdaAcc','AR000-000123','0812345678;081234567');INSERT INTO ada_points.balance_cache(ada_code,balance,state) VALUES('AR000-000123',73,'ready')");
 });
 test('one member remains searchable by both numbers; consent and Ada points are preserved',async()=>{
  const id=crypto.randomUUID();await db.query("INSERT INTO crm_member_consents VALUES($1,$2,'original','2026-01-02T00:00:00+00')",[id,a]);
  await db.query(buildMergeSql([row],'explicit synthetic approval'));
  await db.query(buildMergeSql([row],'explicit synthetic approval'));
  const audit=(await db.query('SELECT * FROM ada_history.member_merges')).rows;expect(audit).toHaveLength(1);
  expect(audit[0].before_state.consents[0].user_id).toBe(a);
  const consent=(await db.query('SELECT * FROM crm_member_consents')).rows[0];expect(consent).toMatchObject({id,user_id:b,consent_version:'original'});
  expect((await db.query('SELECT balance FROM ada_points.balance_cache')).rows[0].balance).toBe('73');
  expect((await db.query('SELECT id FROM ada_history.directory')).rows.map(x=>x.id)).toEqual([b]);
  for(const phone of [row.sourcePhone,row.primaryPhone]){
   const q=`SELECT u.id FROM users u JOIN member_profiles m ON m.user_id=u.id AND m.is_active WHERE ${contacts.phoneMatchSql('u.id','u.phone_number','$1','$2')}`;
   expect((await db.query(q,['%'+phone+'%','%'+phone+'%'])).rows.map(x=>x.id)).toEqual([b]);
  }
 });
 test('source financial activity and missing native contact each abort without retiring source',async()=>{
  await db.query('INSERT INTO transactions VALUES($1,$2,20)',[crypto.randomUUID(),a]);
  await expect(db.query(buildMergeSql([row],'approved'))).rejects.toThrow('MERGE_SOURCE_HAS_DEPENDENCIES');await db.query('ROLLBACK');
  expect((await db.query('SELECT count(*) FROM ada_history.member_merges')).rows[0].count).toBe('0');
  await db.query('DELETE FROM transactions');await db.query("UPDATE ada_history.customers SET phone='0812345678'");
  await expect(db.query(buildMergeSql([row],'approved'))).rejects.toThrow('MERGE_APPROVED_NATIVE_CONTACT_NOT_SYNCED');await db.query('ROLLBACK');
  expect((await db.query('SELECT is_active FROM member_profiles WHERE user_id=$1',[a])).rows[0].is_active).toBe(true);
 });
});
