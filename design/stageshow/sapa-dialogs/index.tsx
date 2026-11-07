import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { Bar, Collapse, Meter, Roll, Spinner, Stage, States, Window, type Act, type Point } from '../../kit'
import { SapaLead } from '../sapa-review/shell'
import '../sapa-review/sapa.css'
import './dialogs.css'

// Sapa's dialogue list. A transcript file is carried in by the pointer from
// past the stage's left edge: the list lights up under it, and on the drop a new
// row opens at the top and runs the evaluation in place (reading, the model
// counting the criteria, the quote check), then settles as an ordinary row
// with its total. Plays once; the still is the evaluated row.
//
// Real strings: the bar, the title and its three figures, the column heads,
// three dialogues and the new one. Older rows are placeholder lines.

type Ghost = { on: boolean; dropped: boolean; off: Point; at: Point }
type S = { up: boolean; stage: number; n: number; ghost: Ghost }

const noGhost: Ghost = { on: false, dropped: false, off: { x: 0, y: 0 }, at: { x: 0, y: 0 } }
const initial: S = { up: false, stage: 0, n: 0, ghost: noGhost }
const poster: S = { up: true, stage: 4, n: 8, ghost: noGhost }

const ROWS = [
  { id: 'A-1042', tags: ['Чат', 'RU'], total: '77,69', note: 'Апелляция ждёт решения', tone: 'muted', when: '5 мин' },
  { id: 'A-1041', tags: ['Чат', 'KZ'], total: '92,31', note: '', tone: 'muted', when: '9 мин' },
  { id: 'A-1040', tags: ['Чат', 'EN'], total: '69,23', note: 'Грубое нарушение', tone: 'danger', when: '14 мин' },
]
const FILLER = [
  [64, 70, 40, 120],
  [58, 64, 44, 0],
  [66, 76, 40, 96],
  [60, 70, 42, 0],
]

async function script(a: Act<S>) {
  await a.wait(700)

  // 1-2. The file arrives from past the left edge, carried by the pointer,
  //      and the list lights up under it
  a.mark('drag')
  const off = { x: 52, y: 30 }
  const list = a.rect('drop')
  await a.drag({ x: list.x + list.width * 0.3, y: list.y + list.height * 0.32 }, (at) => {
    a.put({ ghost: { on: true, dropped: false, off, at } })
  }, { duration: 1500, cursor: 'preserve' })

  // 3. Drop: the new row opens at the top and runs the evaluation in place
  a.mark('drop')
  await a.set((s) => ({ up: true, stage: 1, ghost: { ...s.ghost, dropped: true } }))
  await a.wait(700)
  a.mark('model')
  await a.set({ stage: 2 })
  for (let n = 1; n <= 8; n++) {
    await a.set({ n })
    await a.wait(330)
  }
  await a.set({ stage: 3 })
  await a.wait(500)

  // 4. Evaluated: the total rolls in and the row settles
  a.mark('done')
  await a.set({ stage: 4 })
  await a.wait(2600)
}

export default function SapaDialogs() {
  return (
    <Stage<S>
      width={1040}
      height={640}
      initial={initial}
      poster={poster}
      script={script}
      play="once"
      cursor={{ at: { x: -90, y: 330 } }}
      className="sp spd"
    >
      {(s) => {
        return (
          <>
            <Window className="sp-win spd-win" lead={<SapaLead active="dialogs" />} toolbar={<span className="sp-bar-end" />}>
              <div className="sp-app">
                <section className="sp-panel spd-head">
                  <span className="sp-title">Диалоги</span>
                  <span className="spd-stat"><b>58</b> из 65 оценено</span>
                  <span className="spd-stat"><b>81,4</b> средний итог</span>
                  <span className="spd-stat"><b className="spd-red">7</b> грубых нарушений</span>
                </section>

                <section className="sp-panel spd-list" data-target="drop" data-drop>
                  <div className="spd-row spd-row--head">
                    <span>Диалог</span>
                    <span>Канал</span>
                    <span className="spd-num">Итог</span>
                    <span>Отметка</span>
                    <span>Когда</span>
                  </div>

                  <Collapse open={s.up} reveal="drop">
                    <NewRow s={s} />
                  </Collapse>

                  {ROWS.map((r) => (
                    <div key={r.id} className="spd-row">
                      <span className="spd-id">{r.id}</span>
                      <span className="spd-tags">{r.tags.map((t) => <span key={t} className="sp-tag">{t}</span>)}</span>
                      <span className="spd-num spd-total">{r.total}</span>
                      <span className="spd-note" data-tone={r.tone}>{r.note}</span>
                      <span className="spd-when">{r.when}</span>
                    </div>
                  ))}
                  {FILLER.map((f, i) => (
                    <div key={i} className="spd-row">
                      <Bar w={f[0]!} h={7} tone={3} />
                      <Bar w={f[1]!} h={7} tone={2} />
                      <span className="spd-num"><Bar w={f[2]!} h={7} tone={2} /></span>
                      {f[3] ? <Bar w={f[3]} h={7} tone={2} /> : <span />}
                      <Bar w={44} h={7} tone={2} />
                    </div>
                  ))}
                </section>
              </div>
            </Window>

            <DragImage ghost={s.ghost}>
              <JsonIcon bare />
            </DragImage>
          </>
        )
      }}
    </Stage>
  )
}

const STAGE_TEXT = ['', 'Разбор диалога', 'Оценка моделью', 'Проверка цитат']

function NewRow({ s }: { s: S }) {
  const done = s.stage >= 4
  const progress = s.stage <= 1 ? 0.06 : s.stage === 2 ? 0.1 + (s.n / 8) * 0.75 : s.stage === 3 ? 0.94 : 1
  // The last running step stays on screen while the row crossfades to done
  const step = s.stage <= 1 ? 'read' : s.stage === 2 ? 'model' : 'check'
  return (
    <div className="spd-row spd-new" data-done={done || undefined}>
      <span className="spd-id">A-1043</span>
      <span className="spd-tags"><span className="sp-tag">Чат</span><span className="sp-tag">RU</span></span>
      <span className="spd-num spd-total">
        <States
          value={done ? 'done' : 'run'}
          align="end"
          states={{
            run: <Meter className="spd-meter" value={progress} />,
            done: <Roll>{done ? '92,31' : ''}</Roll>,
          }}
        />
      </span>
      <span className="spd-note">
        <States
          value={done ? 'done' : 'run'}
          align="start"
          states={{
            run: (
              <span className="spd-stage">
                <Spinner size={14} />
                <States
                  value={step}
                  align="start"
                  states={{
                    read: <span>{STAGE_TEXT[1]}</span>,
                    model: (
                      <span className="spd-stage__model">
                        {STAGE_TEXT[2]}
                        <span className="spd-count"><Roll>{String(s.n)}</Roll> из 8</span>
                      </span>
                    ),
                    check: <span>{STAGE_TEXT[3]}</span>,
                  }}
                />
              </span>
            ),
            done: <span className="spd-ok">Оценено за 1 мин 5 с</span>,
          }}
        />
      </span>
      <span className="spd-when spd-now">только что</span>
    </div>
  )
}

/** A page with a folded corner and a green JSON band: the transcript file. */
function JsonIcon({ small, bare }: { small?: boolean; bare?: boolean }) {
  return (
    <span className="spd-json" data-small={small || undefined}>
      <span className="spd-json__band">{small || bare ? null : 'JSON'}</span>
    </span>
  )
}

/** The drag image follows the cursor on the drag's own frame callback, and
 *  lights whatever [data-drop] it is over (from the upload gold). */
function DragImage({ ghost, children }: { ghost: Ghost; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const over = useRef<HTMLElement | null>(null)
  const following = ghost.on && !ghost.dropped
  const { x: ox, y: oy } = ghost.off
  const { x, y } = ghost.at
  useLayoutEffect(() => {
    const root = ref.current?.closest<HTMLElement>('.ss-stage')
    let next: HTMLElement | null = null
    if (following && root) {
      const box = root.getBoundingClientRect()
      const scale = box.width / root.offsetWidth || 1
      const hit = document.elementFromPoint(box.left + x * scale, box.top + y * scale)?.closest<HTMLElement>('[data-drop]') ?? null
      if (hit && root.contains(hit)) next = hit
    }
    if (next !== over.current) {
      over.current?.removeAttribute('data-over')
      next?.setAttribute('data-over', '')
      over.current = next
    }
  }, [following, x, y])
  useLayoutEffect(() => () => over.current?.removeAttribute('data-over'), [])
  return (
    <div ref={ref} className="spd-drag" data-show={following || undefined} data-dropped={ghost.dropped || undefined} style={{ transform: `translate(${x - ox}px, ${y - oy}px)` }} aria-hidden>
      <div className="spd-drag__inner" style={{ transformOrigin: `${ox}px ${oy}px` }}>
        {children}
      </div>
    </div>
  )
}
