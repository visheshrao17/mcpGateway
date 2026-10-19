export function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}) {
  if (process.env.LOG_SILENT === '1' && level !== 'error') return;
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }));
}
