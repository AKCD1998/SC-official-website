import { Router } from 'express';
import { login, me, logout } from '../controllers/authController.js';
import applyAuthNoStore from '../middlewares/applyAuthNoStore.js';
import requireAuth from '../middlewares/requireAuth.js';

const router = Router();

router.use(applyAuthNoStore);

router.post('/login', login);
router.get('/me', requireAuth, me);
router.post('/logout', logout);

export default router;
