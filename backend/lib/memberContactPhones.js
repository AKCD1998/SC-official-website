'use strict';

// These fragments receive only developer-owned SQL expressions, never input.
function linkedPhonesSql(member) {
  return `ARRAY(SELECT DISTINCT c.phone FROM ada_history.member_links l
    JOIN ada_history.customers c ON c.source_id=l.source_id AND c.ada_code=l.ada_code
    WHERE l.member_id=${member} AND NULLIF(BTRIM(c.phone),'') IS NOT NULL ORDER BY c.phone)`;
}
function phoneMatchSql(member, primary, pattern, digits) {
  return `((${digits}::text IS NOT NULL AND regexp_replace(COALESCE(${primary},''),'[^0-9]','','g') LIKE ${digits})
    OR EXISTS(SELECT 1 FROM ada_history.member_links l
      JOIN ada_history.customers c ON c.source_id=l.source_id AND c.ada_code=l.ada_code
      WHERE l.member_id=${member} AND (c.phone ILIKE ${pattern}
        OR (${digits}::text IS NOT NULL AND regexp_replace(COALESCE(c.phone,''),'[^0-9]','','g') LIKE ${digits}))))`;
}
function digitPattern(search) {
  if (!/^[+\d\s().\-/]+$/.test(search)) return null;
  let digits=search.replace(/\D/g,'');
  if (/^66\d{8,9}$/.test(digits)) digits='0'+digits.slice(2);
  return digits.length>=3?'%'+digits+'%':null;
}
function contactFields(primary, linked=[]) {
  const values=[...new Set([primary,...linked].filter(Boolean).flatMap(raw=>String(raw).split(/[,;|/&\n]/)).map(value=>{
    const raw=value.trim();let digits=raw.replace(/\D/g,'');
    if (/^66\d{8,9}$/.test(digits)) digits='0'+digits.slice(2);
    return /^0\d{8,9}$/.test(digits)?digits:raw;
  }).filter(Boolean))];
  return values.length>1?{phoneNumbers:values}:{};
}
module.exports={linkedPhonesSql,phoneMatchSql,digitPattern,contactFields};
