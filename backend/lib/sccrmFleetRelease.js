'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const URL_STABLE = 'https://raw.githubusercontent.com/AKCD1998/SCCRMonPOS/master/releases/stable.json';
const failure = () => Object.assign(Error('Signed SCCRM release is unavailable.'), {status:503,code:'RELEASE_UNAVAILABLE'});
function verify(envelopeText, publicXml = fs.readFileSync(path.join(__dirname,'sccrmUpdatePublicKey.xml'),'utf8')) {
 try {
  if(typeof envelopeText!=='string'||Buffer.byteLength(envelopeText)>65536)throw failure();
  const envelope=JSON.parse(envelopeText),bytes=Buffer.from(envelope.payload,'base64');
  const n=/<Modulus>([^<]+)<\/Modulus>/.exec(publicXml)?.[1],e=/<Exponent>([^<]+)<\/Exponent>/.exec(publicXml)?.[1];
  const key=crypto.createPublicKey({format:'jwk',key:{kty:'RSA',n:Buffer.from(n,'base64').toString('base64url'),e:Buffer.from(e,'base64').toString('base64url')}});
  if(!crypto.verify('RSA-SHA256',bytes,key,Buffer.from(envelope.signature,'base64')))throw failure();
  const release=JSON.parse(bytes.toString('utf8'));
  if(release.schemaVersion!==1||release.deviceAccessVersion!==1||release.fleetProtocolVersion!==1||release.sourceDirty!==false
   ||!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(release.version)||release.releaseId!=='pos-'+release.version
   ||!/^[a-f0-9]{40}$/.test(release.sourceCommit)||!/^[a-f0-9]{64}$/.test(release.sha256)
   ||!Number.isSafeInteger(release.size)||release.size<1024||release.size>20*1024*1024
   ||release.downloadUrl!==`https://github.com/AKCD1998/SCCRMonPOS/releases/download/${release.releaseId}/SCCRMonPOS.exe`)throw failure();
  return {...release,envelope:envelopeText};
 }catch{throw failure();}
}
async function latest(fetchImpl=fetch){
 const response=await fetchImpl(URL_STABLE,{signal:AbortSignal.timeout(12000),redirect:'error',headers:{'Cache-Control':'no-cache'}});
 if(!response.ok)throw failure();
 const chunks=[];let size=0;
 for await(const chunk of response.body){size+=chunk.length;if(size>65536)throw failure();chunks.push(chunk);}
 return verify(Buffer.concat(chunks).toString('utf8'));
}
module.exports={verify,latest};
