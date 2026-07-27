const express = require("express");
const { getBootstrap } = require("../controllers/bootstrapController");
const { appAuth } = require("../middleware/appAuth");

const router = express.Router();

router.use(appAuth);
router.get("/", getBootstrap);

module.exports = router;
