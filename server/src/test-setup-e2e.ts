// E2E test setup — loads real .env so DATABASE_URL points at the dev DB.
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
