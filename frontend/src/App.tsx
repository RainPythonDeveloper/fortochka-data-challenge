import { Navigate, Route, Routes } from 'react-router-dom';
import { AppBar } from './components/AppBar';
import { JobsProvider } from './lib/jobs';
import { ConversationsPage } from './pages/ConversationsPage';
import { ReportPage } from './pages/ReportPage';
import { ReviewPage } from './pages/ReviewPage';
import { SheetPage } from './pages/SheetPage';

export default function App() {
  return (
    <JobsProvider>
      <div className="app">
        <AppBar />
        <main className="app-main">
          <Routes>
            <Route path="/" element={<Navigate to="/conversations" replace />} />
            <Route path="/conversations" element={<ConversationsPage />} />
            <Route path="/conversations/:id" element={<ReviewPage />} />
            <Route path="/sheet" element={<SheetPage />} />
            <Route path="/checklists" element={<Navigate to="/sheet" replace />} />
            <Route path="/report" element={<ReportPage />} />
            <Route path="*" element={<Navigate to="/conversations" replace />} />
          </Routes>
        </main>
      </div>
    </JobsProvider>
  );
}
