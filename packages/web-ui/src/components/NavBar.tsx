import { Link, useLocation } from 'react-router-dom';
import { useAuth, type Role } from '../auth/useAuth.js';

interface NavItem {
  label: string;
  to: string;
  roles?: Role[];
}

interface NavSection {
  heading?: string;
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    items: [
      { label: 'Dashboard', to: '/dashboard', roles: ['workspace_admin'] },
      { label: 'Chat', to: '/' },
      { label: 'Notifications', to: '/notifications' },
    ],
  },
  {
    heading: 'Agents',
    items: [
      { label: 'Admin', to: '/admin', roles: ['workspace_admin'] },
      { label: 'LLM Providers', to: '/providers', roles: ['workspace_admin'] },
      { label: 'Sessions', to: '/sessions', roles: ['workspace_admin'] },
      { label: 'Delegation', to: '/delegation', roles: ['workspace_admin'] },
      { label: 'Approvals', to: '/approvals', roles: ['workspace_admin'] },
      { label: 'Memory', to: '/memory', roles: ['workspace_admin'] },
      { label: 'Skills', to: '/skills' },
    ],
  },
  {
    heading: 'Platform',
    items: [
      { label: 'Users', to: '/users', roles: ['workspace_admin'] },
      { label: 'Secrets', to: '/secrets', roles: ['workspace_admin'] },
      { label: 'Integrations', to: '/integrations', roles: ['workspace_admin'] },
      { label: 'Webhooks', to: '/webhooks', roles: ['workspace_admin'] },
      { label: 'Audit', to: '/audit', roles: ['auditor', 'workspace_admin'] },
      { label: 'Settings', to: '/settings' },
    ],
  },
];

export function NavBar() {
  const { user, roles, logout } = useAuth();
  const location = useLocation();

  // Hide nav on public pages and when logged out
  if (!user || location.pathname === '/login' || location.pathname === '/register') return null;

  const visibleSections = NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter(
      (item) => !item.roles || item.roles.some((r) => roles.includes(r)),
    ),
  })).filter((section) => section.items.length > 0);

  return (
    <aside className="fixed inset-y-0 left-0 w-56 bg-white border-r border-gray-200 flex flex-col">
      <div className="px-4 py-4 border-b border-gray-200">
        <Link to="/" className="flex items-center gap-2">
          <img src="/logo.png" alt="HonorClaw" className="w-[34px] h-[34px] max-w-none shrink-0" />
          <span className="font-bold text-lg text-gray-900">HonorClaw</span>
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {visibleSections.map((section, idx) => (
          <div key={section.heading ?? idx} className={idx > 0 ? 'mt-4' : ''}>
            {section.heading && (
              <p className="px-3 mb-1 text-xs font-semibold uppercase tracking-wider text-gray-400">
                {section.heading}
              </p>
            )}
            {section.items.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={`block px-3 py-2 rounded text-sm font-medium transition-colors ${
                  location.pathname === item.to || (item.to !== '/' && location.pathname.startsWith(item.to))
                    ? 'bg-blue-100 text-blue-700'
                    : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                {item.label}
              </Link>
            ))}
          </div>
        ))}
      </nav>

      <div className="border-t border-gray-200 px-4 py-3">
        <p className="text-xs text-gray-500 truncate">{user.email}</p>
        <button
          onClick={() => { void logout(); }}
          className="mt-1 text-xs text-gray-500 hover:text-red-600 transition-colors"
        >
          Logout
        </button>
      </div>
    </aside>
  );
}
