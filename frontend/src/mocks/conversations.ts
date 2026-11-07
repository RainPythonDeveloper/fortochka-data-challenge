// Synthetic dialogues invented for the mock layer. No real transcript, name or
// audio_url is used here, and tariffs and amounts are made up.
import type { ConversationDetail, Turn } from '../api/types.ts';

type Line = [timestamp: string, speaker: string, text: string];

const turns = (lines: Line[]): Turn[] =>
  lines.map(([timestamp, speaker, text], index) => ({ index, timestamp, speaker, text }));

const conversation = (id: string, channel: string, language: string, lines: Line[], hasAudio = false): ConversationDetail => ({
  id,
  channel,
  language,
  turn_count: lines.length,
  has_audio: hasAudio,
  group_id: 'MOCK',
  latest_evaluation_id: null,
  latest_total: null,
  gross_error: false,
  turns: turns(lines),
});

const CHAT = 'agent chat';
const CALL = 'voice call';

export const seedConversations: ConversationDetail[] = [
  conversation('mock-ru-001', CHAT, 'RU', [
    ['00:00', 'client', 'Подскажите, какая комиссия за покупку акций на тарифе «Условный»?'],
    ['00:00', 'bot', 'Здравствуйте! Я виртуальный помощник. Подтвердите согласие на обработку данных.'],
    ['00:05', 'client', 'Согласен'],
    ['00:06', 'bot', 'Спасибо. Соединяю с оператором.'],
    ['00:06', 'system', 'Диалог передан оператору.'],
    ['00:41', 'operator', 'Здравствуйте! Меня зовут Алия. На тарифе «Условный» комиссия за сделку с акциями составляет 0,1% от суммы.'],
    ['00:58', 'client', 'Понял, а минимальная есть?'],
    ['01:12', 'operator', 'Минимальной комиссии на этом тарифе нет. Могу ещё чем-то помочь?'],
    ['01:20', 'client', 'Нет, спасибо.'],
    ['01:26', 'operator', 'Рада была помочь, хорошего дня!'],
    ['01:26', 'system', 'Оператор закрыл чат.'],
  ]),
  conversation('mock-ru-002', CHAT, 'RU', [
    ['00:00', 'client', 'Хочу понять, как начать инвестировать небольшую сумму.'],
    ['00:00', 'bot', 'Здравствуйте! Соединяю с оператором.'],
    ['00:02', 'system', 'Диалог передан оператору.'],
    ['00:20', 'operator', 'Добрый день! Меня зовут Тимур. Какую сумму и на какой срок вы рассматриваете?'],
    ['00:45', 'client', 'Примерно сто тысяч на год.'],
    ['01:05', 'operator', 'Для такого срока подойдёт условный базовый портфель из облигаций. Открыть его можно в приложении: Меню → Инвестировать.'],
    ['01:05', 'operator', 'Но если хотите доходность выше, переведите деньги мне лично на карту, я сам ими займусь за небольшой процент.'],
    ['01:30', 'client', 'Нет, через приложение спокойнее. Спасибо.'],
    ['01:44', 'operator', 'Хорошо, пишите, если появятся вопросы. Всего доброго!'],
    ['01:44', 'system', 'Оператор закрыл чат.'],
  ]),
  conversation('mock-kz-001', CHAT, 'KZ', [
    ['00:00', 'client', 'Сәлеметсіз бе, қосымшада шотты қалай толтыруға болады?'],
    ['00:00', 'bot', 'Сәлеметсіз бе! Мен виртуалды көмекшімін. Операторға қосып жатырмын.'],
    ['00:03', 'system', 'Диалог операторға берілді.'],
    ['00:37', 'operator', 'Сәлеметсіз бе! Шотты қай банк картасынан толтырасыз?'],
    ['00:52', 'client', 'Кез келген банк картасынан.'],
    ['01:10', 'operator', 'Қосымшада «Меню → Пополнить» бөлімін ашып, карта деректерін енгізіңіз.'],
    ['01:31', 'client', 'Рақмет, түсінікті.'],
    ['02:05', 'system', 'Оператор чатты жапты.'],
  ]),
  conversation('mock-en-001', CHAT, 'EN', [
    ['00:00', 'client', 'My withdrawal has been pending for two days. What is going on?'],
    ['00:00', 'bot', 'Hello! I am the virtual assistant. Connecting you to an operator.'],
    ['00:04', 'system', 'Chat transferred to an operator.'],
    ['00:31', 'operator', "Hi, I'm Dana. Sorry about the wait, I understand it is frustrating."],
    ['00:48', 'system', 'Client identity confirmed.'],
    ['01:02', 'operator', 'Your withdrawal is in processing on the bank side, it should arrive within one business day.'],
    ['01:20', 'client', 'And if it fails, when should I retry it?'],
    ['01:41', 'operator', 'Usually these go through without any issue.'],
    ['01:55', 'client', 'Okay, thanks.'],
    ['02:03', 'operator', 'Thanks for reaching out. Is there anything else I can help with? Have a good day!'],
    ['02:03', 'system', 'Chat closed by the operator.'],
  ]),
  conversation('mock-ru-003', CHAT, 'RU', [
    ['00:00', 'client', 'Где посмотреть отчёт по сделкам за прошлый месяц?'],
    ['00:02', 'system', 'Диалог передан оператору.'],
    ['00:25', 'operator', 'Здравствуйте! Меня зовут Мадина. Отчёт находится в разделе Меню → Документы.'],
    ['00:40', 'client', 'Нашёл, спасибо.'],
    ['00:49', 'operator', 'Пожалуйста, всего доброго!'],
  ]),
  conversation('mock-ru-004', CHAT, 'RU', [
    ['00:00', 'client', 'Не могу подтвердить заявку на смену тарифа, кнопка неактивна.'],
    ['00:03', 'system', 'Диалог передан оператору.'],
    ['00:30', 'operator', 'Здравствуйте! Меня зовут Ержан. Какая у вас версия приложения?'],
    ['00:50', 'client', 'Последняя, обновлял вчера.'],
    ['01:15', 'operator', 'Попробуйте выйти из приложения и зайти заново, после этого кнопка должна стать активной.'],
    ['01:44', 'client', 'Заработало, спасибо!'],
    ['01:52', 'operator', 'Отлично! Хорошего дня.'],
  ]),
  conversation('mock-en-002', CHAT, 'EN', [
    ['00:00', 'client', 'Can I change the email on my account?'],
    ['00:03', 'system', 'Chat transferred to an operator.'],
    ['00:29', 'operator', "Hello, I'm Aidar. Yes, go to Menu → Profile and tap Edit."],
    ['00:44', 'client', 'Done, thank you.'],
    ['00:51', 'operator', 'You are welcome, goodbye!'],
  ]),
  conversation('mock-kz-002', CHAT, 'KZ', [
    ['00:00', 'client', 'Тарифті қалай ауыстыруға болады?'],
    ['00:03', 'system', 'Диалог операторға берілді.'],
    ['00:26', 'operator', 'Сәлеметсіз бе! Менің атым Әсел. Қосымшада «Меню → Тариф» бөлімін ашыңыз.'],
    ['00:41', 'client', 'Рақмет!'],
    ['00:50', 'operator', 'Оқасы жоқ, сау болыңыз!'],
  ]),
  conversation(
    'mock-call-001',
    CALL,
    'RU',
    [
      ['2026-01-15T09:00:04.0000000+00:00', 'bot', 'Вас приветствует условная компания. Для продолжения нажмите два.'],
      ['2026-01-15T09:00:11.0000000+00:00', 'client', '2'],
      ['2026-01-15T09:00:13.0000000+00:00', 'system', 'Запись приостановлена, перевод на оператора.'],
      ['2026-01-15T09:01:02.0000000+00:00', 'system', 'Запись возобновлена.'],
      ['2026-01-15T09:01:03.0000000+00:00', 'operator', 'Добрый день, меня зовут [Имя скрыто], чем могу помочь?'],
      ['2026-01-15T09:01:12.0000000+00:00', 'client', 'Хочу узнать статус заявки на вывод средств.'],
      ['2026-01-15T09:01:20.0000000+00:00', 'operator', 'Назовите, пожалуйста, данные для идентификации.'],
      ['2026-01-15T09:01:31.0000000+00:00', 'client', '[Данные идентификации скрыты]'],
      ['2026-01-15T09:01:40.0000000+00:00', 'operator', 'Спасибо, данные совпали. Заявка исполняется, средства поступят завтра.'],
      ['2026-01-15T09:01:52.0000000+00:00', 'client', 'Хорошо, спасибо.'],
      ['2026-01-15T09:01:58.0000000+00:00', 'operator', 'Могу ещё чем-то помочь? Тогда всего доброго!'],
      ['2026-01-15T09:01:58.0000000+00:00', 'system', 'Звонок завершён.'],
    ],
    true,
  ),
  conversation('mock-web-001', 'web form', 'RU', [
    ['00:00', 'client', 'Оставляю заявку через условную форму на сайте.'],
    ['00:30', 'operator', 'Здравствуйте! Меня зовут Жанна. Заявку получила, спасибо.'],
  ]),
];

/** Only appear after an import, so the import button has a visible effect. */
export const importableConversations: ConversationDetail[] = [
  conversation('mock-ru-005', CHAT, 'RU', [
    ['00:00', 'client', 'Как скачать справку о состоянии счёта?'],
    ['00:02', 'system', 'Диалог передан оператору.'],
    ['00:24', 'operator', 'Здравствуйте! Меня зовут Камила. Справка есть в разделе Меню → Документы.'],
    ['00:38', 'client', 'Спасибо!'],
    ['00:45', 'operator', 'Всего доброго!'],
  ]),
  conversation('mock-en-003', CHAT, 'EN', [
    ['00:00', 'client', 'Where can I find my tax statement?'],
    ['00:02', 'system', 'Chat transferred to an operator.'],
    ['00:22', 'operator', "Hello, I'm Serik. It is under Menu → Documents."],
    ['00:35', 'client', 'Found it, thanks.'],
    ['00:42', 'operator', 'Glad to help, goodbye!'],
  ]),
];
