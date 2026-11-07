// Hand-written synthetic evaluations. Each one exists to show a UI case:
// N/A, a gross error with a high total, a missed action, a review flag, a failed
// criterion. They live only in the mock layer and never reach a real build.
import type { Answer, CriterionResult, Evidence, ReviewStatus, TurnRange } from '../api/types.ts';

type Extra = {
  evidence?: Evidence[];
  range?: TurnRange;
  expected?: number;
  flags?: string[];
};

const assessed = (criterion_id: string, answer: Answer, justification: string, extra: Extra = {}): CriterionResult => ({
  criterion_id,
  status: 'assessed',
  answer,
  justification,
  evidence: extra.evidence ?? [],
  reviewed_range: extra.range ?? null,
  expected_at_turn: extra.expected ?? null,
  review_flags: extra.flags ?? [],
});

const na = (criterion_id: string, justification: string): CriterionResult => ({
  ...assessed(criterion_id, null, justification),
  status: 'not_applicable',
});

const ev = (turn_index: number, quote: string): Evidence => ({ turn_index, quote });

export type SeedRun = {
  conversation_id: string;
  checklist: 'chat' | 'voice';
  results: CriterionResult[];
  review_status?: ReviewStatus;
  review_reasons?: string[];
  invalid_attempt?: string;
};

export const seedRuns: SeedRun[] = [
  {
    conversation_id: 'A-1042',
    checklist: 'chat',
    results: [
      assessed('c01', 'yes', 'В первом ответе оператор поздоровался и представился.', { evidence: [ev(6, 'Здравствуйте! Меня зовут Алина.')] }),
      na('c02', 'Клиент сразу задал конкретный вопрос, данных для ответа хватало.'),
      na('c03', 'Вопрос о том, где посмотреть тариф, не требует идентификации.'),
      assessed('c04', 15, 'Основной вопрос решён, но про приложение ответ слишком общий.', { evidence: [ev(7, 'Тариф указан в кабинете под ФИО.'), ev(9, 'В приложении тоже в профиле.')] }),
      assessed('c05', 'yes', 'Оператор вежлив, недовольства клиент не выражал.', { evidence: [ev(6, 'Здравствуйте!')] }),
      assessed('c06', 7, 'Один заметный сбой: ответ разбит на две реплики и клиенту пришлось уточнять про приложение.', { evidence: [ev(9, 'В приложении тоже в профиле.')] }),
      assessed('c07', 'no', 'Попрощался, но не подвёл итог и не предложил помощь.', { evidence: [ev(11, 'Пожалуйста. Хорошего дня!')], range: { from_turn: 10, to_turn: 12 }, flags: ['Спорное правило: прощание без итога читается как «Нет»'] }),
      assessed('c08', 'no', 'Оскорблений, услуг в обход компании и раскрытия данных нет.', { range: { from_turn: 6, to_turn: 12 } }),
    ],
  },
  {
    conversation_id: 'A-1034',
    checklist: 'chat',
    results: [
      assessed('c01', 'yes', 'В первом ответе оператор поздоровался и назвал имя.', { evidence: [ev(5, 'Здравствуйте! Меня зовут Алия.')] }),
      na('c02', 'Выполнено условие N/A: клиент сразу назвал тариф и вопрос, данных для ответа хватало.'),
      na('c03', 'Выполнено условие N/A: общий вопрос о тарифе не требует идентификации.'),
      assessed('c04', 20, 'Оператор ответил на оба вопроса о комиссии.', { evidence: [ev(5, 'комиссия за сделку с акциями составляет 0,1%'), ev(7, 'Минимальной комиссии на этом тарифе нет.')] }),
      assessed('c05', 'yes', 'Оператор вежлив, недовольства клиент не выражал.', { evidence: [ev(9, 'Рада была помочь')] }),
      assessed('c06', 10, 'Ответы короткие и связные, ожиданий не было.', { evidence: [ev(7, 'Могу ещё чем-то помочь?')] }),
      assessed('c07', 'yes', 'Оператор предложил помощь и попрощался.', { evidence: [ev(9, 'хорошего дня!')] }),
      assessed('c08', 'no', 'Оскорблений, услуг в обход компании и раскрытия данных нет.', { range: { from_turn: 5, to_turn: 9 } }),
    ],
  },
  {
    conversation_id: 'A-1040',
    checklist: 'chat',
    results: [
      assessed('c01', 'yes', 'Оператор поздоровался и представился.', { evidence: [ev(3, 'Добрый день! Меня зовут Тимур.')] }),
      assessed('c02', 'yes', 'Оператор уточнил сумму и срок до рекомендации.', { evidence: [ev(3, 'Какую сумму и на какой срок вы рассматриваете?')] }),
      na('c03', 'Выполнено условие N/A: общий вопрос, данные счёта не затрагивались.'),
      assessed('c04', 20, 'Корректный следующий шаг через приложение дан.', { evidence: [ev(5, 'Открыть его можно в приложении: Меню → Инвестировать.')] }),
      assessed('c05', 'yes', 'Оператор вежлив на протяжении диалога.', { evidence: [ev(8, 'Всего доброго!')] }),
      assessed('c06', 7, 'Две реплики подряд противоречат друг другу по смыслу, но ход диалога понятен.', { evidence: [ev(6, 'Но если хотите доходность выше')] }),
      assessed('c07', 'yes', 'Оператор предложил обратиться снова и попрощался.', { evidence: [ev(8, 'пишите, если появятся вопросы')] }),
      assessed('c08', 'yes', 'Предложение услуги в обход компании: перевод денег оператору лично. Отказ клиента этого не меняет.', { evidence: [ev(6, 'переведите деньги мне лично на карту')] }),
    ],
  },
  {
    conversation_id: 'A-1041',
    checklist: 'chat',
    results: [
      assessed('c01', 'no', 'Приветствие есть, имени в первом ответе нет.', { range: { from_turn: 3, to_turn: 3 }, expected: 3, evidence: [ev(3, 'Сәлеметсіз бе!')] }),
      assessed('c02', 'yes', 'Оператор уточнил источник пополнения.', { evidence: [ev(3, 'Шотты қай банк картасынан толтырасыз?')] }),
      na('c03', 'Выполнено условие N/A: вопрос о приложении не требует идентификации.'),
      assessed('c04', 20, 'Оператор указал раздел и порядок действий.', { evidence: [ev(5, '«Меню → Пополнить» бөлімін ашып')] }),
      assessed('c05', 'yes', 'Оператор вежлив, жалоб не было.', { evidence: [ev(3, 'Сәлеметсіз бе!')] }),
      assessed('c06', 10, 'Ответы ясные и последовательные.', { evidence: [ev(5, 'карта деректерін енгізіңіз')] }),
      assessed('c07', 'no', 'Прощание и предложение помощи пропущены: после благодарности клиента оператор закрыл чат без реплики. Основание: системное событие закрытия.', { range: { from_turn: 6, to_turn: 7 }, expected: 7, evidence: [ev(7, 'Оператор чатты жапты.')] }),
      assessed('c08', 'no', 'Грубых нарушений не найдено.', { range: { from_turn: 3, to_turn: 7 } }),
    ],
  },
  {
    conversation_id: 'A-1039',
    checklist: 'chat',
    review_status: 'flagged',
    review_reasons: ['Граница ступеней шкалы: второй вопрос клиента закрыт лишь частично.'],
    results: [
      assessed('c01', 'yes', 'Оператор поздоровался и представился.', { evidence: [ev(3, "Hi, I'm Dana.")] }),
      na('c02', 'Выполнено условие N/A: клиент сразу описал ситуацию, данных хватало.'),
      assessed('c03', 'yes', 'Системное событие подтверждения личности идёт раньше раскрытия статуса вывода.', { evidence: [ev(4, 'Client identity confirmed.')] }),
      assessed('c04', 10, 'Статус вывода объяснён, но вопрос о повторе вывода остался без ответа.', { evidence: [ev(7, 'Usually these go through without any issue.')], flags: ['borderline_scale'] }),
      assessed('c05', 'yes', 'Оператор отреагировал на конкретное неудобство.', { evidence: [ev(3, 'I understand it is frustrating.')] }),
      assessed('c06', 7, 'Один заметный сбой: ответ на второй вопрос уходит от темы.', { evidence: [ev(7, 'Usually these go through')] }),
      assessed('c07', 'yes', 'Оператор предложил помощь и попрощался.', { evidence: [ev(9, 'Have a good day!')] }),
      assessed('c08', 'no', 'Грубых нарушений не найдено.', { range: { from_turn: 3, to_turn: 9 } }),
    ],
  },
  {
    conversation_id: 'A-1036',
    checklist: 'chat',
    invalid_attempt: 'c04: значение 12 не входит в ступени шкалы',
    review_status: 'flagged',
    review_reasons: ['Критерий не оценён: ответ модели не прошёл проверку.'],
    results: [
      assessed('c01', 'yes', 'Оператор поздоровался и представился.', { evidence: [ev(2, 'Меня зовут Ержан.')] }),
      assessed('c02', 'yes', 'Оператор уточнил версию приложения.', { evidence: [ev(2, 'Какая у вас версия приложения?')] }),
      na('c03', 'Выполнено условие N/A: защищённых действий не было.'),
      { ...assessed('c04', null, 'Ответ модели не прошёл проверку после всех попыток. Значение не выдумывается и не заменяется нулём.'), status: 'failed' },
      assessed('c05', 'yes', 'Оператор вежлив и занялся проблемой клиента.', { evidence: [ev(4, 'кнопка должна стать активной')] }),
      assessed('c06', 10, 'Ответы ясные.', { evidence: [ev(4, 'Попробуйте выйти из приложения')] }),
      assessed('c07', 'no', 'Оператор попрощался, но не подвёл итог и не предложил помощь.', { range: { from_turn: 5, to_turn: 6 }, expected: 6, evidence: [ev(6, 'Хорошего дня.')] }),
      assessed('c08', 'no', 'Грубых нарушений не найдено.', { range: { from_turn: 2, to_turn: 6 } }),
    ],
  },
  {
    conversation_id: 'A-1038',
    checklist: 'voice',
    results: [
      assessed('c01', 'yes', 'Оператор поздоровался и назвал имя, плейсхолдер считается произнесённым именем.', { evidence: [ev(4, 'меня зовут [Имя скрыто]')] }),
      na('c02', 'Выполнено условие N/A: клиент сразу назвал запрос.'),
      assessed('c03', 'yes', 'Устная проверка данных прошла до раскрытия статуса заявки.', { evidence: [ev(6, 'Назовите, пожалуйста, данные для идентификации.'), ev(8, 'данные совпали')] }),
      assessed('c04', 15, 'Статус назван, но срок поступления распознан с шумом, поэтому возможна неполнота.', { evidence: [ev(8, 'средства поступят завтра')] }),
      assessed('c05', 'yes', 'Оператор вежлив.', { evidence: [ev(8, 'Спасибо')] }),
      assessed('c06', 10, 'Разговор логичен, пауз нет.', { evidence: [ev(10, 'Могу ещё чем-то помочь?')] }),
      assessed('c07', 'yes', 'Оператор предложил помощь и попрощался.', { evidence: [ev(10, 'всего доброго!')] }),
      assessed('c08', 'no', 'Грубых нарушений не найдено.', { range: { from_turn: 4, to_turn: 10 } }),
    ],
  },
];

/** Conversations evaluated by the stub provider at seed time. */
export const seedStubConversations = ['A-1033'];
/** Conversations whose evaluation always fails, to show that a failure is not a zero. */
export const failingConversations = ['A-1037'];
/** Calls the evaluator refuses to send out, as with the free cloud API. */
export const blockedConversations = ['A-1030'];

export const seedOpenAppeals = [
  {
    conversation_id: 'A-1039',
    criterion_id: 'c04',
    comment: 'Оператор дал понять, что повторять вывод не придётся. Считаю, что вопрос закрыт почти полностью.',
  },
  {
    conversation_id: 'A-1042',
    criterion_id: 'c07',
    comment: 'Клиент сам сказал, что нашёл ответ, итог подводить было незачем.',
  },
];
