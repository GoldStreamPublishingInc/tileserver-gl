import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

import fs from 'node:fs';
import path from 'path';

// Ensure to call this before requiring any other modules!

let sentryEnabled = false;

try {
  // data/.sentry contains dsn
  const sentryPath = path.resolve('.sentry');
  const dsn = fs.readFileSync(sentryPath, 'utf8');
  if (dsn) {
    Sentry.init({
      dsn,
      integrations: [nodeProfilingIntegration()],
      tracesSampleRate: 0.25,
      profilesSampleRate: 1.0,
    });

    sentryEnabled = true;
  }
} catch (e) {}

export { sentryEnabled };
