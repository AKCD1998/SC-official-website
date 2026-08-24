const express = require("express");
const { listInbox } = require("../controllers/shopeeEmailController");
const { appAuth } = require("../middleware/appAuth");
const { asyncHandler } = require("../utils/asyncHandler");

const router = express.Router();

router.use(appAuth);
router.get("/inbox", asyncHandler(listInbox));

module.exports = router;
