export function loadConfig(env = process.env) {
  const secret = env.SESSION_SECRET || '';
  if (secret.length < 32) throw new Error('SESSION_SECRET_required_min_32_chars');
  const pin = env.PILOT_PIN || '';
  if (!pin) throw new Error('PILOT_PIN_required');
  const serverless = env.VERCEL === '1';
  const databaseUrl = env.DATABASE_URL || null;
  if (serverless && !databaseUrl) throw new Error('DATABASE_URL_required_on_vercel');
  /* A SUPER_KEY shorter than 24 characters closes /super (503 super_key_too_short) instead of taking the app down. */
  let superKey = env.SUPER_KEY || '', superKeyError = null;
  if (superKey && superKey.length < 24) {
    console.warn('SUPER_KEY tiene menos de 24 caracteres: /super queda cerrado hasta que se cambie.');
    superKey = ''; superKeyError = 'super_key_too_short';
  }
  return {
    secret,
    pin,
    /* The shared pilot PIN is OFF by default (every real person has a tester PIN); PILOT_PIN_SHARED=true turns it on
       for local development, the load test and the very first create_testers. */
    sharedPin: env.PILOT_PIN_SHARED === 'true',
    /* Second key for the separate super admin page (/super). Empty = that page cannot be opened; set = 24+ chars. */
    superKey,
    superKeyError,
    /* Demo mode (ON unless DEMO_MODE=false): reset_demo, seed_load and writing on another person's WhatsApp
       chat (the simulator) only exist in demo mode. Turn it off before loading real data. */
    demoMode: env.DEMO_MODE !== 'false',
    databaseUrl,
    dataDir: env.PGLITE_DIR || 'data/pglite',
    port: Number(env.PORT || 3000),
    serverless,
    secure: serverless || env.NODE_ENV === 'production',
  };
}
