const {
  getShopeeAccountingCycleStatus,
} = require('../services/shopeeAccountingCycleStatusService');

async function getAccountingCycleStatus(req, res) {
  res.json(await getShopeeAccountingCycleStatus());
}

module.exports = { getAccountingCycleStatus };
