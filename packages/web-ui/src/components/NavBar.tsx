import { Link, useLocation } from 'react-router-dom';
import { useAuth, type Role } from '../auth/useAuth.js';

interface NavItem {
  label: string;
  to: string;
  roles?: Role[];
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Chat', to: '/' },
  { label: 'Dashboard', to: '/dashboard', roles: ['workspace_admin'] },
  { label: 'Skills', to: '/skills' },
  { label: 'Admin', to: '/admin', roles: ['workspace_admin'] },
  { label: 'Users', to: '/users', roles: ['workspace_admin'] },
  { label: 'Approvals', to: '/approvals', roles: ['workspace_admin'] },
  { label: 'Sessions', to: '/sessions', roles: ['workspace_admin'] },
  { label: 'Delegation', to: '/delegation', roles: ['workspace_admin'] },
  { label: 'Webhooks', to: '/webhooks', roles: ['workspace_admin'] },
  { label: 'Memory', to: '/memory', roles: ['workspace_admin'] },
  { label: 'Notifications', to: '/notifications' },
  { label: 'Secrets', to: '/secrets', roles: ['workspace_admin'] },
  { label: 'Audit', to: '/audit', roles: ['auditor', 'workspace_admin'] },
  { label: 'Integrations', to: '/integrations', roles: ['workspace_admin'] },
  { label: 'Settings', to: '/settings' },
];

export function NavBar() {
  const { user, roles, logout } = useAuth();
  const location = useLocation();

  if (!user) return null;

  const visibleItems = NAV_ITEMS.filter(
    (item) => !item.roles || item.roles.some((r) => roles.includes(r)),
  );

  return (
    <nav className="bg-white border-b border-gray-200 px-4 py-2 flex items-center justify-between">
      <div className="flex items-center gap-1">
        <Link to="/" className="flex items-center gap-2 mr-6">
          <img src="/logo.png" alt="HonorClaw" className="h-7 w-7" />
          <span className="font-bold text-lg text-gray-900">HonorClaw</span>
        </Link>
        {visibleItems.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              location.pathname === item.to || (item.to !== '/' && location.pathname.startsWith(item.to))
                ? 'bg-blue-100 text-blue-700'
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            {item.label}
          </Link>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <span className="text-sm text-gray-500">{user.email}</span>
        <button
          onClick={() => { void logout(); }}
          className="text-sm text-gray-500 hover:text-red-600 transition-colors"
        >
          Logout
        </button>
      </div>
    </nav>
  );
}
