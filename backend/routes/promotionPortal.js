const express = require('express');
const path = require('node:path');
const router=express.Router();
const root=path.join(__dirname,'../public/promotions');
router.use((_req,res,next)=>{
  res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"});
  next();
});
router.get(['/','/admin'],(_req,res)=>res.sendFile(path.join(root,'index.html')));
router.get('/portal.js',(_req,res)=>res.sendFile(path.join(root,'portal.js')));
router.get('/style.css',(_req,res)=>res.sendFile(path.join(root,'style.css')));
module.exports=router;
