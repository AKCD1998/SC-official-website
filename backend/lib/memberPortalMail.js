'use strict';
function createMemberPortalMailer({env=process.env,fetchImpl=global.fetch}={}) {
  const provider=String(env.SC_OFFICIAL_MEMBER_PORTAL_EMAIL_PROVIDER || env.EMAIL_PROVIDER || 'sendgrid').trim().toLowerCase();
  const from=String(env.SC_OFFICIAL_MEMBER_PORTAL_FROM_EMAIL || env.MAIL_FROM || env.MAIL_USER || env.SEAMLESS_MAIL_FROM || '').trim();
  const apiKey=provider==='brevo' ? (env.SC_OFFICIAL_MEMBER_PORTAL_BREVO_API_KEY || env.BREVO_API_KEY)
    : provider==='resend' ? env.SC_OFFICIAL_MEMBER_PORTAL_RESEND_API_KEY
    : provider==='sendgrid' ? (env.SC_OFFICIAL_MEMBER_PORTAL_SENDGRID_API_KEY || env.SENDGRID_API_KEY) : null;
  const configured=Boolean(from && apiKey && typeof fetchImpl==='function');
  async function sendOtp({email,otp}) {
    if(!configured)throw new Error('MEMBER_PORTAL_MAIL_NOT_CONFIGURED');
    const subject='รหัสเข้าใช้งานประวัติการซื้อ SC Drug Store';
    const text=`รหัสเข้าใช้งานของคุณคือ ${otp}\n\nรหัสใช้ได้ 10 นาที และใช้ได้ครั้งเดียว\nห้ามบอกรหัสนี้แก่ผู้อื่น\nหากคุณไม่ได้ขอรหัส กรุณาเพิกเฉยต่ออีเมลนี้`;
    let url,headers,payload;
    if(provider==='brevo') {
      url='https://api.brevo.com/v3/smtp/email';headers={'api-key':apiKey};
      payload={sender:{email:from,name:'SC Drug Store'},to:[{email}],subject,textContent:text};
    } else if(provider==='resend') {
      url='https://api.resend.com/emails';headers={Authorization:'Bearer '+apiKey};
      payload={from:`SC Drug Store <${from}>`,to:[email],subject,text};
    } else {
      url='https://api.sendgrid.com/v3/mail/send';headers={Authorization:'Bearer '+apiKey};
      payload={personalizations:[{to:[{email}]}],from:{email:from,name:'SC Drug Store'},subject,content:[{type:'text/plain',value:text}]};
    }
    const response=await fetchImpl(url,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('MEMBER_PORTAL_MAIL_DELIVERY_FAILED');
  }
  return {configured,provider,sendOtp};
}
module.exports={createMemberPortalMailer};
