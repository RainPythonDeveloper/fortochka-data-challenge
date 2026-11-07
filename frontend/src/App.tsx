import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { USE_MOCKS } from './api';
import { JobStrip } from './components/JobStrip';
import { JobsProvider } from './lib/jobs';
import { ChecklistsPage } from './pages/ChecklistsPage';
import { ConversationPage } from './pages/ConversationPage';
import { ConversationsPage } from './pages/ConversationsPage';
import { ReviewPage } from './pages/ReviewPage';

const navItems = [
  { to: '/conversations', label: 'Диалоги' },
  { to: '/checklists', label: 'Чек-листы' },
  { to: '/review', label: 'Очередь проверки' },
];

export default function App() {
  return (
    <JobsProvider>
      <div className="flex h-full min-w-[1024px] flex-col">
        <header className="flex h-11 shrink-0 items-center gap-6 bg-brand-900 px-4 text-white">
          <span className="text-sm font-semibold tracking-wide">CQA</span>
          <nav className="flex h-full gap-1">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `flex items-center border-b-2 px-3 ${isActive ? 'border-white font-medium' : 'border-transparent text-brand-100 hover:text-white'}`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          {USE_MOCKS && (
            <span className="ml-auto rounded bg-amber-300 px-2 py-0.5 text-xs font-medium text-amber-950">
              Режим моков: синтетические данные
            </span>
          )}
        </header>
        <JobStrip />
        <main className="min-h-0 flex-1 overflow-auto">
          <Routes>
            <Route path="/" element={<Navigate to="/conversations" replace />} />
            <Route path="/conversations" element={<ConversationsPage />} />
            <Route path="/conversations/:id" element={<ConversationPage />} />
            <Route path="/checklists" element={<ChecklistsPage />} />
            <Route path="/review" element={<ReviewPage />} />
            <Route path="*" element={<Navigate to="/conversations" replace />} />
          </Routes>
        </main>
      </div>
    </JobsProvider>
  );
}
