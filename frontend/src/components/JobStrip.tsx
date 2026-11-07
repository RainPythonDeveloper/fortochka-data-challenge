import { isActive, useJobs, type TrackedJob } from '../lib/jobs';
import { Button } from './ui';

function statusText({ job, pollError }: TrackedJob): string {
  if (pollError) return `Статус недоступен: ${pollError}`;
  if (job.status === 'queued') return 'В очереди';
  if (job.status === 'running') return 'Выполняется';
  if (job.status === 'failed') return 'Задача завершилась сбоем';
  return job.failed ? 'Завершено, есть сбои' : 'Завершено';
}

export function JobStrip() {
  const { jobs, dismiss } = useJobs();
  if (!jobs.length) return null;
  return (
    <div className="shrink-0 border-b border-line bg-white">
      {jobs.map((tracked) => {
        const { job } = tracked;
        const processed = job.done + job.failed;
        const percent = job.total ? Math.round((processed / job.total) * 100) : 0;
        const problem = job.status === 'failed' || job.failed > 0 || tracked.pollError;
        return (
          <div key={job.id} data-testid="job" className="flex items-center gap-3 px-4 py-1">
            <span className="font-medium">{tracked.label}</span>
            <div className="h-1.5 w-40 overflow-hidden rounded bg-stone-200">
              <div className={`h-full ${problem ? 'bg-amber-500' : 'bg-brand-700'}`} style={{ width: `${percent}%` }} />
            </div>
            <span className="text-stone-600">
              {processed} из {job.total}
              {job.failed > 0 && `, сбоев: ${job.failed}`}
            </span>
            <span className={problem ? 'text-amber-800' : 'text-stone-600'}>{statusText(tracked)}</span>
            {job.errors.length > 0 && <span className="truncate text-amber-800">{job.errors.join('; ')}</span>}
            {!isActive(tracked) && (
              <Button variant="ghost" className="ml-auto" onClick={() => dismiss(job.id)}>
                Скрыть
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
