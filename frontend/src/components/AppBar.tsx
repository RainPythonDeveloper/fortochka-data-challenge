import { Link, NavLink } from 'react-router-dom';
import { USE_MOCKS } from '../api';
import logo from '../assets/freedom-logo-white.svg';
import { isActive, useJobs } from '../lib/jobs';
import { MOCK_LABEL, NAV } from '../lib/labels';
import { Spinner } from './ui';

export function AppBar() {
  const { jobs } = useJobs();
  const running = jobs.filter(isActive).reduce((sum, { job }) => sum + Math.max(job.total - job.done - job.failed, 0), 0);
  return (
    <header className="appbar">
      <span className="appbar__brand">
        <img className="appbar__logo" src={logo} alt="Freedom" />
        <span className="appbar__sep" />
        <span className="appbar__name">Sapa</span>
      </span>
      <nav className="appbar__nav" aria-label="Разделы">
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} className="appbar__link">
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="appbar__end">
        {running > 0 && (
          <Link to="/conversations" className="appbar__jobs">
            <Spinner /> Оценивается: {running}
          </Link>
        )}
        {USE_MOCKS && <span className="appbar__mock">{MOCK_LABEL}</span>}
      </div>
    </header>
  );
}
