const contacts=require('../lib/memberContactPhones');
test('multiple contacts retain the primary and do not produce a concatenated login phone',()=>{
  expect(contacts.contactFields('0990000001',['0990000002','099-000-0001'])).toEqual({phoneNumbers:['0990000001','0990000002']});
  expect(contacts.contactFields('0990000001',['099-000-0001'])).toEqual({});
  expect(contacts.contactFields(null)).toEqual({});
});
test('number search accepts formatting without turning name or wildcard queries into all phones',()=>{
  expect(contacts.digitPattern('099-000-0001')).toBe('%0990000001%');
  expect(contacts.digitPattern('+66 99 000 0001')).toBe('%0990000001%');
  for(const value of ['name','%','_','AR001-000786','12',''])expect(contacts.digitPattern(value)).toBeNull();
});
test('retained phone lookup stays bound to an already approved member link',()=>{
  expect(contacts.phoneMatchSql('d.id','d.phone_number','$2','$5')).toContain('l.member_id=d.id');
  expect(contacts.linkedPhonesSql('d.id')).toContain('c.source_id=l.source_id AND c.ada_code=l.ada_code');
});
