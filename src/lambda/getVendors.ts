import { docClient } from './db.ts';
import { getVendors } from './vendors.ts';

export const handler = () => getVendors(docClient);
