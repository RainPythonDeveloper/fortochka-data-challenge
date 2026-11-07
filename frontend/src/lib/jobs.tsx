import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import type { Job } from '../api/types';

const POLL_MS = 1000;
const MAX_POLL_FAILURES = 5;

export type TrackedJob = { job: Job; label: string; pollError: string | null };

type JobsContext = {
  jobs: TrackedJob[];
  /** Grows when a job finishes, so pages can refetch. */
  revision: number;
  track: (job: Job, label: string) => void;
  dismiss: (id: string) => void;
};

const Context = createContext<JobsContext | null>(null);

export const isActive = ({ job, pollError }: TrackedJob) =>
  !pollError && (job.status === 'queued' || job.status === 'running');

// Lives above the routes: an evaluation keeps running while the user opens a card.
export function JobsProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<TrackedJob[]>([]);
  const [revision, setRevision] = useState(0);
  const failures = useRef(new Map<string, number>());
  const hasActive = jobs.some(isActive);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => {
      for (const tracked of jobsRef.current.filter(isActive)) {
        const id = tracked.job.id;
        api.getJob(id).then(
          (job) => {
            failures.current.delete(id);
            setJobs((items) => items.map((item) => (item.job.id === id ? { ...item, job } : item)));
            if (job.status === 'done' || job.status === 'failed') setRevision((value) => value + 1);
          },
          (error: Error) => {
            const count = (failures.current.get(id) ?? 0) + 1;
            failures.current.set(id, count);
            if (count >= MAX_POLL_FAILURES) {
              setJobs((items) => items.map((item) => (item.job.id === id ? { ...item, pollError: error.message } : item)));
            }
          },
        );
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [hasActive]);

  const track = useCallback((job: Job, label: string) => {
    setJobs((items) => [{ job, label, pollError: null }, ...items]);
  }, []);
  const dismiss = useCallback((id: string) => {
    setJobs((items) => items.filter((item) => item.job.id !== id));
  }, []);

  const value = useMemo(() => ({ jobs, revision, track, dismiss }), [jobs, revision, track, dismiss]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useJobs(): JobsContext {
  const value = useContext(Context);
  if (!value) throw new Error('useJobs needs JobsProvider');
  return value;
}
