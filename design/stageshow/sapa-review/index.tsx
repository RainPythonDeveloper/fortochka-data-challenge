import { Badge, Bar, Button, Collapse, Connector, Roll, Spinner, Stage, States, Window, type Act } from '../../kit'
import { SapaLead } from './shell'
import './sapa.css'

// Sapa, a conversation quality tool for Freedom Broker, on its review screen:
// the deep green product bar, then white panels on a light gray ground.
//
// Beats: the stages run in the head (reading, the model, checking quotes,
// the total), each with its own time; while the model works the criteria
// resolve top to bottom and each lights the turn it rests on; the total
// rolls in and its marker settles in its range band. The pointer opens
// "Завершение": its explanation opens and a line draws from the criterion to
// the turn it was judged on. The reviewer changes the answer to "Да": the
// total rolls a beat later and the marker crosses into the next band,
// keeping the model's original beside it. "Оценить заново" is the visible
// cause of the reset.
//
// Real strings: the bar, the title and its two tags, the stage names and
// times, the criteria, the turns the evidence lands on, the one explanation
// and the two decisions. The client's middle turns are filler.

type S = { stage: number; resolved: number; flash: number; open: boolean; changed: boolean }

const initial: S = { stage: 0, resolved: 0, flash: -1, open: false, changed: false }
const poster: S = { stage: 4, resolved: 8, flash: -1, open: true, changed: false }

type Answer = 'yes' | 'no' | 'na' | 'clean' | string
const CRITERIA: { id: string; title: string; answer: Answer; turn: number }[] = [
  { id: 'c01', title: 'Установление контакта', answer: 'yes', turn: 7 },
  { id: 'c02', title: 'Выявление потребности', answer: 'na', turn: 3 },
  { id: 'c03', title: 'Идентификация клиента', answer: 'na', turn: -1 },
  { id: 'c04', title: 'Корректная и полная консультация', answer: '15 из 20', turn: 8 },
  { id: 'c05', title: 'Эмпатия и внимание к клиенту', answer: 'yes', turn: 7 },
  { id: 'c06', title: 'Ведение диалога', answer: '7 из 10', turn: 10 },
  { id: 'c07', title: 'Завершение', answer: 'no', turn: 12 },
  { id: 'c08', title: 'Грубые нарушения', answer: 'clean', turn: -1 },
]

type Turn = { i: number; who: 'client' | 'op' | 'bot' | 'system'; text?: string; bar?: number }
const TURNS: Turn[] = [
  { i: 1, who: 'bot', bar: 168 },
  { i: 2, who: 'bot', bar: 120 },
  { i: 3, who: 'client', text: 'Где посмотреть мой тариф?' },
  { i: 5, who: 'client', bar: 96 },
  { i: 6, who: 'system', text: 'Чат передан оператору' },
  { i: 7, who: 'op', text: 'Здравствуйте! Меня зовут Алина.' },
  { i: 8, who: 'op', text: 'Тариф указан в кабинете под ФИО.' },
  { i: 9, who: 'client', bar: 132 },
  { i: 10, who: 'op', text: 'В приложении тоже в профиле.' },
  { i: 11, who: 'client', text: 'Нашла, спасибо' },
  { i: 12, who: 'op', text: 'Пожалуйста. Хорошего дня!' },
  { i: 13, who: 'system', text: 'Оператор закрыл чат' },
]

// The stages of one evaluation and the time each took on this dialogue
const STAGES = [
  { name: 'Разбор диалога', time: '0,2 с' },
  { name: 'Оценка моделью', time: '1 мин 4 с' },
  { name: 'Проверка цитат', time: '0,1 с' },
  { name: 'Расчёт итога', time: '0,01 с' },
]

// Score bands for the total, from 0 to 100
const BANDS = [
  { to: 60, name: 'низкий уровень' },
  { to: 80, name: 'средний уровень' },
  { to: 100, name: 'высокий уровень' },
]
const bandOf = (n: number) => BANDS.find((b) => n < b.to) ?? BANDS[2]!

function AnswerBadge({ answer, changed }: { answer: Answer; changed?: boolean }) {
  if (answer === 'no') {
    return (
      <States
        value={changed ? 'yes' : 'no'}
        align="end"
        states={{ no: <Badge tone="danger">Нет</Badge>, yes: <Badge tone="success">Да</Badge> }}
      />
    )
  }
  if (answer === 'yes') return <Badge tone="success">Да</Badge>
  if (answer === 'clean') return <Badge tone="success">Не выявлены</Badge>
  if (answer === 'na') return <Badge>Не применимо</Badge>
  return <Badge className="sp-scale">{answer}</Badge>
}

async function script(a: Act<S>) {
  await a.wait(600)
  a.mark('read')
  a.put({ stage: 1 })
  await a.wait(500)
  a.mark('model')
  for (let n = 1; n <= CRITERIA.length; n++) {
    a.put({ resolved: n, flash: CRITERIA[n - 1]!.turn })
    await a.wait(430)
  }
  a.put({ flash: -1, stage: 2 })
  await a.wait(450)
  a.put({ stage: 3 })
  await a.wait(350)
  a.mark('total')
  a.put({ stage: 4 })
  await a.wait(1700)
  a.mark('open')
  await a.move({ at: 'c07', x: 0.3, y: 0.5 })
  await a.wait(150)
  await a.click({ at: 'c07', x: 0.3, y: 0.5 })
  a.put({ open: true })
  await a.wait(2200)
  a.mark('decide')
  await a.move('change')
  await a.wait(150)
  await a.click('change')
  a.put({ changed: true })
  await a.wait(3000)
  a.mark('rerun')
  await a.move('rerun')
  await a.wait(150)
  await a.click('rerun')
  a.put({ ...initial })
  await a.move({ x: 980, y: 740 }, { duration: 700 })
}

function Scene({ s, rect }: { s: S; rect: (name: string) => { x: number; y: number; width: number; height: number } }) {
  const done = s.stage >= 4
  const value = s.changed ? 85.38 : 77.69
  const total = !done ? '—' : s.changed ? '85,38' : '77,69'
  const band = bandOf(value)
  const row = rect('c07')
  const turn = rect('t12')
  const linked = s.open && row.width > 0 && turn.width > 0
  return (
    <>
      <Window
        className="sp-win"
        lead={<SapaLead active="dialogs" />}
        toolbar={<span className="sp-bar-end" />}
      >
        <div className="sp-app">
          <section className="sp-panel sp-head">
            <div className="sp-head__main">
              <div className="sp-titleline">
                <span className="sp-title">Диалог A-1042</span>
                <span className="sp-tag">Чат</span>
                <span className="sp-tag">Русский</span>
                <span className="sp-titleline__end" />
                <Button variant="ghost" size="small" className="sp-rerun" data-target="rerun" data-show={done || undefined}>Оценить заново</Button>
              </div>
              <ol className="sp-stages">
                {STAGES.map((st, i) => {
                  const state = s.stage > i || done ? 'done' : s.stage === i ? 'run' : 'wait'
                  return (
                    <li key={st.name} className="sp-stage" data-state={state}>
                      <span className="sp-stage__mark">
                        <States
                          value={state}
                          states={{
                            wait: <span className="sp-stage__dot" />,
                            run: <Spinner size={14} />,
                            done: (
                              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                                <circle cx="7" cy="7" r="7" fill="currentColor" />
                                <path d="M4 7.2l2 2 4-4.4" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            ),
                          }}
                        />
                      </span>
                      <span className="sp-stage__name">{st.name}</span>
                      <span className="sp-stage__time">
                        <States
                          value={state}
                          align="start"
                          states={{
                            wait: <span />,
                            run: i === 1 ? <span className="sp-count"><Roll>{String(s.resolved)}</Roll> из 8 критериев</span> : <span>идёт</span>,
                            done: <span>{st.time}</span>,
                          }}
                        />
                      </span>
                    </li>
                  )
                })}
              </ol>
            </div>
            <div className="sp-score">
              <div className="sp-score__num"><Roll delay={s.changed ? 300 : 0}>{total}</Roll></div>
              <div className="sp-range" data-show={done || undefined}>
                <span className="sp-range__band" data-band="low" />
                <span className="sp-range__band" data-band="mid" />
                <span className="sp-range__band" data-band="high" />
                <span className="sp-range__mark" style={{ left: `${value}%` }} />
              </div>
              <div className="sp-score__sub">
                <States
                  value={!done ? 'none' : s.changed ? 'changed' : 'model'}
                  align="end"
                  states={{
                    none: <span>из 100</span>,
                    model: <span>{band.name} · из 100</span>,
                    changed: <span>{band.name} · исходная 77,69</span>,
                  }}
                />
              </div>
            </div>
          </section>

          <div className="sp-cols">
            <section className="sp-panel sp-chat">
              <div className="sp-label">Переписка</div>
              <div className="sp-turns">
                {TURNS.map((t) => {
                  const evidence = s.flash === t.i || (s.open && t.i === 12)
                  const range = s.open && t.i >= 11 && t.i <= 13
                  return (
                    <div key={t.i} className="sp-turn" data-who={t.who} data-range={range || undefined}>
                      <span className="sp-turn__n">#{t.i}</span>
                      {t.who === 'system' ? (
                        <span className="sp-turn__system">{t.text}</span>
                      ) : (
                        <span className="sp-bubble" data-evidence={evidence || undefined} data-target={t.i === 12 ? 't12' : undefined}>
                          {t.text ?? <Bar w={t.bar!} h={7} r={3.5} tone={2} />}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>

            <section className="sp-panel sp-list">
              <div className="sp-label">Оценка по критериям</div>
              {CRITERIA.map((c, i) => {
                const ready = i < s.resolved
                const isC07 = c.id === 'c07'
                return (
                  <div key={c.id} className="sp-crit" data-open={(isC07 && s.open) || undefined}>
                    <div className="sp-row" data-target={isC07 ? 'c07' : undefined} data-cursor={isC07 ? 'pointer' : undefined}>
                      <span className="sp-row__title">{c.title}</span>
                      <span className="sp-slot" data-ready={ready || undefined}>
                        <Bar w={44} h={22} r={11} tone={2} className="sp-sk" />
                        <span className="sp-real">
                          <AnswerBadge answer={c.answer} changed={isC07 && s.changed} />
                        </span>
                      </span>
                    </div>
                    {isC07 && (
                      <Collapse open={s.open}>
                        <div className="sp-why">
                          <p className="sp-why__text">Попрощался, но не подвёл итог и не предложил помощь.</p>
                          <div className="sp-why__ref">Основание: реплика #12, проверены #11–#13</div>
                          <States
                            value={s.changed ? 'done' : 'ask'}
                            align="start"
                            className="sp-why__actions"
                            states={{
                              ask: (
                                <span className="sp-actions">
                                  <Button variant="secondary" size="large">Подтвердить «Нет»</Button>
                                  <Button variant="primary" size="large" className="sp-cta" data-target="change">Изменить на «Да»</Button>
                                </span>
                              ),
                              done: <span className="sp-decided">Изменено проверяющим. Модель ответила «Нет».</span>,
                            }}
                          />
                        </div>
                      </Collapse>
                    )}
                  </div>
                )
              })}
            </section>
          </div>
        </div>
      </Window>

      {row.width > 0 && turn.width > 0 && (
        <Connector
          show={linked}
          route="curve"
          dots="both"
          className="sp-link"
          from={{ x: row.x - 4, y: row.y + row.height / 2 }}
          to={{ x: turn.x + turn.width + 6, y: turn.y + turn.height / 2 }}
        />
      )}
    </>
  )
}

export function SapaDemo() {
  return (
    <Stage<S>
      width={1040}
      height={780}
      initial={initial}
      poster={poster}
      script={script}
      cursor={{ at: { x: 980, y: 740 } }}
      className="sp"
    >
      {(s, rect) => <Scene s={s} rect={rect} />}
    </Stage>
  )
}

export default function SapaReview() {
  return <SapaDemo />
}
