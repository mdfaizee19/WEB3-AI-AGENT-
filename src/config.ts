import 'dotenv/config';

export const CROO_CONFIG = {
  baseURL: process.env.CROO_API_URL ?? 'https://api.croo.network',
  wsURL: process.env.CROO_WS_URL ?? 'wss://api.croo.network/ws',
};

export const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
