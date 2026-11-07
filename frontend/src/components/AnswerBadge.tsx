import type { Answer, Criterion, ResultStatus } from '../api/types';
import { answerText, answerTone } from '../lib/format';
import { Badge } from './ui';

type Props = { criterion: Criterion | undefined; status: ResultStatus; answer: Answer };

export function AnswerBadge({ criterion, status, answer }: Props) {
  return <Badge tone={answerTone(criterion, status, answer)}>{answerText(criterion, status, answer)}</Badge>;
}
