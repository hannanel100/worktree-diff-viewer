import { jsonRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const GET = jsonRoute((_params, service) => service.info());
