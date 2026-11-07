import { httpApi, type Api } from './client';

export const USE_MOCKS = import.meta.env.VITE_USE_MOCKS === 'true';

// Dynamic import keeps the mock layer out of the production bundle.
export const api: Api = USE_MOCKS ? (await import('../mocks/server.ts')).mockApi : httpApi;

export { ApiError } from './client';
