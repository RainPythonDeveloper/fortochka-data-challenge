// In-memory stand-in for the backend. Reloading the page resets it.
import type { Api } from '../api/client.ts';
import { ApiError } from '../api/client.ts';
import type {
  Appeal,
  ChecklistVersion,
  ConversationDetail,
  ConversationSummary,
  CriterionResult,
  EvaluationRun,
  EvaluationSummary,
  Job,
  ModelAttempt,
  ReviewStatus,
} from '../api/types.ts';
import { chatChecklist, voiceChecklist } from './checklists.ts';
import { importableConversations, seedConversations } from './conversations.ts';
import { failingConversations, seedOpenAppeal, seedRuns, seedStubConversations } from './results.ts';
import { calculateScore } from './scoring.ts';

const clone = <T>(value: T): T => structuredClone(value);
const wait = (ms = 180) => new Promise((resolve) => setTimeout(resolve, ms));
const fakeHash = (seed: string) =>
  Array.from({ length: 4 }, (_, part) => {
    let hash = 2166136261 + part;
    for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return (hash >>> 0).toString(16).padStart(8, '0');
  }).join('');

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${String(++sequence).padStart(4, '0')}`;
let clock = Date.parse('2026-01-20T08:00:00Z');
const now = () => new Date((clock += 60_000)).toISOString();

const conversations: ConversationDetail[] = clone(seedConversations);
const importPool: ConversationDetail[] = clone(importableConversations);
const checklists = new Map<string, ChecklistVersion[]>([
  [chatChecklist.checklist_id, [clone(chatChecklist)]],
  [voiceChecklist.checklist_id, [clone(voiceChecklist)]],
]);
const runs: EvaluationRun[] = [];
const appeals: Appeal[] = [];
const jobs = new Map<string, Job>();

const latestOf = (checklistId: string) => {
  const versions = checklists.get(checklistId);
  if (!versions) throw new ApiError(404, 'Чек-лист не найден');
  return versions[versions.length - 1];
};

const findConversation = (id: string) => {
  const found = conversations.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'Диалог не найден');
  return found;
};

const findRun = (id: string) => {
  const found = runs.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'Оценка не найдена');
  return found;
};

function attempts(stub: boolean, invalid?: string): ModelAttempt[] {
  const base = { role: 'primary', attempt: 1, cost_usd: 0.0031, input_tokens: 2140, output_tokens: 610, latency_ms: 2400 };
  if (stub) {
    return [{ provider: 'mock', model: 'mock', role: 'primary', attempt: 1, latency_ms: null, input_tokens: null, output_tokens: null, cost_usd: null, valid: true, errors: [] }];
  }
  const first: ModelAttempt = { ...base, provider: 'demo-provider', model: 'demo-model', valid: !invalid, errors: invalid ? [invalid] : [] };
  return invalid ? [first, { ...first, attempt: 2 }] : [first];
}

function buildRun(
  conversation: ConversationDetail,
  checklist: ChecklistVersion,
  results: CriterionResult[],
  options: { stub?: boolean; failed?: boolean; invalid?: string; review_status?: ReviewStatus; review_reasons?: string[] } = {},
): EvaluationRun {
  const id = nextId('eval');
  const score = calculateScore(checklist, results);
  const attemptList = attempts(Boolean(options.stub), options.invalid);
  const cost = attemptList.reduce((sum, item) => sum + (item.cost_usd ?? 0), 0);
  const run: EvaluationRun = {
    id,
    conversation_id: conversation.id,
    checklist_id: checklist.checklist_id,
    checklist_version: checklist.version,
    status: options.failed ? 'failed' : 'done',
    total: score.total,
    final_total: score.total,
    gross_error: score.gross_error,
    created_at: now(),
    results,
    score,
    final_results: clone(results),
    final_score: clone(score),
    checklist: clone(checklist),
    review_status: options.stub ? 'flagged' : (options.review_status ?? 'clear'),
    review_reasons: options.stub ? ['mock_provider'] : (options.review_reasons ?? []),
    log: {
      run_id: id,
      content_hash: fakeHash(conversation.id),
      checklist_hash: fakeHash(`${checklist.checklist_id}:${checklist.version}`),
      prompt_hash: options.stub ? '' : fakeHash('prompt'),
      pipeline: 'single',
      attempts: attemptList,
      cache_hit: false,
      latency_ms: options.stub ? 3 : attemptList.reduce((sum, item) => sum + (item.latency_ms ?? 0), 0),
      cost_usd: cost > 0 ? Number(cost.toFixed(4)) : null,
    },
  };
  runs.push(run);
  syncConversation(run);
  return run;
}

function syncConversation(run: EvaluationRun) {
  const conversation = findConversation(run.conversation_id);
  conversation.latest_evaluation_id = run.id;
  conversation.latest_total = run.final_total;
  conversation.gross_error = run.final_score.gross_error;
}

// Stub evaluator. Like the mock provider in cqa_ai it calls no model; it keeps the
// previous answer when it still fits, so a new checklist version gives a stable demo.
function stubResults(conversation: ConversationDetail, checklist: ChecklistVersion): CriterionResult[] {
  const previous = [...runs].reverse().find((run) => run.conversation_id === conversation.id && run.status === 'done');
  const firstOperator = conversation.turns.find((turn) => turn.speaker === 'operator');
  const evidence = firstOperator ? [{ turn_index: firstOperator.index, quote: firstOperator.text }] : [];
  return checklist.criteria.map((criterion) => {
    const old = previous?.results.find((item) => item.criterion_id === criterion.id);
    const values = criterion.levels.map((level) => level.value);
    const fits =
      old &&
      ((old.status === 'not_applicable' && criterion.allow_na) ||
        (old.status === 'assessed' &&
          (criterion.type === 'boolean' ? typeof old.answer === 'string' : values.includes(old.answer as number))));
    if (fits) return { ...clone(old), review_flags: [...old.review_flags.filter((flag) => flag !== 'mock_provider'), 'mock_provider'] };
    return {
      criterion_id: criterion.id,
      status: 'assessed',
      answer: criterion.type === 'scale' ? Math.max(...values) : criterion.flag ? 'no' : 'yes',
      justification: 'Заглушка: реальная модель не вызывалась.',
      evidence,
      reviewed_range: null,
      expected_at_turn: null,
      review_flags: ['mock_provider'],
    };
  });
}

for (const seed of seedRuns) {
  buildRun(findConversation(seed.conversation_id), seed.checklist === 'chat' ? chatChecklist : voiceChecklist, clone(seed.results), {
    invalid: seed.invalid_attempt,
    review_status: seed.review_status,
    review_reasons: seed.review_reasons,
  });
}
for (const id of seedStubConversations) {
  const conversation = findConversation(id);
  buildRun(conversation, chatChecklist, stubResults(conversation, chatChecklist), { stub: true });
}
for (const id of failingConversations) {
  buildRun(findConversation(id), chatChecklist, [], { failed: true, invalid: 'Провайдер не ответил за отведённое время' });
}
{
  const conversation = findConversation(seedOpenAppeal.conversation_id);
  appeals.push({
    id: nextId('appeal'),
    evaluation_id: conversation.latest_evaluation_id as string,
    criterion_id: seedOpenAppeal.criterion_id,
    comment: seedOpenAppeal.comment,
    status: 'open',
    created_at: now(),
    decision: null,
  });
}

const toSummary = ({ turns: _turns, ...summary }: ConversationDetail): ConversationSummary => clone(summary);

const toEvaluationSummary = (run: EvaluationRun): EvaluationSummary => ({
  id: run.id,
  conversation_id: run.conversation_id,
  checklist_id: run.checklist_id,
  checklist_version: run.checklist_version,
  status: run.status,
  total: run.total,
  final_total: run.final_total,
  gross_error: run.gross_error,
  created_at: run.created_at,
});

function applyDecisions(run: EvaluationRun) {
  const results = clone(run.results);
  for (const appeal of appeals) {
    const decision = appeal.decision;
    if (appeal.evaluation_id !== run.id || decision?.decision !== 'change') continue;
    const target = results.find((item) => item.criterion_id === appeal.criterion_id);
    if (!target) continue;
    target.status = decision.new_status ?? 'assessed';
    target.answer = target.status === 'assessed' ? (decision.new_answer ?? null) : null;
    target.justification = `Решение проверяющего: ${decision.reason}`;
  }
  run.final_results = results;
  run.final_score = calculateScore(run.checklist, results);
  run.final_total = run.final_score.total;
  run.gross_error = run.final_score.gross_error;
  if (conversations.find((item) => item.id === run.conversation_id)?.latest_evaluation_id === run.id) {
    syncConversation(run);
  }
}

function runJob(job: Job, ids: string[], checklist: ChecklistVersion, force: boolean) {
  job.status = 'running';
  const step = (position: number) => {
    if (position >= ids.length) {
      job.status = job.failed === job.total ? 'failed' : 'done';
      return;
    }
    const conversation = findConversation(ids[position]);
    const cached = runs.find(
      (run) =>
        run.conversation_id === conversation.id &&
        run.checklist_id === checklist.checklist_id &&
        run.checklist_version === checklist.version &&
        run.status === 'done',
    );
    if (failingConversations.includes(conversation.id)) {
      const failed = buildRun(conversation, checklist, [], { failed: true, invalid: 'Провайдер не ответил за отведённое время' });
      job.failed += 1;
      job.errors.push(`${conversation.id}: провайдер не ответил за отведённое время`);
      job.evaluation_ids.push(failed.id);
    } else if (cached && !force) {
      job.evaluation_ids.push(cached.id);
      job.done += 1;
    } else {
      const run = buildRun(conversation, checklist, stubResults(conversation, checklist), { stub: true });
      job.evaluation_ids.push(run.id);
      job.done += 1;
    }
    setTimeout(() => step(position + 1), 900);
  };
  setTimeout(() => step(0), 500);
}

export const mockApi: Api = {
  async importGroup(groupId) {
    await wait(500);
    const added = importPool.splice(0);
    conversations.push(...added);
    return {
      group_id: groupId,
      imported: added.length,
      skipped: added.length ? 0 : conversations.length,
      conversation_ids: added.map((item) => item.id),
      errors: [],
    };
  },
  async listConversations(filters = {}) {
    await wait();
    return conversations
      .filter((item) => (!filters.channel || item.channel === filters.channel) && (!filters.language || item.language === filters.language))
      .map(toSummary);
  },
  async getConversation(id) {
    await wait();
    return clone(findConversation(id));
  },
  audioUrl: () => null,
  async uploadTranscript() {
    throw new ApiError(501, 'Загрузка транскрипта в режиме моков не поддерживается');
  },
  async listChecklists() {
    await wait();
    return [...checklists.keys()].map((id) => {
      const latest = latestOf(id);
      return { checklist_id: id, title: latest.title, latest_version: latest.version, channels: latest.channels };
    });
  },
  async getChecklist(id, version) {
    await wait();
    const found = version ? checklists.get(id)?.find((item) => item.version === version) : latestOf(id);
    if (!found) throw new ApiError(404, 'Версия чек-листа не найдена');
    return clone(found);
  },
  async createChecklistVersion(checklist) {
    await wait(300);
    const saved = { ...clone(checklist), version: latestOf(checklist.checklist_id).version + 1 };
    checklists.get(checklist.checklist_id)?.push(saved);
    return clone(saved);
  },
  async createEvaluation(request) {
    await wait();
    if (!request.conversation_ids.length) throw new ApiError(422, 'Не выбраны диалоги');
    const versions = checklists.get(request.checklist_id);
    const checklist = request.version ? versions?.find((item) => item.version === request.version) : latestOf(request.checklist_id);
    if (!checklist) throw new ApiError(404, 'Версия чек-листа не найдена');
    const job: Job = { id: nextId('job'), status: 'queued', total: request.conversation_ids.length, done: 0, failed: 0, evaluation_ids: [], errors: [] };
    jobs.set(job.id, job);
    runJob(job, request.conversation_ids, checklist, Boolean(request.force));
    return clone(job);
  },
  async getJob(id) {
    await wait(60);
    const job = jobs.get(id);
    if (!job) throw new ApiError(404, 'Задача не найдена');
    return clone(job);
  },
  async listEvaluations(conversationId) {
    await wait();
    return runs.filter((run) => run.conversation_id === conversationId).map(toEvaluationSummary).reverse();
  },
  async getEvaluation(id) {
    await wait();
    return clone(findRun(id));
  },
  async createAppeal(input) {
    await wait();
    const run = findRun(input.evaluation_id);
    if (!run.results.some((item) => item.criterion_id === input.criterion_id)) {
      throw new ApiError(422, 'Критерия нет в этом запуске');
    }
    const appeal: Appeal = { id: nextId('appeal'), ...input, status: 'open', created_at: now(), decision: null };
    appeals.push(appeal);
    return clone(appeal);
  },
  async listAppeals(status) {
    await wait();
    return clone(appeals.filter((item) => !status || item.status === status));
  },
  async decideAppeal(id, decision) {
    await wait(300);
    const appeal = appeals.find((item) => item.id === id);
    if (!appeal) throw new ApiError(404, 'Апелляция не найдена');
    if (appeal.status === 'decided') throw new ApiError(409, 'По апелляции уже есть решение');
    if (!decision.reason.trim()) throw new ApiError(422, 'Нужна причина решения');
    appeal.status = 'decided';
    appeal.decision = { ...decision, decided_at: now() };
    applyDecisions(findRun(appeal.evaluation_id));
    return clone(appeal);
  },
};
