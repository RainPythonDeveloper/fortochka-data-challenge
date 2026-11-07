// Mirrors ai/src/cqa_ai/contracts.py and the HTTP section of CONTRACTS.md.
// Field names stay in snake_case on purpose: this is the wire format.

export type CriterionType = 'boolean' | 'scale';
export type ResultStatus = 'assessed' | 'not_applicable' | 'unassessable' | 'failed';
export type ReviewStatus = 'clear' | 'flagged';
export type Answer = 'yes' | 'no' | number | null;

export type Turn = { index: number; timestamp: string; speaker: string; text: string };

export type Section = { id: string; title: string };
export type ScaleLevel = { value: number; text: string };

export type Criterion = {
  id: string;
  section: string;
  title: string;
  type: CriterionType;
  weight: number;
  scored: boolean;
  flag: string | null;
  allow_na: boolean;
  yes_when: string | null;
  prompt: string | null;
  na_when: string | null;
  levels: ScaleLevel[];
  team_notes: string[];
};

export type ChecklistVersion = {
  checklist_id: string;
  version: number;
  title: string;
  channels: string[];
  excluded_from_scoring: string[];
  sections: Section[];
  criteria: Criterion[];
};

export type Evidence = { turn_index: number; quote: string };
export type TurnRange = { from_turn: number; to_turn: number };

export type CriterionResult = {
  criterion_id: string;
  status: ResultStatus;
  answer: Answer;
  justification: string;
  evidence: Evidence[];
  reviewed_range: TurnRange | null;
  expected_at_turn: number | null;
  review_flags: string[];
};

export type CriterionScore = {
  criterion_id: string;
  status: ResultStatus;
  answer: Answer;
  weight: number;
  effective_weight: number | null;
  points: number | null;
};

export type SectionScore = {
  section_id: string;
  title: string;
  earned: number;
  possible: number;
  percent: number | null;
  flags: string[];
};

export type ScoreSummary = {
  total: number | null;
  partial_total: number | null;
  is_partial: boolean;
  missing_criteria: string[];
  gross_error: boolean;
  gross_error_criteria: string[];
  criteria: CriterionScore[];
  sections: SectionScore[];
};

export type ModelAttempt = {
  provider: string;
  model: string;
  role: string;
  attempt: number;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  valid: boolean;
  errors: string[];
};

export type ImportResult = {
  group_id: string;
  imported: number;
  skipped: number;
  conversation_ids: string[];
  errors: string[];
};

export type ConversationSummary = {
  id: string;
  channel: string;
  language: string;
  turn_count: number;
  has_audio: boolean;
  group_id: string | null;
  latest_evaluation_id: string | null;
  latest_total: number | null;
  gross_error: boolean;
};
export type ConversationDetail = ConversationSummary & { turns: Turn[] };

export type ChecklistSummary = {
  checklist_id: string;
  title: string;
  latest_version: number;
  channels: string[];
};

export type EvaluationRequest = {
  conversation_ids: string[];
  checklist_id: string;
  version?: number;
  force?: boolean;
};

export type Job = {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  total: number;
  done: number;
  failed: number;
  evaluation_ids: string[];
  errors: string[];
};

export type EvaluationSummary = {
  id: string;
  conversation_id: string;
  checklist_id: string;
  checklist_version: number;
  status: 'done' | 'failed';
  total: number | null;
  final_total: number | null;
  gross_error: boolean;
  created_at: string;
};

export type RunLog = {
  run_id: string;
  content_hash: string;
  checklist_hash: string;
  prompt_hash: string;
  pipeline: string;
  attempts: ModelAttempt[];
  cache_hit: boolean;
  latency_ms: number | null;
  cost_usd: number | null;
};

export type EvaluationRun = EvaluationSummary & {
  results: CriterionResult[];
  score: ScoreSummary;
  final_results: CriterionResult[];
  final_score: ScoreSummary;
  checklist: ChecklistVersion;
  review_status: ReviewStatus;
  review_reasons: string[];
  log: RunLog;
};

export type AppealCreate = { evaluation_id: string; criterion_id: string; comment: string };

export type DecisionCreate = {
  decision: 'confirm' | 'change';
  new_answer?: Answer;
  new_status?: 'assessed' | 'not_applicable';
  reason: string;
  reviewer: string;
};

export type Appeal = {
  id: string;
  evaluation_id: string;
  criterion_id: string;
  comment: string;
  status: 'open' | 'decided';
  created_at: string;
  decision: (DecisionCreate & { decided_at: string }) | null;
};
