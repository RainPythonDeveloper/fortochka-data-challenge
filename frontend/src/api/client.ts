import { host } from '../host/hostAdapter';
import type {
  Appeal,
  AppealCreate,
  ChecklistSummary,
  ChecklistVersion,
  ConversationDetail,
  ConversationSummary,
  DecisionCreate,
  EvaluationCompare,
  EvaluationRequest,
  EvaluationRun,
  EvaluationSummary,
  ExportResult,
  ImportResult,
  Job,
  ReportSummary,
  TranscriptResult,
} from './types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type ConversationFilters = { channel?: string; language?: string };
export type ExportFilters = { group_id?: string; checklist_id?: string };
export type AppealFilters = { status?: Appeal['status']; evaluation_id?: string };

export type Api = {
  importGroup: (groupId: string) => Promise<ImportResult>;
  listConversations: (filters?: ConversationFilters) => Promise<ConversationSummary[]>;
  getConversation: (id: string) => Promise<ConversationDetail>;
  /** Address to open in a new tab, or null when no recording can be served. */
  audioUrl: (id: string) => string | null;
  uploadTranscript: (record: unknown) => Promise<TranscriptResult>;
  listChecklists: () => Promise<ChecklistSummary[]>;
  getChecklist: (id: string, version?: number) => Promise<ChecklistVersion>;
  createChecklist: (checklist: ChecklistVersion) => Promise<ChecklistVersion>;
  createChecklistVersion: (checklist: ChecklistVersion) => Promise<ChecklistVersion>;
  createEvaluation: (request: EvaluationRequest) => Promise<Job>;
  getJob: (id: string) => Promise<Job>;
  listEvaluations: (conversationId: string) => Promise<EvaluationSummary[]>;
  getEvaluation: (id: string) => Promise<EvaluationRun>;
  compareEvaluations: (a: string, b: string) => Promise<EvaluationCompare>;
  getReport: (groupId?: string) => Promise<ReportSummary>;
  createAppeal: (appeal: AppealCreate) => Promise<Appeal>;
  listAppeals: (filters?: AppealFilters) => Promise<Appeal[]>;
  decideAppeal: (id: string, decision: DecisionCreate) => Promise<Appeal>;
  exportResults: (filters?: ExportFilters) => Promise<ExportResult>;
  exportCsv: (filters?: ExportFilters) => Promise<string>;
};

// The contract says detail is a string, but FastAPI validation errors send a list.
function readDetail(body: unknown, status: number): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail.map((item) => (item as { msg?: string }).msg ?? JSON.stringify(item)).join('; ');
  }
  return `Сервер вернул ошибку ${status}`;
}

type RequestInit = { method: string; body?: unknown };

async function requestText(path: string, init?: RequestInit): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${host.apiBaseUrl()}${path}`, {
      method: init?.method ?? 'GET',
      headers: init?.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError(0, 'Нет связи с сервером. Проверьте, что backend запущен и адрес API верный.');
  }
  const text = await response.text();
  if (response.ok) return text;
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // A proxy error page is not JSON. readDetail falls back to the status code.
  }
  throw new ApiError(response.status, readDetail(body, response.status));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const text = await requestText(path, init);
  try {
    return (text ? JSON.parse(text) : null) as T;
  } catch {
    throw new ApiError(200, 'Сервер вернул ответ не в формате JSON.');
  }
}

function query(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1]));
  return entries.length ? `?${new URLSearchParams(entries)}` : '';
}

const seg = encodeURIComponent;

export const httpApi: Api = {
  importGroup: (groupId) => request('/imports', { method: 'POST', body: { group_id: groupId } }),
  listConversations: (filters = {}) => request(`/conversations${query(filters)}`),
  getConversation: (id) => request(`/conversations/${seg(id)}`),
  audioUrl: (id) => `${host.apiBaseUrl()}/conversations/${seg(id)}/audio`,
  uploadTranscript: (record) => request('/transcripts', { method: 'POST', body: record }),
  listChecklists: () => request('/checklists'),
  getChecklist: (id, version) =>
    request(version ? `/checklists/${seg(id)}/versions/${version}` : `/checklists/${seg(id)}`),
  createChecklist: (body) => request('/checklists', { method: 'POST', body }),
  createChecklistVersion: (checklist) =>
    request(`/checklists/${seg(checklist.checklist_id)}/versions`, { method: 'POST', body: checklist }),
  createEvaluation: (body) => request('/evaluations', { method: 'POST', body }),
  getJob: (id) => request(`/jobs/${seg(id)}`),
  listEvaluations: (conversationId) => request(`/evaluations${query({ conversation_id: conversationId })}`),
  getEvaluation: (id) => request(`/evaluations/${seg(id)}`),
  compareEvaluations: (a, b) => request(`/evaluations/compare${query({ a, b })}`),
  getReport: (groupId) => request(`/reports/summary${query({ group_id: groupId })}`),
  createAppeal: (body) => request('/appeals', { method: 'POST', body }),
  listAppeals: (filters = {}) => request(`/appeals${query(filters)}`),
  decideAppeal: (id, body) => request(`/appeals/${seg(id)}/decisions`, { method: 'POST', body }),
  exportResults: (filters = {}) => request(`/exports/ai-results${query({ format: 'json', ...filters })}`),
  exportCsv: (filters = {}) => requestText(`/exports/ai-results${query({ format: 'csv', ...filters })}`),
};
