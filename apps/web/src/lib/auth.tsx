import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { roleAtLeast, type AuthResponse, type SessionUser, type UserRole } from '@platter/shared';
import { api } from '@/lib/api-client.js';
import { queryKeys } from '@/lib/query.js';

/**
 * Session state for the whole client.
 *
 * The access token lives in memory only (see `api-client.ts`), which means a reload starts
 * with no credential at all. So the provider's first job is a silent refresh against the
 * httpOnly cookie: until that settles the app is in `loading`, and route guards must show a
 * splash rather than bouncing to the login screen — a redirect there would throw away the
 * user's deep link every single reload.
 */

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

export interface LoginCredentials {
  email: string;
  password: string;
  /** Only sent once the API has asked for it. */
  totp?: string;
  rememberMe?: boolean;
}

export interface RegisterInput {
  email: string;
  username: string;
  displayName: string;
  password: string;
}

export interface AuthContextValue {
  user: SessionUser | null;
  status: AuthStatus;
  isAdmin: boolean;
  isOwner: boolean;
  /** `true` once the silent refresh has settled, whichever way it went. */
  isSettled: boolean;
  hasRole: (minimum: UserRole) => boolean;
  login: (credentials: LoginCredentials) => Promise<SessionUser>;
  /** Creates an account. The very first account on an install is always the owner. */
  register: (input: RegisterInput) => Promise<SessionUser>;
  logout: () => Promise<void>;
  /** Replaces the cached session user after a profile edit, without a round trip. */
  setUser: (user: SessionUser) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUserState] = useState<SessionUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  /*
   * Refresh tokens rotate, so firing two refreshes concurrently spends the cookie twice and
   * logs the user straight back out. StrictMode runs mount/cleanup/mount, so the request is
   * memoised in a ref and *subscribed to* on each run rather than started again — a plain
   * "already ran" guard would leave the second mount with nothing to resolve against, and
   * the app would sit on the splash forever.
   */
  const bootstrap = useRef<Promise<AuthResponse | null> | null>(null);

  useEffect(() => {
    let active = true;

    bootstrap.current ??= api
      .post<AuthResponse>('/auth/refresh', undefined, { skipAuthRetry: true })
      .then((session) => {
        api.setAccessToken(session.accessToken);
        return session;
      })
      // No cookie, an expired one, or a reused one. All three mean "not signed in".
      .catch(() => null);

    void bootstrap.current.then((session) => {
      if (!active) return;
      setUserState(session?.user ?? null);
      setStatus(session ? 'authenticated' : 'anonymous');
    });

    return () => {
      active = false;
    };
  }, []);

  /*
   * The API client clears the token by itself when a refresh fails mid-session. Listening
   * here is what turns that into a real sign-out everywhere instead of a screen full of
   * silent 401s.
   */
  useEffect(
    () =>
      api.onTokenChange((token) => {
        if (token !== null) return;
        setUserState(null);
        setStatus((current) => (current === 'loading' ? current : 'anonymous'));
        queryClient.clear();
      }),
    [queryClient],
  );

  const login = useCallback(
    async (credentials: LoginCredentials) => {
      const session = await api.post<AuthResponse>('/auth/login', {
        email: credentials.email,
        password: credentials.password,
        rememberMe: credentials.rememberMe ?? false,
        ...(credentials.totp ? { totp: credentials.totp } : {}),
      });
      // Anything cached from a previous session belongs to a different person.
      queryClient.clear();
      api.setAccessToken(session.accessToken);
      setUserState(session.user);
      setStatus('authenticated');
      return session.user;
    },
    [queryClient],
  );

  const register = useCallback(
    async (input: RegisterInput) => {
      const session = await api.post<AuthResponse>('/auth/register', input);
      queryClient.clear();
      api.setAccessToken(session.accessToken);
      setUserState(session.user);
      setStatus('authenticated');
      return session.user;
    },
    [queryClient],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      // The server may be unreachable. Signing out locally still has to work — leaving a
      // session on screen because a request failed is worse than a stale refresh cookie.
    }
    api.setAccessToken(null);
    setUserState(null);
    setStatus('anonymous');
    queryClient.clear();
  }, [queryClient]);

  const setUser = useCallback((next: SessionUser) => setUserState(next), []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status,
      isAdmin: user ? roleAtLeast(user.role, 'admin') : false,
      isOwner: user ? user.role === 'owner' : false,
      isSettled: status !== 'loading',
      hasRole: (minimum: UserRole) => (user ? roleAtLeast(user.role, minimum) : false),
      login,
      register,
      logout,
      setUser,
    }),
    [user, status, login, register, logout, setUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}

/**
 * `GET /system/info`. Unauthenticated on purpose: the login screen needs `needsSetup`
 * before anyone has signed in. Shape mirrors the API route — it is not in `@platter/shared`
 * because nothing but this client consumes it.
 */
export interface SystemInfo {
  version: string;
  uptimeSeconds: number;
  needsSetup: boolean;
  counts: { users: number; servers: number; nodes: number };
  features: { ai: boolean; metrics: boolean; registrationEnabled: boolean };
}

export function useSystemInfo(): UseQueryResult<SystemInfo> {
  return useQuery({
    queryKey: queryKeys.system.info(),
    queryFn: () => api.get<SystemInfo>('/system/info'),
    // Whether an install needs setup changes exactly once, ever.
    staleTime: 5 * 60_000,
  });
}
