import { readFileSync } from 'node:fs';

// The port the service listens on, from src/config.json.
export const port = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8')).port;
