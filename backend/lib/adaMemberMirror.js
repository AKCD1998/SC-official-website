'use strict';
const contacts=require('./memberContactPhones');
const enabled=()=>process.env.SC_OFFICIAL_ADA_SYNC_ENABLED==='true';
async function legacyProfile(db,id){if(!enabled())return null;return (await db.query(`SELECT c.directory_id id,c.name full_name,c.phone,NULL::text email,NULL::text sex,NULL::text dob,NULL::text remark,c.updated_at created_at,'ADA-'||c.ada_code member_code,'standard'::text tier,c.active='1' is_active,c.updated_at,0::bigint current_points FROM ada_history.customers c WHERE c.directory_id=$1::uuid AND c.ada_code<>'0' AND NOT EXISTS(SELECT 1 FROM ada_history.member_links l WHERE l.source_id=c.source_id AND l.ada_code=c.ada_code)`,[id])).rows[0]||null;}
async function searchLegacy(db,q,{pointsAvailable=true}={}){
 if(!enabled())return [];
 const points=pointsAvailable?'COALESCE((SELECT sum(amount) FROM public.point_ledger WHERE user_id=d.id),0)':'0::bigint';
 return (await db.query(`SELECT d.id,d.full_name display_name,d.phone_number phone,d.member_code,u.email,${points} current_points,${contacts.linkedPhonesSql('d.id')} contact_phones FROM ada_history.directory d LEFT JOIN public.users u ON u.id=d.id WHERE d.is_active=true AND d.member_code<>'ADA-0' AND(LOWER(COALESCE(d.phone_number,'')) LIKE $1 OR LOWER(COALESCE(d.full_name,'')) LIKE $1 OR LOWER(d.member_code) LIKE $1 OR ${contacts.phoneMatchSql('d.id','d.phone_number','$1','$3')}) ORDER BY CASE WHEN d.phone_number=$2 THEN 0 ELSE 1 END,d.full_name,d.id LIMIT 20`,['%'+q.toLowerCase()+'%',q,contacts.digitPattern(q)])).rows.map(r=>({id:r.id,displayName:r.display_name||'',phone:r.phone||null,email:r.email||null,memberCode:r.member_code,currentPoints:Number(r.current_points||0),...contacts.contactFields(r.phone,r.contact_phones)}));
}
// Called only inside an authenticated staff's explicit edit/receipt transaction.
// A legacy contact never becomes an email/password login as a side effect of import.
async function ensureLegacyMember(db,id){if(!enabled())return;await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['ada-member:'+id]);if((await db.query('SELECT id FROM public.users WHERE id=$1::uuid',[id])).rows.length)return;
 const c=(await db.query(`SELECT * FROM ada_history.customers WHERE directory_id=$1::uuid AND ada_code<>'0' AND active='1' FOR UPDATE`,[id])).rows[0];if(!c)return;
 const link=(await db.query('SELECT member_id FROM ada_history.member_links WHERE source_id=$1 AND ada_code=$2',[c.source_id,c.ada_code])).rows[0];if(link&&link.member_id!==id)throw Object.assign(Error('This Ada customer is already linked to another member.'),{status:409});
 await db.query('INSERT INTO public.users(id,full_name,phone_number,email,is_verified) VALUES($1,$2,NULL,NULL,false)',[id,c.name||'ลูกค้า Ada '+c.ada_code]);
 await db.query('INSERT INTO public.member_profiles(user_id,member_code) VALUES($1,$2)',[id,'ADA-'+c.ada_code]);
 await db.query('INSERT INTO ada_history.member_links(member_id,source_id,ada_code,approval_reference) VALUES($1,$2,$3,$4)',[id,c.source_id,c.ada_code,'authenticated staff selection']);
}
module.exports={enabled,legacyProfile,searchLegacy,ensureLegacyMember};
