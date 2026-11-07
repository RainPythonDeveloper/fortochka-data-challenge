import { host } from '../host/hostAdapter';
import type {
  Appeal,
  AppealCreate,
  ChecklistSummary,
  ChecklistVersion,
  ConversationDetail,
  ConversationSummary,
  DecisionCreate,
  EvaluationRequest,
  EvaluationRun,
  EvaluationSummary,
  ImportResult,
  Job,
} from './types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type ConversationFilters = { channel?: string; language?: string };

export type Api = {
  importGroup: (groupId: string) => Promise<ImportResult>;
  listConversations: (filters?: ConversationFilters) => Promise<ConversationSummary[]>;
  getConversation: (id: string) => Promise<ConversationDetail>;
  /** Address to open in a new tab, or null when no recording can be served. */
  audioUrl: (id: string) => string | null;
  uploadTranscript: (record: unknown) => Promise<ConversationSummary>;
  listChecklists: () => Promise<ChecklistSummary[]>;
  getChecklist: (id: string, version?: number) => Promise<ChecklistVersion>;
  createChecklistVersion: (checklist: ChecklistVersion) => Promise<ChecklistVersion>;
  createEvaluation: (request: EvaluationRequest) => Promise<Job>;
  getJob: (id: string) => Promise<Job>;
  listEvaluations: (conversationId: string) => Promise<EvaluationSummary[]>;
  getEvaluation: (id: string) => Promise<EvaluationRun>;
  createAppeal: (appeal: AppealCreate) => Promise<Appeal>;
  listAppeals: (status?: Appeal['status']) => Promise<Appeal[]>;
  decideAppeal: (id: string, decision: DecisionCreate) => Promise<Appeal>;
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

async function request<T>(path: string, init?: { method: string; body?: unknown }): Promise<T> {
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
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    if (response.ok) throw new ApiError(response.status, 'Сервер вернул ответ не в формате JSON.');
  }
  if (!response.ok) throw new ApiError(response.status, readDetail(body, response.status));
  return body as T;
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
  createChecklistVersion: (checklist) =>
    request(`/checklists/${seg(checklist.checklist_id)}/versions`, { method: 'POST', body: checklist }),
  createEvaluation: (body) => request('/evaluations', { method: 'POST', body }),
  getJob: (id) => request(`/jobs/${seg(id)}`),
  listEvaluations: (conversationId) => request(`/evaluations${query({ conversation_id: conversationId })}`),
  getEvaluation: (id) => request(`/evaluations/${seg(id)}`),
  createAppeal: (body) => request('/appeals', { method: 'POST', body }),
  listAppeals: (status) => request(`/appeals${query({ status })}`),
  decideAppeal: (id, body) => request(`/appeals/${seg(id)}/decisions`, { method: 'POST', body }),
};
