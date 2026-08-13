import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
    return new Response('POST test works!', {
        status: 200
    });
};