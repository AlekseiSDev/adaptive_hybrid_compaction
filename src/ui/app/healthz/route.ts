export const runtime = 'nodejs';

export function GET(): Response {
  return new Response('ok', {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
