import { createAuthClient } from 'better-auth/react';
import { API_BASE } from './api-base';

export const authClient = createAuthClient({
  baseURL: API_BASE || undefined,
  basePath: '/auth',
});
