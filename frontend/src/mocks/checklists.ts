// Seed checklists for the mock layer. The chat version repeats the official
// wording from ai/src/cqa_ai/checklists/freedom_chat_v1.json.
import type { ChecklistVersion, Criterion } from '../api/types.ts';

const criterion = (fields: Partial<Criterion> & Pick<Criterion, 'id' | 'section' | 'title' | 'type' | 'weight'>): Criterion => ({
  scored: true,
  flag: null,
  allow_na: false,
  yes_when: null,
  prompt: null,
  na_when: null,
  levels: [],
  team_notes: [],
  ...fields,
});

const sections = [
  { id: 's1', title: 'Начало и понимание запроса' },
  { id: 's2', title: 'Безопасность и решение' },
  { id: 's3', title: 'Ведение и завершение диалога' },
  { id: 's4', title: 'Грубые нарушения' },
];

const c04Levels = [
  { value: 20, text: 'Все существенные вопросы закрыты или дан корректный следующий шаг.' },
  { value: 15, text: 'Основной вопрос решён, пропущена второстепенная деталь.' },
  { value: 10, text: 'Часть запроса закрыта, существенный вопрос остался открытым.' },
  { value: 5, text: 'Есть общая подсказка, но клиенту всё ещё непонятно, как действовать.' },
  { value: 0, text: 'Ответа по существу нет или ключевая рекомендация ошибочна.' },
];

const c06Levels = [
  { value: 10, text: 'Ответы ясные и связные. Если было явное ожидание, оператор предупредил.' },
  { value: 7, text: 'Один заметный сбой, но клиент может понять ответ и продолжить.' },
  { value: 4, text: 'Клиенту приходится переспрашивать из-за формулировок или порядка ответов.' },
  { value: 0, text: 'Из-за бессвязных или противоречивых реплик ход диалога непонятен.' },
];

const chatCriteria: Criterion[] = [
  criterion({ id: 'c01', section: 's1', title: 'Установление контакта', type: 'boolean', weight: 10, yes_when: 'Оператор поздоровался на языке клиента и представился в первом ответе.' }),
  criterion({ id: 'c02', section: 's1', title: 'Выявление потребности', type: 'boolean', weight: 15, allow_na: true, yes_when: 'Оператор учёл известные детали и уточнил недостающее до ответа.', na_when: 'Данных для ответа хватало с самого начала.' }),
  criterion({ id: 'c03', section: 's2', title: 'Идентификация', type: 'boolean', weight: 20, allow_na: true, yes_when: 'Проверка личности подтверждена до раскрытия данных или защищённого действия.', na_when: 'Запрос не требовал идентификации.' }),
  criterion({ id: 'c04', section: 's2', title: 'Корректная и полная консультация', type: 'scale', weight: 20, allow_na: true, prompt: 'Оцените ответ или следующий шаг по шкале.', na_when: 'Чат закончился до того, как клиент сформулировал запрос.', levels: c04Levels }),
  criterion({ id: 'c05', section: 's3', title: 'Эмпатия и клиентоориентированность', type: 'boolean', weight: 15, yes_when: 'Оператор вежлив и, если клиент выразил недовольство или описал неудобство, отреагировал на конкретную проблему.' }),
  criterion({ id: 'c06', section: 's3', title: 'Управление диалогом, скорость и грамотность', type: 'scale', weight: 15, prompt: 'Оцените ясность, порядок ответов и предупреждение об ожидании по шкале.', levels: c06Levels }),
  criterion({ id: 'c07', section: 's3', title: 'Завершение', type: 'boolean', weight: 5, allow_na: true, yes_when: 'Оператор подвёл итог или предложил дальнейшую помощь и попрощался.', na_when: 'Чат оборвался до возможности его завершить.' }),
  criterion({ id: 'c08', section: 's4', title: 'Грубые ошибки', type: 'boolean', weight: 0, scored: false, flag: 'gross_error', yes_when: 'Выявлено оскорбление клиента, предложение платной услуги в обход компании или раскрытие конфиденциальной информации. Нет: ни одно из трёх не выявлено.' }),
];

export const chatChecklist: ChecklistVersion = {
  checklist_id: 'freedom-chat-quality',
  version: 1,
  title: 'Чек-лист качества чатов',
  channels: ['agent chat'],
  excluded_from_scoring: ['порог первой реакции в 3 минуты', 'теги', 'вложения'],
  sections,
  criteria: chatCriteria,
};

export const voiceChecklist: ChecklistVersion = {
  checklist_id: 'freedom-voice-quality',
  version: 1,
  title: 'Чек-лист качества звонков (условный)',
  channels: ['voice call'],
  excluded_from_scoring: [],
  sections,
  criteria: chatCriteria.map((item) =>
    item.id === 'c06'
      ? { ...item, prompt: 'Оцените логичность разговора, понятность объяснений и управление паузами по шкале.' }
      : item,
  ),
};
