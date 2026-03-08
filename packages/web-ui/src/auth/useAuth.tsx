import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api } from '../api/client.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
}

export type Role = 'workspace_admin' | 'agent_user' | 'auditor' | 'api_service';

export interface AuthState {
  user: AuthUser | null;
  workspaceId: string | null;
  roles: Role[];
  isLoading: boolean;
  logout: () => Promise<void>;
  refreshAuth: () => Promise<void>;
}

interface MeResponse {
  user: AuthUser;
  workspaceId: string;
  roles: Role[];
}

// ── Context ─────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthState | null>(null);

// ── Provider ────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      try {
        const me = await api.get<MeResponse>('/auth/me');
        if (!cancelled) {
          setUser(me.user);
          setWorkspaceId(me.workspaceId);
          setRoles(me.roles);
        }
      } catch {
        // Not authenticated — leave user as null
        if (!cancelled) {
          setUser(null);
          setWorkspaceId(null);
          setRoles([]);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadSession();

    return () => {
      cancelled = true;
    };
  }, []);

  const refreshAuth = useCallback(async () => {
    try {
      const me = await api.get<MeResponse>('/auth/me');
      setUser(me.user);
      setWorkspaceId(me.workspaceId);
      setRoles(me.roles);
    } catch {
      setUser(null);
      setWorkspaceId(null);
      setRoles([]);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      // Best-effort
    }
    setUser(null);
    setWorkspaceId(null);
    setRoles([]);
  }, []);

  return (
    <AuthContext.Provider value={{ user, workspaceId, roles, isLoading, logout, refreshAuth }}>
      {children}
    </AuthContext.Provider>
  );
}

// ── Hook ────────────────────────────────────────────────────────────────

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}

// ── Protected Route ─────────────────────────────────────────────────────

interface ProtectedRouteProps {
  children: ReactNode;
  /** Roles that are allowed to access this route (OR logic). Empty = any authenticated user. */
  allowedRoles?: Role[];
}

export function ProtectedRoute({ children, allowedRoles }: ProtectedRouteProps) {
  const { user, roles, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (allowedRoles && allowedRoles.length > 0) {
    const hasRequiredRole = allowedRoles.some((r) => roles.includes(r));
    if (!hasRequiredRole) {
      return (
        <div className="flex items-center justify-center min-h-screen">
          <div className="text-center">
            <h2 className="text-xl font-semibold text-gray-900">Access Denied</h2>
            <p className="mt-2 text-gray-600">You do not have permission to view this page.</p>
          </div>
        </div>
      );
    }
  }

  return <>{children}</>;
}
