const crypto=require('node:crypto');
const {verify}=require('../lib/sccrmFleetRelease');
const keys=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const jwk=keys.publicKey.export({format:'jwk'});
const xml=`<RSAKeyValue><Modulus>${Buffer.from(jwk.n,'base64url').toString('base64')}</Modulus><Exponent>${Buffer.from(jwk.e,'base64url').toString('base64')}</Exponent></RSAKeyValue>`;
function envelope(changes={}){const bytes=Buffer.from(JSON.stringify({schemaVersion:1,deviceAccessVersion:1,fleetProtocolVersion:1,sourceDirty:false,sourceCommit:'b'.repeat(40),releaseId:'pos-1.3.16',version:'1.3.16',sha256:'a'.repeat(64),size:2048,downloadUrl:'https://github.com/AKCD1998/SCCRMonPOS/releases/download/pos-1.3.16/SCCRMonPOS.exe',...changes}));return JSON.stringify({payload:bytes.toString('base64'),signature:crypto.sign('RSA-SHA256',bytes,keys.privateKey).toString('base64')});}
test('a fleet-capable device-restricted release requires a valid publisher signature',()=>{expect(verify(envelope(),xml)).toMatchObject({version:'1.3.16',fleetProtocolVersion:1});});
test.each([{fleetProtocolVersion:0},{deviceAccessVersion:0},{sourceDirty:true},{downloadUrl:'https://example.com/payload.exe'},{size:999},{sha256:'invalid'},{releaseId:'another-release'}])('rejects an ineligible signed release %j',changes=>{expect(()=>verify(envelope(changes),xml)).toThrow();});
test('signature corruption is rejected',()=>{const e=JSON.parse(envelope());e.signature=Buffer.alloc(256).toString('base64');expect(()=>verify(JSON.stringify(e),xml)).toThrow();});
