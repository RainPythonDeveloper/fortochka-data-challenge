import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import type { Job, StageId } from '../api/types';

const POLL_MS = 1000;
const MAX_POLL_FAILURES = 5;
const STORE_KEY = 'sapa.jobs';

export type TrackedJob = { job: Job; conversationIds: string[]; startedAt: number; pollError: string | null };

/** `stage` is null when the backend does not report stages. */
export type Progress = { job: Job; startedAt: number; stage: StageId | 'queued' | null };

type JobsContext = {
  jobs: TrackedJob[];
  /** Grows when a job finishes, so pages can refetch. */
  revision: number;
  track: (job: Job, conversationIds: string[]) => void;
  dismiss: (id: string) => void;
};

const Context = createContext<JobsContext | null>(null);

export const isActive = ({ job, pollError }: TrackedJob) =>
  !pollError && (job.status === 'queued' || job.status === 'running');

export function progressFor(jobs: TrackedJob[], conversationId: string): Progress | null {
  const tracked = jobs.find((item) => isActive(item) && item.conversationIds.includes(conversationId));
  if (!tracked) return null;
  const { job, startedAt } = tracked;
  if (!job.current) return { job, startedAt, stage: null };
  const running = job.current.find((item) => item.conversation_id === conversationId);
  return { job, startedAt, stage: running?.stage ?? 'queued' };
}

type Stored = Pick<TrackedJob, 'conversationIds' | 'startedAt'> & { id: string };

function readStored(): Stored[] {
  try {
    return JSON.parse(sessionStorage.getItem(STORE_KEY) ?? '[]') as Stored[];
  } catch {
    return [];
  }
}

function writeStored(jobs: TrackedJob[]) {
  try {
    const active = jobs.filter(isActive).map(({ job, conversationIds, startedAt }) => ({ id: job.id, conversationIds, startedAt }));
    sessionStorage.setItem(STORE_KEY, JSON.stringify(active));
  } catch {
    // Only a reload during an evaluation loses its row state.
  }
}

// Lives above the routes: an evaluation keeps running while the user opens a dialogue.
export function JobsProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<TrackedJob[]>([]);
  const [revision, setRevision] = useState(0);
  const failures = useRef(new Map<string, number>());
  const hasActive = jobs.some(isActive);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  useEffect(() => {
    let live = true;
    for (const item of readStored()) {
      api.getJob(item.id).then(
        (job) => {
          if (!live) return;
          setJobs((current) =>
            current.some((entry) => entry.job.id === job.id)
              ? current
              : [{ job, conversationIds: item.conversationIds, startedAt: item.startedAt, pollError: null }, ...current],
          );
        },
        () => undefined,
      );
    }
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => writeStored(jobs), [jobs]);

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

  const track = useCallback((job: Job, conversationIds: string[]) => {
    setJobs((items) => [{ job, conversationIds, startedAt: Date.now(), pollError: null }, ...items]);
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
