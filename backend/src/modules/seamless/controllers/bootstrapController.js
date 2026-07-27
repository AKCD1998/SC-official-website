const { appConfig } = require("../appConfig");

function getBootstrap(req, res) {
  res.json({
    appName: appConfig.appName,
    maxUploadMb: appConfig.maxUploadMb,
    retentionHours: appConfig.retentionHours,
    maxBatchFiles: appConfig.maxBatchFiles,
    formatterModes: appConfig.formatterModes,
  });
}

module.exports = { getBootstrap };
