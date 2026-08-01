const express = require("express");
const { getMessageDetail, listInbox } = require("../controllers/pharmcareController");
const { appAuth } = require("../middleware/appAuth");
const { asyncHandler } = require("../utils/asyncHandler");

const router = express.Router();

router.use(appAuth);
router.get("/inbox", asyncHandler(listInbox));
router.get("/messages/:id", asyncHandler(getMessageDetail));

module.exports = router;
