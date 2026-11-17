// Entry lifecycle: bind an ephemeral port, register it with the trial
// environment, serve until the environment says the trial is done, then
// exit cleanly. The environment URL arrives in MAKEFUN_ENV_URL; without it
// there is no trial to serve, so the process refuses to start.

import { createApp } from './app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl === undefined || envUrl === '') {
  console.error('MAKEFUN_ENV_URL is not set; nowhere to register');
  process.exit(1);
}

const server = createApp();
await new Promise<void>((resolve) => {
  server.listen(0, () => resolve());
});
const address = server.address();
const port = typeof address === 'object' && address !== null ? address.port : 0;
if (port === 0) {
  console.error('the server did not bind a port');
  process.exit(1);
}

const registration = await fetch(`${envUrl}/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ port }),
});
if (registration.status === 409) {
  console.error('another entry registered first; this one stands down');
  process.exit(1);
}
if (!registration.ok) {
  console.error(`registration failed with HTTP ${registration.status}`);
  process.exit(1);
}

for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  try {
    const answer = await fetch(`${envUrl}/done`);
    if (answer.ok) {
      const body = (await answer.json()) as { done?: unknown };
      if (body.done === true) break;
    }
  } catch {
    // The environment is not answering yet; keep serving and poll again.
  }
}

await new Promise<void>((resolve) => {
  server.close(() => resolve());
});
process.exit(0);
