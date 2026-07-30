const express = require("express");
const { getSession, login, logout } = require("../controllers/sessionController");
const { asyncHandler } = require("../utils/asyncHandler");

// Deliberately NOT behind appAuth — this is how a client without a session first obtains one.
const router = express.Router();

router.post("/login", asyncHandler(login));
router.post("/logout", asyncHandler(logout));
router.get("/", asyncHandler(getSession));

module.exports = router;
