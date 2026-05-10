import { Router } from 'express';
import { getCustomerProfile, listCustomers } from '../controllers/customersController.js';

const router = Router();

router.get('/', listCustomers);
router.get('/:customerId/profile', getCustomerProfile);

export default router;
