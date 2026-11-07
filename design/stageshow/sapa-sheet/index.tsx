import { Badge, Button, Roll, Stage, States, Toggle, Window, type Act } from '../../kit'
import { SapaLead } from '../sapa-review/shell'
import '../sapa-review/sapa.css'
import './sheet.css'

// Sapa's assessment sheet (the checklist), with "Завершение" open. Beats: the
// reviewer turns off the team's note that reads a bare goodbye as "Нет"; the
// note dims, the criterion is marked as changed, and the head says what that
// means (the meaning changed, so dialogues are evaluated again by the model)
// beside a save button; the save lands as version 2. Plays once; the still is
// the saved sheet.
//
// Real strings: the bar, the title and its tags, the criteria and weights,
// the open criterion's fields and its two notes, the status and the save.

type S = { off: boolean; saved: boolean }
const initial: S = { off: false, saved: false }
const poster: S = { off: true, saved: true }

const CRITERIA = [
  { title: 'Установление контакта', kind: 'Да / Нет', weight: '10' },
  { title: 'Выявление потребности', kind: 'Да / Нет / не применимо', weight: '15' },
  { title: 'Идентификация клиента', kind: 'Да / Нет / не применимо', weight: '20' },
  { title: 'Корректная и полная консультация', kind: 'шкала 0–20', weight: '20' },
  { title: 'Эмпатия и внимание к клиенту', kind: 'Да / Нет', weight: '15' },
  { title: 'Ведение диалога', kind: 'шкала 0–10', weight: '15' },
  { title: 'Завершение', kind: 'Да / Нет / не применимо', weight: '5', open: true },
  { title: 'Грубые нарушения', kind: 'отметка, без баллов', weight: '—' },
]

async function script(a: Act<S>) {
  await a.wait(1000)
  a.mark('toggle')
  await a.move('note')
  await a.wait(180)
  await a.click('note')
  a.put({ off: true })
  await a.wait(1800)
  a.mark('save')
  await a.move('save')
  await a.wait(180)
  await a.click('save')
  a.put({ saved: true })
  await a.wait(2600)
}

export default function SapaSheet() {
  return (
    <Stage<S> width={1040} height={640} initial={initial} poster={poster} script={script} play="once" cursor={{ at: { x: 960, y: 600 } }} className="sp sps">
      {(s) => {
        const dirty = s.off && !s.saved
        return (
          <Window className="sp-win" lead={<SapaLead active="sheet" />} toolbar={<span className="sp-bar-end" />}>
            <div className="sp-app">
              <section className="sp-panel sps-head">
                <span className="sp-title">Оценочный лист</span>
                <span className="sp-tag">Чаты</span>
                <span className="sp-tag sps-version">Версия <Roll>{s.saved ? '2' : '1'}</Roll></span>
                <span className="sps-head__end" />
                <States
                  value={s.saved ? 'saved' : dirty ? 'dirty' : 'clean'}
                  align="end"
                  className="sps-status"
                  states={{
                    clean: <span className="sps-quiet">Сумма весов 100 · изменений нет</span>,
                    dirty: (
                      <span className="sps-dirty">
                        <span className="sps-dirty__text">Смысл изменён: диалоги будут оценены заново</span>
                        <Button variant="primary" size="large" className="sp-cta" data-target="save">Сохранить версию 2</Button>
                      </span>
                    ),
                    saved: <span className="sps-saved">Версия 2 сохранена. Прошлые оценки остались на версии 1.</span>,
                  }}
                />
              </section>

              <div className="sps-cols">
                <section className="sp-panel sps-list">
                  <div className="sp-label">Критерии и веса</div>
                  {CRITERIA.map((c) => (
                    <div key={c.title} className="sps-row" data-open={c.open || undefined}>
                      <span className="sps-row__main">
                        <span className="sps-row__title">{c.title}</span>
                        <span className="sps-row__kind">{c.kind}</span>
                      </span>
                      <span className="sps-changed" data-show={(c.open && s.off) || undefined}>
                        {c.open && <Badge tone="warning">изменён</Badge>}
                      </span>
                      <span className="sps-row__weight">{c.weight}</span>
                    </div>
                  ))}
                </section>

                <section className="sp-panel sps-edit">
                  <div className="sp-label">Критерий</div>
                  <div className="sps-props">
                    <div className="sps-prop"><span className="sps-prop__k">Название</span><span className="sps-prop__v">Завершение</span></div>
                    <div className="sps-prop"><span className="sps-prop__k">Тип ответа</span><span className="sps-prop__v">Да / Нет / не применимо</span></div>
                    <div className="sps-prop"><span className="sps-prop__k">Вес</span><span className="sps-prop__v">5 из 100</span></div>
                  </div>
                  <div className="sps-fields">
                    <div className="sps-text">
                      <span className="sps-text__label">Когда «Да»</span>
                      <span className="sps-text__body">Оператор подвёл итог или предложил дальнейшую помощь и попрощался.</span>
                    </div>
                    <div className="sps-text">
                      <span className="sps-text__label">Когда не применимо</span>
                      <span className="sps-text__body">Чат оборвался до возможности его завершить.</span>
                    </div>
                  </div>
                  <div className="sps-notes">
                    <span className="sps-text__label">Уточнения для модели</span>
                    <div className="sps-note" data-off={s.off || undefined}>
                      <Toggle on={!s.off} data-target="note" data-cursor="pointer" />
                      <span>Прощание без итога и без предложения помощи считать «Нет»</span>
                    </div>
                    <div className="sps-note">
                      <Toggle on />
                      <span>Обрыв связи или уход клиента: не применимо</span>
                    </div>
                  </div>
                </section>
              </div>
            </div>
          </Window>
        )
      }}
    </Stage>
  )
}
