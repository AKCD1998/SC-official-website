'use strict';
const byId=id=>document.getElementById(id);
const api='/api/sccrm/promotions';
let token='', editingId='', all=[], loading=false;
let setupToken=new URLSearchParams(location.hash.slice(1)).get('setup') || '';
if(setupToken){history.replaceState(null,'',location.pathname+location.search);byId('setup').hidden=false;byId('login').hidden=true;}
const params=new URLSearchParams(location.search);
byId('branch').value=params.get('branchCode') || '';
byId('admin').hidden=!/\/admin\/?$/.test(location.pathname);
async function request(url,options={}) {
 const res=await fetch(url,{cache:'no-store',...options,signal:AbortSignal.timeout(15000)});
 const data=await res.json();if(!res.ok)throw Error(data.error || 'เชื่อมต่อไม่สำเร็จ');return data;
}
function describe(p) {
 const c=p.condition_json || {};
 const rule=p.type==='multiplier'?`แต้มคูณ ${p.value} เท่า`:`เพิ่ม ${c.bonus_points ?? p.value} แต้ม`;
 return `${rule}${Number(c.minimum_spend)>0?` เมื่อซื้อครบ ${Number(c.minimum_spend).toLocaleString('th-TH')} บาท`:''}`;
}
function cards(target,rows,editable=false) {
 target.replaceChildren();
 if(!rows.length){const p=document.createElement('p');p.textContent=editable?'ยังไม่มีโปรโมชั่น':'ขณะนี้ไม่มีโปรพิเศษ ใช้อัตราปกติ 25 บาทต่อ 1 แต้ม';target.append(p);return;}
 for(const row of rows){const card=document.createElement('article');card.className='card';
  const title=document.createElement('h3');title.textContent=row.name;card.append(title);
  for(const text of [describe(row),row.ends_at?`ถึง ${new Date(row.ends_at).toLocaleString('th-TH')}`:'ยังไม่กำหนดวันสิ้นสุด',editable?(row.is_active?'สถานะ: เปิด':'สถานะ: ปิด'):'']){if(text){const p=document.createElement('p');p.textContent=text;card.append(p);}}
  if(editable){const b=document.createElement('button');b.className='secondary';b.textContent='แก้ไข / เปิด–ปิด';b.onclick=()=>edit(row);card.append(b);}
  target.append(card);
 }
}
async function refresh(){
 if(loading)return;loading=true;byId('refresh').disabled=true;
 try{const q=new URLSearchParams({branchCode:byId('branch').value.trim(),amount:byId('amount').value});
  const [catalog,quote]=await Promise.all([request(`${api}/active?${q}`),request(`${api}/quote?${q}`)]);
  cards(byId('promotions'),catalog.promotions);byId('quote').textContent=`ได้รับ ${quote.awardedPoints.toLocaleString('th-TH')} แต้ม (แต้มฐาน ${quote.basePoints})`;
  byId('status').textContent=`ตรวจสอบล่าสุด ${new Date(quote.serverTime).toLocaleTimeString('th-TH')} · อัตราฐาน ${quote.bahtPerPoint} บาทต่อแต้ม`;
 }catch{byId('promotions').replaceChildren();byId('quote').textContent='ตรวจสอบแต้มไม่ได้ในขณะนี้';byId('status').textContent='เชื่อมต่อส่วนกลางไม่สำเร็จ กรุณาโหลดใหม่ก่อนอ้างอิงโปรโมชั่น';}
 finally{loading=false;byId('refresh').disabled=false;}
}
byId('quoteForm').onsubmit=e=>{e.preventDefault();refresh();};byId('refresh').onclick=refresh;
setInterval(()=>{if(!document.hidden)refresh();},30000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});refresh();
async function loadAdmin(){all=(await request(api,{headers:{Authorization:`Bearer ${token}`}})).promotions;cards(byId('allPromotions'),all,true);}
byId('login').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;
 try{const auth=await request('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:byId('email').value.trim(),password:byId('password').value})});token=auth.token;await loadAdmin();byId('login').hidden=true;byId('editor').hidden=false;byId('adminStatus').textContent='เข้าสู่ระบบแล้ว';}
 catch(error){token='';byId('adminStatus').textContent=error.message;}
 finally{byId('password').value='';b.disabled=false;}
};
byId('logout').onclick=()=>{token='';all=[];byId('editor').hidden=true;byId('login').hidden=false;byId('allPromotions').replaceChildren();byId('adminStatus').textContent='ออกจากระบบแล้ว';};
byId('setup').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;
 try{const password=byId('setupPassword').value;if(password!==byId('setupConfirm').value)throw Error('รหัสผ่านทั้งสองช่องต้องตรงกัน');
  await request(api+'/admin/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({setupToken,password})});setupToken='';byId('setup').hidden=true;byId('login').hidden=false;byId('adminStatus').textContent='สร้างบัญชีแล้ว กรุณาเข้าสู่ระบบด้วยอีเมลและรหัสผ่านที่เพิ่งตั้ง';
 }catch(error){byId('adminStatus').textContent=error.message;}
 finally{byId('setupPassword').value='';byId('setupConfirm').value='';b.disabled=false;}
};
function localDate(raw){if(!raw)return '';const d=new Date(raw);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}
function edit(p){editingId=p.id;byId('editTitle').textContent='แก้ไข '+p.name;for(const field of ['name','type','value'])byId(field).value=p[field];byId('minimum').value=p.condition_json.minimum_spend || 0;byId('branches').value=(p.condition_json.branch_codes || []).join(',');byId('starts').value=localDate(p.starts_at);byId('ends').value=localDate(p.ends_at);byId('active').checked=p.is_active;byId('saveForm').scrollIntoView({behavior:'smooth'});}
byId('cancelEdit').onclick=()=>{editingId='';byId('saveForm').reset();byId('editTitle').textContent='เพิ่มโปรใหม่';};
byId('saveForm').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;
 try{const condition={minimum_spend:Number(byId('minimum').value)};const branches=byId('branches').value.split(',').map(b=>b.trim().toUpperCase()).filter(Boolean);if(branches.length)condition.branch_codes=branches;
  const p={name:byId('name').value.trim(),type:byId('type').value,value:Number(byId('value').value),condition_json:condition,is_active:byId('active').checked,starts_at:byId('starts').value?new Date(byId('starts').value).toISOString():null,ends_at:byId('ends').value?new Date(byId('ends').value).toISOString():null};
  await request(api+(editingId?'/'+editingId:''),{method:editingId?'PUT':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(p)});
  byId('adminStatus').textContent='บันทึกแล้ว เครื่องอื่นจะเห็นเมื่อโหลดรายการใหม่ภายใน 30 วินาที';await loadAdmin();await refresh();
 }catch(error){byId('adminStatus').textContent=error.message;}
 finally{b.disabled=false;}
};
