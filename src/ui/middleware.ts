import { NextResponse, type NextRequest } from 'next/server';

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon|healthz).*)'],
};

const COOKIE_NAME = 'ahc-demo-auth';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const BASIC_REALM = 'AHC Demo';

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function decodeBasic(header: string | null): string | null {
  if (!header) return null;
  const [scheme, encoded] = header.split(' ', 2);
  if (scheme?.toLowerCase() !== 'basic' || !encoded) return null;
  try {
    const decoded = atob(encoded);
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return decoded.slice(idx + 1);
  } catch {
    return null;
  }
}

function unauthorized(): NextResponse {
  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': `Basic realm="${BASIC_REALM}"` },
  });
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const password = process.env.DEMO_PASSWORD;
  if (!password) {
    // Local dev convenience: skip auth when no password is configured. Production
    // deploys without DEMO_PASSWORD still 503 to avoid accidental open access.
    if (process.env.NODE_ENV !== 'production') {
      return NextResponse.next();
    }
    return new NextResponse('Demo auth not configured (DEMO_PASSWORD unset)', {
      status: 503,
    });
  }

  const expectedToken = await sha256Hex(password);

  const cookieValue = request.cookies.get(COOKIE_NAME)?.value;
  if (cookieValue && timingSafeEqualString(cookieValue, expectedToken)) {
    return NextResponse.next();
  }

  const submitted = decodeBasic(request.headers.get('authorization'));
  if (submitted !== null && timingSafeEqualString(submitted, password)) {
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
