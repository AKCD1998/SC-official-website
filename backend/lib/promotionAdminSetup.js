const crypto=require('node:crypto');
function setupSigningSecret(){
  if(!process.env.JWT_SECRET)throw Error('SITE_SIGNING_KEY_REQUIRED');
  return crypto.createHmac('sha256',process.env.JWT_SECRET).update('SCCRM_PROMOTION_ADMIN_SETUP_V1').digest('hex');
}
module.exports={setupSigningSecret};
