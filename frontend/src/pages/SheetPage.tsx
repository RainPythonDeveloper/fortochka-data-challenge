import { Plus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { ChecklistVersion, Criterion, CriterionType } from '../api/types';
import { Badge, Button, EmptyState, ErrorState, LoadingState, Panel, Swap, Tag, Toggle } from '../components/ui';
import { normalizeChecklist, validateChecklist } from '../lib/checklistValidation';
import { answerKindLabel, channelsLabel, errorText, fmtNumber } from '../lib/format';
import { CHANNELS } from '../lib/labels';
import { useCountUp } from '../lib/motion';
import { useAsync } from '../lib/useAsync';

const NOTES_SOON = 'Скоро: нужно отключение уточнений в ai';

function nextId(taken: string[], prefix: string, width: number): string {
  let number = taken.length + 1;
  const make = () => `${prefix}${String(number).padStart(width, '0')}`;
  while (taken.includes(make())) number += 1;
  return make();
}

const blankSheet = (taken: string[]): ChecklistVersion => ({
  checklist_id: nextId(taken, 'sheet-', 1),
  version: 1,
  title: '',
  channels: ['agent chat'],
  excluded_from_scoring: [],
  sections: [{ id: 's1', title: 'Основная секция' }],
  criteria: [],
});

function copyOf(source: ChecklistVersion, taken: string[]): ChecklistVersion {
  let id = `${source.checklist_id}-copy`;
  for (let number = 2; taken.includes(id); number += 1) id = `${source.checklist_id}-copy-${number}`;
  return { ...structuredClone(source), checklist_id: id, version: 1, title: `${source.title} (копия)` };
}

const canon = (sheet: ChecklistVersion) => JSON.stringify(normalizeChecklist({ ...sheet, version: 0 }));
const withoutWeights = (sheet: ChecklistVersion) =>
  canon({ ...sheet, criteria: sheet.criteria.map((item) => ({ ...item, weight: 0 })) });

/** Repeats checklist_hash in cqa_ai: weights are not part of the meaning. */
function changeKind(draft: ChecklistVersion, base: ChecklistVersion): 'none' | 'weights' | 'meaning' {
  if (canon(draft) === canon(base)) return 'none';
  return withoutWeights(draft) === withoutWeights(base) ? 'weights' : 'meaning';
}

function sameCriterion(sheet: ChecklistVersion, a: Criterion | undefined, b: Criterion) {
  return Boolean(a) && canon({ ...sheet, criteria: [a as Criterion] }) === canon({ ...sheet, criteria: [b] });
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (text: string) => void }) {
  return (
    <label className="tfield">
      <span className="tfield__label">{label}</span>
      <textarea rows={1} className="tfield__body" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

type NotesProps = { criterion: Criterion; saved: Criterion | undefined; onChange: (patch: Partial<Criterion>) => void };

function Notes({ criterion, saved, onChange }: NotesProps) {
  const canSwitch = criterion.disabled_notes !== undefined;
  const off = criterion.disabled_notes ?? [];
  const known = [...(saved?.team_notes ?? []), ...(saved?.disabled_notes ?? [])];
  // Saved notes keep their place when switched, so a toggle never reorders the list.
  const ordered = [...known, ...[...criterion.team_notes, ...off].filter((note) => !known.includes(note))];

  const setOn = (note: string, on: boolean) =>
    onChange({
      team_notes: on ? [...criterion.team_notes, note] : criterion.team_notes.filter((item) => item !== note),
      disabled_notes: on ? off.filter((item) => item !== note) : [...off, note],
    });
  const fresh = criterion.team_notes.map((note, position) => ({ note, position })).filter(({ note }) => !known.includes(note));

  return (
    <div>
      <span className="tfield__label">Уточнения для модели</span>
      {ordered.filter((note) => known.includes(note)).map((note) => {
        const on = !off.includes(note);
        return (
          <div key={note} className="note" data-off={!on || undefined}>
            <Toggle on={on} label={note} disabled={!canSwitch} title={canSwitch ? undefined : NOTES_SOON} onChange={(value) => setOn(note, value)} />
            <span>{note}</span>
          </div>
        );
      })}
      {fresh.map(({ note, position }) => (
        <div key={position} className="note">
          <Toggle on label="Новое уточнение" disabled />
          <input
            autoFocus={!note}
            aria-label="Текст уточнения"
            value={note}
            onChange={(event) =>
              onChange({ team_notes: criterion.team_notes.map((item, index) => (index === position ? event.target.value : item)) })
            }
          />
          <button
            type="button"
            className="icon-btn"
            aria-label="Убрать уточнение"
            onClick={() => onChange({ team_notes: criterion.team_notes.filter((_, index) => index !== position) })}
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
      ))}
      <div className="mt-2">
        <Button variant="text" onClick={() => onChange({ team_notes: [...criterion.team_notes, ''] })}>
          <Plus size={16} strokeWidth={1.75} /> Уточнение
        </Button>
      </div>
    </div>
  );
}

type EditorProps = {
  criterion: Criterion;
  saved: Criterion | undefined;
  sections: ChecklistVersion['sections'];
  onChange: (patch: Partial<Criterion>) => void;
  onDelete: () => void;
};

function CriterionEditor({ criterion, saved, sections, onChange, onDelete }: EditorProps) {
  const setType = (type: CriterionType) =>
    onChange(
      type === 'scale'
        ? { type, yes_when: null, levels: criterion.levels.length ? criterion.levels : [{ value: 10, text: '' }, { value: 0, text: '' }] }
        : { type, prompt: null, levels: [] },
    );
  const setLevel = (position: number, patch: Partial<Criterion['levels'][number]>) =>
    onChange({ levels: criterion.levels.map((level, index) => (index === position ? { ...level, ...patch } : level)) });
  const isFlag = Boolean(criterion.flag);

  return (
    <>
      <div className="props">
        <div className="prop">
          <span className="prop__k">Название</span>
          <span className="prop__v">
            <input aria-label="Название критерия" className="prop__input" value={criterion.title} onChange={(event) => onChange({ title: event.target.value })} />
          </span>
        </div>
        <div className="prop">
          <span className="prop__k">Секция</span>
          <span className="prop__v">
            <select aria-label="Секция" className="prop__input" value={criterion.section} onChange={(event) => onChange({ section: event.target.value })}>
              {sections.map((section) => <option key={section.id} value={section.id}>{section.title || 'Новая секция'}</option>)}
            </select>
          </span>
        </div>
        <div className="prop">
          <span className="prop__k">Тип ответа</span>
          <span className="prop__v">
            <span className="seg">
              <button type="button" aria-pressed={criterion.type === 'boolean'} onClick={() => setType('boolean')}>Да / Нет</button>
              <button type="button" aria-pressed={criterion.type === 'scale'} onClick={() => setType('scale')}>Шкала</button>
            </span>
          </span>
        </div>
        <div className="prop">
          <span className="prop__k">Вес</span>
          <span className="prop__v">
            <input
              aria-label="Вес"
              type="number"
              min={0}
              step="any"
              disabled={!criterion.scored}
              className="prop__input"
              value={Number.isNaN(criterion.weight) ? '' : criterion.weight}
              onChange={(event) => onChange({ weight: event.target.valueAsNumber })}
            />
            <span className="font-normal text-text">из 100</span>
          </span>
        </div>
        <div className="prop">
          <span className="prop__k">Влияет на баллы</span>
          <span className="prop__v">
            <Toggle on={criterion.scored} label="Влияет на баллы" disabled={isFlag} onChange={(scored) => onChange({ scored, weight: scored ? criterion.weight : 0 })} />
          </span>
        </div>
        <div className="prop">
          <span className="prop__k">Флаг нарушения</span>
          <span className="prop__v">
            <Toggle
              on={isFlag}
              label="Флаг грубого нарушения"
              onChange={(on) => onChange(on ? { flag: 'gross_error', scored: false, weight: 0 } : { flag: null })}
            />
          </span>
        </div>
        <div className="prop">
          <span className="prop__k">Не применимо</span>
          <span className="prop__v">
            <Toggle
              on={criterion.allow_na}
              label="Допускается «не применимо»"
              onChange={(on) => onChange({ allow_na: on, na_when: on ? criterion.na_when : null })}
            />
          </span>
        </div>
      </div>

      {criterion.type === 'boolean' ? (
        <TextField label="Когда «Да»" value={criterion.yes_when ?? ''} onChange={(yes_when) => onChange({ yes_when })} />
      ) : (
        <TextField label="Задача шкалы" value={criterion.prompt ?? ''} onChange={(prompt) => onChange({ prompt })} />
      )}
      {criterion.allow_na && (
        <TextField label="Когда не применимо" value={criterion.na_when ?? ''} onChange={(na_when) => onChange({ na_when })} />
      )}
      {criterion.type === 'scale' && (
        <div className="tfield">
          <span className="tfield__label">Ступени шкалы</span>
          {criterion.levels.map((level, position) => (
            <div key={position} className="level">
              <input
                aria-label="Значение ступени"
                type="number"
                step={1}
                className="tfield__body"
                value={Number.isNaN(level.value) ? '' : level.value}
                onChange={(event) => setLevel(position, { value: event.target.valueAsNumber })}
              />
              <input aria-label="Описание ступени" className="tfield__body" value={level.text} onChange={(event) => setLevel(position, { text: event.target.value })} />
              <button
                type="button"
                className="icon-btn"
                aria-label="Удалить ступень"
                onClick={() => onChange({ levels: criterion.levels.filter((_, index) => index !== position) })}
              >
                <X size={16} strokeWidth={1.75} />
              </button>
            </div>
          ))}
          <div className="mt-1">
            <Button variant="text" onClick={() => onChange({ levels: [...criterion.levels, { value: 0, text: '' }] })}>
              <Plus size={16} strokeWidth={1.75} /> Ступень
            </Button>
          </div>
        </div>
      )}
      <Notes criterion={criterion} saved={saved} onChange={onChange} />
      <div className="mt-6">
        <Button variant="text" onClick={onDelete}>Удалить критерий</Button>
      </div>
    </>
  );
}

type SheetEditorProps = {
  base: ChecklistVersion;
  /** Null for a sheet that does not exist yet: saving then creates it as version 1. */
  latestVersion: number | null;
  sheets: { id: string; label: string }[];
  takenIds: string[];
  onPick: (id: string) => void;
  onStartNew: (sheet: ChecklistVersion) => void;
  onCancelNew: () => void;
  onSaved: (saved: ChecklistVersion, previous: number) => void;
  savedNotice: string | null;
};

function SheetEditor({ base, latestVersion, sheets, takenIds, onPick, onStartNew, onCancelNew, onSaved, savedNotice }: SheetEditorProps) {
  const isNew = latestVersion === null;
  const [draft, setDraft] = useState(base);
  const [selected, setSelected] = useState<string | null>(base.criteria[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const issues = useMemo(() => validateChecklist(draft), [draft]);
  const change = isNew ? 'meaning' : changeKind(draft, base);
  const weightSum = draft.criteria.reduce((sum, item) => sum + (item.scored && Number.isFinite(item.weight) ? item.weight : 0), 0);
  const nextVersion = isNew ? 1 : latestVersion + 1;
  const criterion = draft.criteria.find((item) => item.id === selected);
  const shownVersion = useCountUp(base.version, { duration: 400 });

  // A saved version comes back as the new base: the draft starts over from it.
  useEffect(() => {
    setDraft(base);
    setBusy(false);
  }, [base]);

  const patch = (id: string, fields: Partial<Criterion>) =>
    setDraft((current) => ({ ...current, criteria: current.criteria.map((item) => (item.id === id ? { ...item, ...fields } : item)) }));

  const addCriterion = (sectionId: string) => {
    const id = nextId(draft.criteria.map((item) => item.id), 'c', 2);
    const added: Criterion = {
      id, section: sectionId, title: '', type: 'boolean', weight: 0, scored: true, flag: null,
      allow_na: false, yes_when: '', prompt: null, na_when: null, levels: [], team_notes: [],
      ...(draft.criteria.some((item) => item.disabled_notes !== undefined) || isNew ? { disabled_notes: [] } : {}),
    };
    setDraft((current) => ({ ...current, criteria: [...current.criteria, added] }));
    setSelected(id);
  };

  const addSection = () => {
    const id = nextId(draft.sections.map((item) => item.id), 's', 1);
    setDraft((current) => ({ ...current, sections: [...current.sections, { id, title: '' }] }));
  };

  const save = async () => {
    setBusy(true);
    setSaveError(null);
    try {
      const body = normalizeChecklist(draft);
      onSaved(await (isNew ? api.createChecklist(body) : api.createChecklistVersion(body)), base.version);
    } catch (reason) {
      setSaveError(errorText(reason, 'Версия не сохранена'));
      setBusy(false);
    }
  };

  const saveLabel = isNew ? 'Создать лист' : `Сохранить версию ${nextVersion}`;
  const firstIssue = issues[0]?.message ?? saveError;
  const status =
    change === 'none' && savedNotice
      ? { id: 'saved', tone: 'good', text: savedNotice, action: false }
      : change === 'none'
        ? { id: 'clean', tone: 'quiet', text: `Сумма весов ${fmtNumber(weightSum)} · изменений нет`, action: false }
        : firstIssue
          ? { id: 'error', tone: 'bad', text: firstIssue, action: true }
          : change === 'weights'
            ? { id: 'weights', tone: 'quiet', text: 'Изменены только веса: итоги пересчитаются без модели', action: true }
            : { id: 'meaning', tone: 'warn', text: isNew ? 'Новый лист' : 'Смысл изменён: диалоги будут оценены заново', action: true };

  return (
    <>
      <Panel className="shead">
        <h1 className="title">Оценочный лист</h1>
        {draft.channels.map((channel) => <Tag key={channel}>{channelsLabel(channel)}</Tag>)}
        <Tag>Версия {Math.round(shownVersion ?? base.version)}</Tag>
        {isNew ? (
          <>
            <input
              autoFocus
              aria-label="Название листа"
              placeholder="Название листа"
              className="field !ml-2 !w-56"
              value={draft.title}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            />
            <span className="seg">
              {Object.keys(CHANNELS).map((channel) => (
                <button
                  key={channel}
                  type="button"
                  aria-pressed={draft.channels.includes(channel)}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      channels: draft.channels.includes(channel) ? draft.channels.filter((item) => item !== channel) : [...draft.channels, channel],
                    })
                  }
                >
                  {channelsLabel(channel)}
                </button>
              ))}
            </span>
            <Button variant="text" className="ml-2" onClick={onCancelNew}>Отмена</Button>
          </>
        ) : (
          <>
            {sheets.length > 1 && (
              <select aria-label="Оценочный лист" className="shead__pick" value={draft.checklist_id} onChange={(event) => onPick(event.target.value)}>
                {sheets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            )}
            <Button variant="text" className="ml-2" onClick={() => onStartNew(blankSheet(takenIds))}>Новый лист</Button>
            <Button variant="text" className="ml-2" onClick={() => onStartNew(copyOf(base, takenIds))}>Копия этого листа</Button>
          </>
        )}
        <div className="shead__end">
          <Swap id={status.id} align="end">
            <span className="shead__status" data-tone={status.tone} role="status">
              {status.text}
              {status.action && (
                <Button variant="primary" size="large" disabled={busy || issues.length > 0} onClick={save}>{saveLabel}</Button>
              )}
            </span>
          </Swap>
        </div>
      </Panel>

      <div className="sheet-cols">
        <Panel className="scroll-panel">
          <div className="panel-label">Критерии и веса</div>
          <div className="scroll-panel__body">
            <p className="sum-line" data-warn={weightSum !== 100 || undefined}>
              {weightSum === 100 ? 'Сумма весов 100' : `Сумма весов ${fmtNumber(weightSum)}, итог всё равно пересчитается к 100`}
            </p>
            {draft.sections.map((section) => {
              const members = draft.criteria.filter((item) => item.section === section.id);
              return (
                <div key={section.id}>
                  <div className="ssection">
                    <input
                      aria-label="Название секции"
                      placeholder="Название секции"
                      className="ssection__input"
                      value={section.title}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          sections: draft.sections.map((item) => (item.id === section.id ? { ...item, title: event.target.value } : item)),
                        })
                      }
                    />
                    {!members.length && draft.sections.length > 1 && (
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label="Удалить секцию"
                        onClick={() => setDraft({ ...draft, sections: draft.sections.filter((item) => item.id !== section.id) })}
                      >
                        <X size={16} strokeWidth={1.75} />
                      </button>
                    )}
                  </div>
                  {members.map((item) => (
                    <button key={item.id} type="button" className="srow" aria-current={selected === item.id} onClick={() => setSelected(item.id)}>
                      <span className="srow__main">
                        <span className="srow__title" title={item.title}>{item.title || 'Новый критерий'}</span>
                        <span className="srow__kind">{answerKindLabel(item)}</span>
                      </span>
                      <span className="srow__changed">
                        {!sameCriterion(base, base.criteria.find((other) => other.id === item.id), item) && <Badge tone="warn">изменён</Badge>}
                      </span>
                      <span className="srow__weight">{item.flag || !item.scored ? '—' : fmtNumber(item.weight)}</span>
                    </button>
                  ))}
                </div>
              );
            })}
            <div className="sadd mt-3">
              <Button
                variant="text"
                onClick={() => addCriterion(criterion?.section ?? draft.sections[draft.sections.length - 1].id)}
              >
                <Plus size={16} strokeWidth={1.75} /> Критерий
              </Button>
              <Button variant="text" onClick={addSection}>
                <Plus size={16} strokeWidth={1.75} /> Секция
              </Button>
            </div>
            {draft.excluded_from_scoring.length > 0 && (
              <p className="why__small mt-3">Вне оценки: {draft.excluded_from_scoring.join(', ')}</p>
            )}
          </div>
        </Panel>

        <Panel className="scroll-panel">
          <div className="panel-label">Критерий</div>
          <div className="scroll-panel__body">
            {criterion ? (
              <CriterionEditor
                key={criterion.id}
                criterion={criterion}
                saved={base.criteria.find((item) => item.id === criterion.id)}
                sections={draft.sections}
                onChange={(fields) => patch(criterion.id, fields)}
                onDelete={() => {
                  setDraft((current) => ({ ...current, criteria: current.criteria.filter((item) => item.id !== criterion.id) }));
                  setSelected(null);
                }}
              />
            ) : (
              <EmptyState title="Выберите критерий слева" />
            )}
          </div>
        </Panel>
      </div>
    </>
  );
}

export function SheetPage() {
  const list = useAsync(() => api.listChecklists(), []);
  const [picked, setPicked] = useState<string | null>(null);
  const [draftNew, setDraftNew] = useState<{ base: ChecklistVersion; nonce: number } | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [bump, setBump] = useState(0);

  useEffect(() => {
    const first = list.data?.[0];
    if (!picked && first) setPicked(first.checklist_id);
  }, [list.data, picked]);

  const version = useAsync(() => (picked ? api.getChecklist(picked) : Promise.resolve(null)), [picked, bump]);
  const summary = list.data?.find((item) => item.checklist_id === picked);
  const takenIds = useMemo(() => (list.data ?? []).map((item) => item.checklist_id), [list.data]);
  const sheets = useMemo(
    () =>
      (list.data ?? []).map((item) => ({
        id: item.checklist_id,
        label: [item.channels.map(channelsLabel).join(', '), item.title].filter(Boolean).join(' · '),
      })),
    [list.data],
  );

  const onSaved = (saved: ChecklistVersion, previous: number) => {
    setSavedNotice(
      draftNew
        ? `Лист создан: версия ${saved.version}.`
        : `Версия ${saved.version} сохранена. Прошлые оценки остались на версии ${previous}.`,
    );
    setDraftNew(null);
    setPicked(saved.checklist_id);
    setBump((value) => value + 1);
    list.reload();
  };

  if (list.error) return <Panel><ErrorState message={list.error} onRetry={list.reload} /></Panel>;
  if (version.error) return <Panel><ErrorState message={version.error} onRetry={version.reload} /></Panel>;

  const common = {
    sheets,
    takenIds,
    savedNotice,
    onSaved,
    onPick: (id: string) => {
      setSavedNotice(null);
      setPicked(id);
    },
    onStartNew: (base: ChecklistVersion) => {
      setSavedNotice(null);
      setDraftNew((current) => ({ base, nonce: (current?.nonce ?? 0) + 1 }));
    },
    onCancelNew: () => setDraftNew(null),
  };

  if (draftNew) return <SheetEditor key={`new:${draftNew.nonce}`} base={draftNew.base} latestVersion={null} {...common} />;
  if (!version.data || !summary) return <Panel><LoadingState label="Загружаем оценочный лист…" /></Panel>;
  // Keyed by the sheet only, so a saved version updates in place and its tag can count.
  return <SheetEditor key={version.data.checklist_id} base={version.data} latestVersion={summary.latest_version} {...common} />;
}
