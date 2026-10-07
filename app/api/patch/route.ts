import { errorResponse, type Params } from '@/lib/api';
import { getRepoService } from '@/lib/context';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  try {
    const params = Object.fromEntries(new URL(req.url).searchParams) as Params;
    const service = await getRepoService();
    const { filename, text } = await service.patch(params);
    return new Response(text, {
      headers: {
        'Content-Type': 'text/x-patch; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
