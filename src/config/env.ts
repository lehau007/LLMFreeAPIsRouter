import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  masterKey: process.env.MASTER_KEY,
  nodeEnv: process.env.NODE_ENV || 'development',
};

// Validate required environment variables
export function validateEnv() {
  if (!config.masterKey) {
    console.error('CRITICAL: MASTER_KEY environment variable is not set.');
    console.error('Please generate a secure random string and set it in your .env file.');
    process.exit(1);
  }

  if (config.masterKey.length < 32) {
    console.warn('WARNING: MASTER_KEY should be at least 32 characters long for better security.');
  }
}
