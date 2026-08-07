import { type NextRequest, NextResponse } from 'next/server';

/**
 * Access control for the UI and its API.
 *
 * Platter's posture is documented in SECURITY.md: on loopback there is no authentication,
 * because the person at the keyboard is the machine's administrator and a login screen in front
 * of a local tool is friction with no security benefit. The moment it binds anywhere else, the
 * environment schema *refuses to start* without `PLATTER_AUTH_TOKEN` — and this is the piece
 * that makes that promise real rather than decorative.
 *
 * Two ways to present the token:
 *   - `Authorization: Bearer <token>` for scripts and API clients.
 *   - `?token=<token>` once in a browser, which exchanges it for an httpOnly cookie and
 *     redirects, so the secret does not stay in the address bar, the history, or a screenshot.
 *
 * Middleware runs on the Edge runtime, so this deliberately reads `process.env` directly rather
 * than importing Platter's config — the schema pulls in Node built-ins that are unavailable here.
 */

const COOKIE = 'platter_session';

/**
 * Constant-time comparison.
 *
 * `WebCrypto` has no timing-safe equal and `node:crypto` is unavailable on the Edge runtime, so
 * this is written by hand: compare every byte, accumulate differences, and never short-circuit.
 * Length is folded into the result rather than checked first, so a wrong-length token takes the
 * same path as a wrong-value one.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

export function middleware(request: NextRequest): NextResponse {
  const expected = process.env.PLATTER_AUTH_TOKEN;

  // No token configured means loopback-only operation, which the env schema enforces at startup.
  if (!expected) {
    return NextResponse.next();
  }

  const url = request.nextUrl;

  // Health is deliberately open: it carries no server data, and a monitor that needs a secret to
  // ask "are you alive" is a monitor nobody configures.
  if (url.pathname === '/api/health') {
    return NextResponse.next();
  }

  const cookie = request.cookies.get(COOKIE)?.value;
  if (cookie && timingSafeEqual(cookie, expected)) {
    return NextResponse.next();
  }

  const header = request.headers.get('authorization');
  if (header?.startsWith('Bearer ') && timingSafeEqual(header.slice(7).trim(), expected)) {
    return NextResponse.next();
  }

  const provided = url.searchParams.get('token');
  if (provided && timingSafeEqual(provided, expected)) {
    // Move the secret out of the URL immediately.
    const clean = new URL(url);
    clean.searchParams.delete('token');
    const response = NextResponse.redirect(clean);
    response.cookies.set(COOKIE, expected, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      // Platter is routinely served over plain HTTP on a LAN, so Secure would break the cookie
      // outright. The token is a bearer secret on a trusted network either way — see
      // SECURITY.md for what that assumption is and is not.
      secure: url.protocol === 'https:',
      maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  }

  // A browser gets prose it can act on; an API client gets a WWW-Authenticate challenge.
  const wantsHtml = request.headers.get('accept')?.includes('text/html') ?? false;
  return new NextResponse(
    wantsHtml
      ? 'Platter is running with an access token set.\n\n' +
        'Open this page with ?token=YOUR_TOKEN once, and Platter will remember you.\n' +
        'The token is the value of PLATTER_AUTH_TOKEN.\n'
      : JSON.stringify({ error: 'unauthorized' }),
    {
      status: 401,
      headers: {
        'Content-Type': wantsHtml ? 'text/plain; charset=utf-8' : 'application/json',
        'WWW-Authenticate': 'Bearer realm="platter"',
      },
    }
  ) as NextResponse;
}

export const config = {
  // Everything except Next's own static output, which carries no server data and is requested
  // before the cookie can be presented on a cold load.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
