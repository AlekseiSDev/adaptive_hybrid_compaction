import { NextResponse, type NextRequest } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon|healthz).*)'],
};

const COOKIE_NAME = 'ahc-demo-auth';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const BASIC_REALM = 'AHC Demo';

function tokenFor(password: string): string {
  return createHash('sha256').update(password).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function unauthorized(): NextResponse {
  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': `Basic realm="${BASIC_REALM}"` },
  });
}

function decodeBasic(header: string | null): string | null {
  if (!header) return null;
  const [scheme, encoded] = header.split(' ', 2);
  if (scheme?.toLowerCase() !== 'basic' || !encoded) return null;
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return decoded.slice(idx + 1);
  } catch {
    return null;
  }
}

export function middleware(request: NextRequest): NextResponse {
  const password = process.env.DEMO_PASSWORD;
  if (!password) {
    return new NextResponse('Demo auth not configured (DEMO_PASSWORD unset)', {
      status: 503,
    });
  }

  const expectedToken = tokenFor(password);

  const cookieValue = request.cookies.get(COOKIE_NAME)?.value;
  if (cookieValue && safeEqual(cookieValue, expectedToken)) {
    return NextResponse.next();
  }

  const submitted = decodeBasic(request.headers.get('authorization'));
  if (submitted !== null && safeEqual(submitted, password)) {
    const response = NextResponse.next();
    response.cookies.set({
      name: COOKIE_NAME,
      value: expectedToken,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: COOKIE_MAX_AGE_SECONDS,
      path: '/',
    });
    return response;
  }

  return unauthorized();
}
