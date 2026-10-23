const crypto = require('node:crypto');
const express = require('express');
const { appAuth } = require('../middleware/appAuth');
const { getLedger,getIdentityStore } = require('../services/shopee004StockRuntime');

function createShopee004StockRoutes({ ledger = () => getLedger(), auth = appAuth,
  identityStore=()=>getIdentityStore(),
  readToken = () => process.env.SHOPEE004_STOCK_PROJECTION_TOKEN || '',
  reviewToken=()=>process.env.SHOPEE004_STOCK_REVIEW_TOKEN||'',
  exceptionAdminEnabled=()=>process.env.SHOPEE004_STOCK_EXCEPTION_ADMIN_ENABLED==='true',
  allowedOrigins = () => (process.env.SHOPEE004_STOCK_ADMIN_ORIGINS || '').split(',').filter(Boolean) } = {}) {
  const internal = express.Router(), admin = express.Router(),privileged=express.Router();
  const safe = fn => async (req, res) => {
    res.set('Cache-Control','no-store');
    try { res.json(await fn(req)); }
    catch (error) {
      const code = error?.statusCode === 409 && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'LEDGER_REQUEST_FAILED';
      res.status(error?.statusCode === 409 ? 409 : 503).json({ error: { code, detailsWithheld: true } });
    }
  };
  internal.use((req, res, next) => {
    const expected = readToken();
    const supplied = /^Bearer ([^\s]+)$/.exec(req.headers.authorization || '')?.[1] || '';
    const a = Buffer.from(expected), b = Buffer.from(supplied);
    if (a.length < 32 || a.length !== b.length || !crypto.timingSafeEqual(a,b)) return res.status(401).json({ error: { code: 'PROJECTION_UNAUTHORIZED' } });
    next();
  });
  internal.post('/projection', safe(req => ledger().projection(req.body?.productCodes)));
  internal.post('/exceptions',safe(req=>identityStore().exceptions({limit:req.body?.limit??25,cursor:req.body?.cursor||null})));
  internal.post('/reconciliation',safe(()=>ledger().reconciliation()));
  privileged.use((req,res,next)=>{
    res.set('Cache-Control','no-store');
    if(!exceptionAdminEnabled())return res.status(503).json({error:{code:'BRIDGE_UNAVAILABLE',detailsWithheld:true,definitiveNoWrite:true}});
    const expected=reviewToken(),supplied=/^Bearer ([^\s]+)$/.exec(req.headers.authorization||'')?.[1]||'';
    const a=Buffer.from(expected),b=Buffer.from(supplied);
    if(expected===readToken()||a.length<32||a.length!==b.length||!crypto.timingSafeEqual(a,b))return res.status(403).json({error:{code:'IDENTITY_REVIEW_UNAUTHORIZED',detailsWithheld:true}});
    if(!req.is('application/json')||typeof req.body?.actor!=='string'||!req.body.actor.trim()||req.body.actor.length>200)return res.status(403).json({error:{code:'HUMAN_ADMIN_REQUIRED',detailsWithheld:true}});
    next();
  });
  privileged.post('/mapping',safe(req=>identityStore().approveMapping(req.body)));
  privileged.post('/revoke',safe(req=>identityStore().revoke(req.body)));
  admin.use(auth, (req, res, next) => {
    if (req.appRole !== 'admin' || !['session','admin_basic'].includes(req.appAuthSource)
      || !req.appActor || req.appActor.length > 200) return res.status(403).json({ error: { code: 'HUMAN_ADMIN_REQUIRED' } });
    if (req.method !== 'GET' && (req.headers['x-shopee-stock-action'] !== '1'
      || !req.is('application/json') || (req.headers.origin && !allowedOrigins().includes(req.headers.origin)))) {
      return res.status(403).json({ error: { code: 'STOCK_ACTION_ORIGIN_REQUIRED' } });
    }
    next();
  });
  admin.get('/status', safe(() => ledger().projection([])));
  admin.post('/review-queue', safe(req => ledger().reviewQueue({ limit: req.body?.limit ?? 100, cursor: req.body?.cursor || '' })));
  admin.post('/plan', safe(req => ledger().prepare({ posCatalog: req.body?.posCatalog,
    openingOrderNumbers: req.body?.openingOrderNumbers, openingBasis: req.body?.openingBasis, actor: req.appActor })));
  admin.post('/activate', safe(req => ledger().activate({ ...req.body, actor: req.appActor })));
  admin.post('/reconcile-accepted-legacy', safe(req => ledger().reconcileAcceptedLegacy({
    ownerAcceptedOpeningEstimate: req.body?.ownerAcceptedOpeningEstimate, actor: req.appActor })));
  admin.post('/pause', safe(req => ledger().pause({ actor: req.appActor })));
  admin.post('/extend-pos-catalog',safe(req=>ledger().extendPosCatalog({posCatalog:req.body?.posCatalog,actor:req.appActor})));
  admin.post('/resume', safe(req => ledger().resume({ ...req.body, actor: req.appActor })));
  admin.post('/review', safe(req => ledger().review({ ...req.body, actor: req.appActor })));
  // Importing proof is a separate human action. The StockDay mapping service
  // credential cannot manufacture trusted catalog/unit evidence.
  admin.post('/identity-evidence',safe(req=>{
    if(!exceptionAdminEnabled())throw Object.assign(Error(),{statusCode:409,code:'IDENTITY_ADMIN_DISABLED'});
    return identityStore().importEvidence({...req.body,actor:req.appActor});
  }));
  admin.post('/identity-catalog-mapping',safe(req=>{
    if(!exceptionAdminEnabled())throw Object.assign(Error(),{statusCode:409,code:'IDENTITY_ADMIN_DISABLED'});
    return identityStore().approveCatalogMapping({...req.body,actor:req.appActor});
  }));
  return { internal, admin,privileged };
}
// The reviewed opening references plus bounded POS metadata can exceed Express's
// default 100 KB. Mount only this exact plan parser before the global parser.
const stockPlanJsonParser = () => express.json({ limit: '512kb', strict: true });
module.exports = { createShopee004StockRoutes, stockPlanJsonParser };
