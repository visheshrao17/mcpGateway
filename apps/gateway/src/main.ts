import { createGateway } from './app.ts';
import { loadConfig } from './config.ts';
import { log } from './log.ts';

let config;
try {
  config = loadConfig();
} catch (err) {
  log('error', 'invalid configuration', { error: (err as Error).message });
  process.exit(1);
}

const gateway = createGateway(config);
try {
  await gateway.start();
} catch (err) {
  log('error', 'startup failed', { error: (err as Error).message });
  process.exit(1);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log('info', 'shutting down', { signal });
    gateway.stop().finally(() => process.exit(0));
  });
}
