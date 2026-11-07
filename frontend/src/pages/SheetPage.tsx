import { Plus, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api } from '../api';
import type { ChecklistVersion, Criterion, CriterionType } from '../api/types';
import { Badge, Button, EmptyState, ErrorState, LoadingState, Panel, Swap, Tag, Toggle } from '../components/ui';
import { hasWeight, normalizeChecklist, validateChecklist, type IssueField, type ValidationIssue } from '../lib/checklistValidation';
import { answerKindLabel, channelsLabel, errorText, fmtNumber, fmtPoints, maxLevel, plural } from '../lib/format';
import { CHANNELS } from '../lib/labels';
import { reducedMotion, useCountUp } from '../lib/motion';
import { useAsync } from '../lib/useAsync';

const NOTES_SOON = 'Скоро: нужно отключение уточнений в ai';

const ICON = { size: 16, strokeWidth: 1.75 };
const NEW_WEIGHT = 5;

function uniqueTitle(base: string, taken: string[]): string {
  const names = new Set(taken.map((item) => item.trim().toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  let number = 2;
  while (names.has(`${base} ${number}`.toLowerCase())) number += 1;
  return `${base} ${number}`;
}

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
  criteria: [{
    id: 'c01', section: 's1', title: 'Новый критерий', type: 'boolean', weight: 100, scored: true, flag: null,
    allow_na: false, yes_when: '', prompt: null, na_when: null, levels: [], team_notes: [], disabled_notes: [],
  }],
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

type FieldProps = { label: string; field: IssueField; errors: ValidationIssue[]; value: string; onChange: (text: string) => void };

const errorOf = (errors: ValidationIssue[], field: IssueField) => errors.find((item) => item.field === field)?.hint;

function TextField({ label, field, errors, value, onChange }: FieldProps) {
  const error = errorOf(errors, field);
  return (
    <label className="ctl">
      <span className="ctl__label">{label}</span>
      <textarea
        rows={2}
        data-field={field}
        aria-invalid={Boolean(error)}
        className="field ctl__area"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

function SwitchRow({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="switch-row">
      <span>
        <span className="switch-row__title">{title}</span>
        <span className="ctl__hint">{hint}</span>
      </span>
      {children}
    </div>
  );
}

function Group({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="cfg">
      <div className="cfg__side">
        <h3 className="cfg__title">{title}</h3>
        <p className="ctl__hint">{hint}</p>
      </div>
      <div className="cfg__body">{children}</div>
    </section>
  );
}

/** What each answer brings, before weights of inapplicable criteria are redistributed. */
function PointsPreview({ criterion }: { criterion: Criterion }) {
  const weight = Number.isFinite(criterion.weight) ? criterion.weight : 0;
  const rows: [string, string][] = criterion.flag
    ? [['Да', 'Итог на экране равен 0, экспорт по чек-листу'], ['Нет', 'Итог не меняется']]
    : !criterion.scored
      ? [['Любой ответ', 'На итог не влияет']]
      : criterion.type === 'scale' && criterion.levels.some((level) => level.value > 0)
        ? [...criterion.levels]
            .sort((a, b) => b.value - a.value)
            .map((level): [string, string] => [
              `Ступень ${level.value}`,
              fmtPoints(Math.round(((weight * level.value) / maxLevel(criterion)) * 100) / 100),
            ])
        : [['Да', fmtPoints(weight)], ['Нет', fmtPoints(0)]];
  if (criterion.allow_na) rows.push(['Не применимо', 'Вес уходит остальным критериям']);
  return (
    <div className="preview">
      {rows.map(([answer, effect]) => (
        <div key={answer} className="preview__row">
          <span>{answer}</span>
          <b>{effect}</b>
        </div>
      ))}
    </div>
  );
}

const MEANING: (keyof Criterion)[] = ['title', 'type', 'allow_na', 'yes_when', 'prompt', 'na_when', 'levels', 'flag'];
const meaningOf = (criterion: Criterion) =>
  JSON.stringify(MEANING.map((key) => {
    const value = criterion[key];
    return typeof value === 'string' ? value.trim() : (value ?? null);
  }));

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
    <div className="notes">
      {saved && known.length > 0 && meaningOf(saved) !== meaningOf(criterion) && (
        <p className="why__flag">Смысл критерия изменён: стандартные уточнения перестанут применяться, ваши останутся.</p>
      )}
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
      <div className="mt-1">
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
  errors: ValidationIssue[];
  /** Why this criterion cannot go, or null when it can. */
  deleteBlock: string | null;
  fresh: boolean;
  version: number;
  onChange: (patch: Partial<Criterion>) => void;
  onDelete: () => void;
};

function CriterionEditor({ criterion, saved, sections, errors, deleteBlock, fresh, version, onChange, onDelete }: EditorProps) {
  const [confirming, setConfirming] = useState(false);
  const titleInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (fresh) titleInput.current?.select();
  }, [fresh]);

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
      <div className="cfg-head">
        <div className="min-w-0">
          <h2 className="cfg-head__title">{criterion.title || 'Новый критерий'}</h2>
          <p className="ctl__hint">{answerKindLabel(criterion)}{criterion.scored && !isFlag && ` · вес ${fmtNumber(criterion.weight)}`}</p>
        </div>
        {!confirming && (
          <Button variant="text" className="btn--danger" disabled={Boolean(deleteBlock)} title={deleteBlock ?? undefined} onClick={() => setConfirming(true)}>
            <Trash2 {...ICON} /> Удалить критерий
          </Button>
        )}
      </div>
      {deleteBlock && <p className="ctl__hint pb-3">{deleteBlock}</p>}
      {confirming && (
        <div className="confirm" role="alert">
          <span>Критерия не будет в новой версии листа. Прошлые оценки останутся на версии {version} и не изменятся.</span>
          <span className="confirm__actions">
            <Button variant="text" className="btn--danger" onClick={onDelete}>Да, удалить</Button>
            <Button variant="text" className="btn--quiet" onClick={() => setConfirming(false)}>Отмена</Button>
          </span>
        </div>
      )}

      <Group title="Основное" hint="Как критерий называется на экране разбора.">
        <label className="ctl">
          <span className="ctl__label">Название</span>
          <input
            ref={titleInput}
            aria-label="Название критерия"
            data-field="title"
            aria-invalid={Boolean(errorOf(errors, 'title'))}
            className="field"
            value={criterion.title}
            onChange={(event) => onChange({ title: event.target.value })}
          />
          {errorOf(errors, 'title') && <span className="field-error">{errorOf(errors, 'title')}</span>}
        </label>
        <label className="ctl">
          <span className="ctl__label">Секция</span>
          <select aria-label="Секция" className="field" value={criterion.section} onChange={(event) => onChange({ section: event.target.value })}>
            {sections.map((section) => <option key={section.id} value={section.id}>{section.title || 'Новая секция'}</option>)}
          </select>
        </label>
      </Group>

      <Group title="Ответ и баллы" hint="Что выбирает модель и сколько это стоит.">
        <div className="ctl">
          <span className="ctl__label">Тип ответа</span>
          <span className="seg self-start">
            <button type="button" aria-pressed={criterion.type === 'boolean'} onClick={() => setType('boolean')}>Да / Нет</button>
            <button
              type="button"
              aria-pressed={criterion.type === 'scale'}
              disabled={isFlag}
              title={isFlag ? 'Флаг нарушения работает только с ответом Да / Нет' : undefined}
              onClick={() => setType('scale')}
            >
              Шкала
            </button>
          </span>
        </div>
        <div className="ctl">
          <span className="ctl__label">Вес</span>
          <span className="weight">
            <input
              aria-label="Вес, ползунок"
              type="range"
              min={0}
              max={50}
              step={1}
              disabled={!criterion.scored}
              value={Number.isFinite(criterion.weight) ? criterion.weight : 0}
              style={{ '--fill': `${Math.min((Number.isFinite(criterion.weight) ? criterion.weight : 0) * 2, 100)}%` } as CSSProperties}
              onChange={(event) => onChange({ weight: event.target.valueAsNumber })}
            />
            <input
              aria-label="Вес"
              type="number"
              min={0}
              step="any"
              disabled={!criterion.scored}
              data-field="weight"
              aria-invalid={Boolean(errorOf(errors, 'weight'))}
              className="field"
              value={Number.isNaN(criterion.weight) ? '' : criterion.weight}
              onChange={(event) => onChange({ weight: event.target.valueAsNumber })}
            />
          </span>
          {errorOf(errors, 'weight') && <span className="field-error">{errorOf(errors, 'weight')}</span>}
        </div>
        <div className="switches">
          <SwitchRow title="Влияет на баллы" hint="Выключите, если критерий только отмечает факт.">
            <Toggle on={criterion.scored} label="Влияет на баллы" disabled={isFlag} onChange={(scored) => onChange({ scored, weight: scored ? criterion.weight || NEW_WEIGHT : 0 })} />
          </SwitchRow>
          <SwitchRow title="Флаг грубого нарушения" hint="Ответ «Да» значит нарушение и обнуляет итог на экране.">
            <Toggle
              on={isFlag}
              label="Флаг грубого нарушения"
              onChange={(on) =>
                onChange(
                  on
                    ? { flag: 'gross_error', scored: false, weight: 0, type: 'boolean', levels: [], prompt: null, yes_when: criterion.yes_when ?? '' }
                    : { flag: null },
                )
              }
            />
          </SwitchRow>
          <SwitchRow title="Допускается «не применимо»" hint="Вес такого критерия уходит остальным.">
            <Toggle
              on={criterion.allow_na}
              label="Допускается «не применимо»"
              onChange={(on) => onChange({ allow_na: on, na_when: on ? criterion.na_when : null })}
            />
          </SwitchRow>
        </div>
        <div className="ctl">
          <span className="ctl__label">Как считается</span>
          <PointsPreview criterion={criterion} />
        </div>
      </Group>

      <Group title="Условия" hint="Этот текст модель получает как правило оценки.">
        {criterion.type === 'boolean' ? (
          <TextField label="Когда «Да»" field="yes_when" errors={errors} value={criterion.yes_when ?? ''} onChange={(yes_when) => onChange({ yes_when })} />
        ) : (
          <TextField label="Задача шкалы" field="prompt" errors={errors} value={criterion.prompt ?? ''} onChange={(prompt) => onChange({ prompt })} />
        )}
        {criterion.allow_na && (
          <TextField label="Когда не применимо" field="na_when" errors={errors} value={criterion.na_when ?? ''} onChange={(na_when) => onChange({ na_when })} />
        )}
        {criterion.type === 'scale' && (
          <div className="ctl">
            <span className="ctl__label">Ступени шкалы</span>
            {criterion.levels.map((level, position) => (
              <div key={position} className="level">
                <input
                  aria-label="Значение ступени"
                  type="number"
                  step={1}
                  className="field"
                  value={Number.isNaN(level.value) ? '' : level.value}
                  onChange={(event) => setLevel(position, { value: event.target.valueAsNumber })}
                />
                <input aria-label="Описание ступени" data-field={position === 0 ? 'levels' : undefined} className="field" value={level.text} onChange={(event) => setLevel(position, { text: event.target.value })} />
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
            {errorOf(errors, 'levels') && <span className="field-error">{errorOf(errors, 'levels')}</span>}
            <div>
              <Button variant="text" onClick={() => onChange({ levels: [...criterion.levels, { value: 0, text: '' }] })}>
                <Plus size={16} strokeWidth={1.75} /> Ступень
              </Button>
            </div>
          </div>
        )}
      </Group>

      <Group title="Уточнения для модели" hint="Разъяснения команды к правилу. Выключенные в промпт не попадают.">
        <Notes criterion={criterion} saved={saved} onChange={onChange} />
      </Group>
    </>
  );
}

type SectionHeadProps = {
  section: ChecklistVersion['sections'][number];
  others: ChecklistVersion['sections'];
  count: number;
  error: string | undefined;
  /** Why the section cannot be deleted at all, or null. */
  blocked: string | null;
  /** Why it cannot be deleted together with its criteria, or null. */
  keepBlock: string | null;
  onRename: (title: string) => void;
  onRemove: (moveTo: string | null) => void;
};

function SectionHead({ section, others, count, error, blocked, keepBlock, onRename, onRemove }: SectionHeadProps) {
  const [confirming, setConfirming] = useState(false);
  const [target, setTarget] = useState(others[0]?.id ?? '');
  const moveTo = others.some((item) => item.id === target) ? target : (others[0]?.id ?? '');
  return (
    <>
      <div className="ssection">
        <input
          aria-label="Название секции"
          placeholder="Название секции"
          data-section={section.id}
          aria-invalid={Boolean(error)}
          className="ssection__input"
          value={section.title}
          onChange={(event) => onRename(event.target.value)}
        />
        <button
          type="button"
          className="icon-btn"
          aria-label={`Удалить секцию ${section.title}`}
          disabled={Boolean(blocked)}
          title={blocked ?? 'Удалить секцию'}
          onClick={() => (count ? setConfirming(true) : onRemove(null))}
        >
          <Trash2 {...ICON} />
        </button>
      </div>
      {error && <p className="field-error pb-1">{error}</p>}
      {confirming && (
        <div className="confirm" role="alert">
          <span>В секции {count} {plural(count, 'критерий', 'критерия', 'критериев')}. Перенесите в другую секцию или удалите вместе с ней.</span>
          <select aria-label="Перенести критерии в секцию" className="field" value={moveTo} onChange={(event) => setTarget(event.target.value)}>
            {others.map((item) => <option key={item.id} value={item.id}>{item.title || 'Новая секция'}</option>)}
          </select>
          <span className="confirm__actions">
            <Button variant="text" onClick={() => onRemove(moveTo)}>Перенести и удалить секцию</Button>
            <Button variant="text" className="btn--danger" disabled={Boolean(keepBlock)} title={keepBlock ?? undefined} onClick={() => onRemove(null)}>
              Удалить вместе с критериями
            </Button>
            <Button variant="text" className="btn--quiet" onClick={() => setConfirming(false)}>Отмена</Button>
          </span>
        </div>
      )}
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
  const [freshId, setFreshId] = useState<string | null>(null);

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

  const takenCriteria = () => [...base.criteria, ...draft.criteria].map((item) => item.id);

  const addCriterion = (sectionId: string) => {
    // A deleted id is not reused: an id must not start to mean something else between versions.
    const id = nextId(takenCriteria(), 'c', 2);
    const added: Criterion = {
      id,
      section: sectionId,
      title: uniqueTitle('Новый критерий', draft.criteria.map((item) => item.title)),
      type: 'boolean',
      weight: NEW_WEIGHT,
      scored: true,
      flag: null,
      allow_na: false,
      yes_when: '',
      prompt: null,
      na_when: null,
      levels: [],
      team_notes: [],
      ...(draft.criteria.some((item) => item.disabled_notes !== undefined) || isNew ? { disabled_notes: [] } : {}),
    };
    setDraft((current) => ({ ...current, criteria: [...current.criteria, added] }));
    setSelected(id);
    setFreshId(id);
  };

  const addSection = () => {
    const id = nextId([...base.sections, ...draft.sections].map((item) => item.id), 's', 1);
    const title = uniqueTitle('Новая секция', draft.sections.map((item) => item.title));
    setDraft((current) => ({ ...current, sections: [...current.sections, { id, title }] }));
    setTimeout(() => document.querySelector<HTMLInputElement>(`[data-section="${id}"]`)?.select());
  };

  const pickAfter = (gone: string[], next: Criterion[]) => {
    if (selected && gone.includes(selected)) setSelected(next[0]?.id ?? null);
  };

  const removeCriterion = (id: string) => {
    const position = draft.criteria.findIndex((item) => item.id === id);
    const criteria = draft.criteria.filter((item) => item.id !== id);
    setDraft((current) => ({ ...current, criteria: current.criteria.filter((item) => item.id !== id) }));
    setSelected(criteria[Math.min(position, criteria.length - 1)]?.id ?? null);
  };

  const removeSection = (sectionId: string, moveTo: string | null) => {
    const members = draft.criteria.filter((item) => item.section === sectionId).map((item) => item.id);
    const criteria = moveTo
      ? draft.criteria.map((item) => (item.section === sectionId ? { ...item, section: moveTo } : item))
      : draft.criteria.filter((item) => item.section !== sectionId);
    setDraft((current) => ({ ...current, criteria, sections: current.sections.filter((item) => item.id !== sectionId) }));
    if (!moveTo) pickAfter(members, criteria);
  };

  // Rules that keep a sheet usable: it needs a section, a criterion and something with a weight.
  const criterionDeleteBlock = (id: string): string | null => {
    const rest = draft.criteria.filter((item) => item.id !== id);
    if (!rest.length) return 'Это последний критерий: в листе должен остаться хотя бы один.';
    if (!rest.some(hasWeight)) return 'Это единственный критерий с весом: без него итог не рассчитается.';
    return null;
  };
  const sectionKeepBlock = (id: string): string | null => {
    const rest = draft.criteria.filter((item) => item.section !== id);
    if (!rest.length) return 'В листе не останется критериев.';
    if (!rest.some(hasWeight)) return 'Не останется критериев с весом: итог не рассчитается.';
    return null;
  };

  const showIssue = (issue: ValidationIssue) => {
    if (issue.criterionId) setSelected(issue.criterionId);
    const selector = issue.sectionId
      ? `[data-section="${issue.sectionId}"]`
      : issue.field
        ? `[data-field="${issue.field}"]`
        : '[aria-label="Название листа"]';
    setTimeout(() => {
      const element = document.querySelector<HTMLElement>(selector);
      element?.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
      element?.focus({ preventScroll: true });
    }, 60);
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
  const firstIssue = issues[0];
  const dirty = !isNew && change !== 'none';
  const lockedHint = dirty ? 'Сначала сохраните или отмените изменения' : undefined;
  const status =
    change === 'none' && savedNotice
      ? { id: 'saved', tone: 'good', text: savedNotice, action: false }
      : change === 'none'
        ? { id: 'clean', tone: 'quiet', text: `Сумма весов ${fmtNumber(weightSum)} · изменений нет`, action: false }
        : firstIssue
          ? {
              id: `error:${firstIssue.criterionId}:${firstIssue.sectionId}:${firstIssue.field}`,
              tone: 'bad',
              text: issues.length > 1 ? `${firstIssue.message} (и ещё ${issues.length - 1})` : firstIssue.message,
              action: true,
            }
          : saveError
            ? { id: 'save-error', tone: 'bad', text: saveError, action: true }
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
              <select aria-label="Оценочный лист" className="shead__pick" disabled={dirty} title={lockedHint} value={draft.checklist_id} onChange={(event) => onPick(event.target.value)}>
                {sheets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            )}
            <Button variant="text" className="ml-2" disabled={dirty} title={lockedHint} onClick={() => onStartNew(blankSheet(takenIds))}>Новый лист</Button>
            <Button variant="text" className="ml-2" disabled={dirty} title={lockedHint} onClick={() => onStartNew(copyOf(base, takenIds))}>Копия этого листа</Button>
          </>
        )}
        <div className="shead__end">
          <Swap id={status.id} align="end">
            <span className="shead__status" data-tone={status.tone} role="status">
              <span className="shead__text" title={status.text}>{status.text}</span>
              {firstIssue && status.action && <Button variant="text" onClick={() => showIssue(firstIssue)}>Показать</Button>}
              {dirty && (
                <Button
                  variant="text"
                  className="btn--quiet"
                  onClick={() => {
                    setDraft(base);
                    setSaveError(null);
                    if (!base.criteria.some((item) => item.id === selected)) setSelected(base.criteria[0]?.id ?? null);
                  }}
                >
                  Отменить изменения
                </Button>
              )}
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
            <div className="weights" aria-hidden>
              {draft.criteria.filter((item) => item.scored && item.weight > 0).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  tabIndex={-1}
                  data-on={selected === item.id || undefined}
                  style={{ flexGrow: item.weight }}
                  title={`${item.title}: ${fmtNumber(item.weight)}`}
                  onClick={() => setSelected(item.id)}
                />
              ))}
            </div>
            {draft.sections.map((section) => {
              const members = draft.criteria.filter((item) => item.section === section.id);
              return (
                <div key={section.id}>
                  <SectionHead
                    section={section}
                    others={draft.sections.filter((item) => item.id !== section.id)}
                    count={members.length}
                    error={issues.find((item) => item.sectionId === section.id)?.hint}
                    blocked={draft.sections.length === 1 ? 'Это последняя секция: в листе должна остаться хотя бы одна.' : null}
                    keepBlock={sectionKeepBlock(section.id)}
                    onRename={(title) =>
                      setDraft((current) => ({
                        ...current,
                        sections: current.sections.map((item) => (item.id === section.id ? { ...item, title } : item)),
                      }))
                    }
                    onRemove={(moveTo) => removeSection(section.id, moveTo)}
                  />
                  {members.map((item) => (
                    <button key={item.id} type="button" className="srow" aria-current={selected === item.id} onClick={() => setSelected(item.id)}>
                      <span className="srow__main">
                        <span className="srow__title" title={item.title}>{item.title || 'Новый критерий'}</span>
                        <span className="srow__kind">
                          {answerKindLabel(item)}
                          {issues.some((issue) => issue.criterionId === item.id) ? (
                            <Badge tone="bad">не заполнен</Badge>
                          ) : (
                            !sameCriterion(base, base.criteria.find((other) => other.id === item.id), item) && <Badge tone="warn">изменён</Badge>
                          )}
                        </span>
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
          <div className="scroll-panel__body cfg-scroll">
            {criterion ? (
              <CriterionEditor
                key={criterion.id}
                criterion={criterion}
                saved={base.criteria.find((item) => item.id === criterion.id)}
                sections={draft.sections}
                errors={issues.filter((issue) => issue.criterionId === criterion.id)}
                deleteBlock={criterionDeleteBlock(criterion.id)}
                fresh={freshId === criterion.id}
                version={base.version}
                onChange={(fields) => patch(criterion.id, fields)}
                onDelete={() => removeCriterion(criterion.id)}
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
