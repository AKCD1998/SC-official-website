const crypto = require('node:crypto');
const express = require('express');
const { appAuth } = require('../middleware/appAuth');
const { getLedger } = require('../services/shopee004StockRuntime');

function createShopee004StockRoutes({ ledger = () => getLedger(), auth = appAuth,
  readToken = () => process.env.SHOPEE004_STOCK_PROJECTION_TOKEN || '',
  allowedOrigins = () => (process.env.SHOPEE004_STOCK_ADMIN_ORIGINS || '').split(',').filter(Boolean) } = {}) {
  const internal = express.Router(), admin = express.Router();
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
  admin.post('/plan', safe(req => ledger().prepare({ posCatalog: req.body?.posCatalog,
    openingOrderNumbers: req.body?.openingOrderNumbers, actor: req.appActor })));
  admin.post('/activate', safe(req => ledger().activate({ ...req.body, actor: req.appActor })));
  admin.post('/pause', safe(req => ledger().pause({ actor: req.appActor })));
  admin.post('/resume', safe(req => ledger().resume({ ...req.body, actor: req.appActor })));
  admin.post('/review', safe(req => ledger().review({ ...req.body, actor: req.appActor })));
  return { internal, admin };
}
module.exports = { createShopee004StockRoutes };
