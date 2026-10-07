import { jsonRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';

export const GET = jsonRoute((params, service) => service.file(params));
