// Mounted by `next dev` only (see pageExtensions in next.config.ts).
// Production serves the same handler from server/http.ts.
import { apiHandlers } from '@/lib/handlers';

export const dynamic = 'force-dynamic';
export const GET = apiHandlers.repo;
