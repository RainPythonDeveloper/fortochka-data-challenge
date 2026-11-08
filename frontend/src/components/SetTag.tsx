// Which data set a dialogue came from: the group it was imported with.
// DEV is the organizers' development set, FBroker their control (prod) set.
// Any other group is shown by its own name; a file uploaded by hand has no group.

export type SetKind = 'dev' | 'prod' | 'other' | 'upload';

export function setOf(groupId: string | null | undefined): { key: string; kind: SetKind; label: string } {
  const group = (groupId ?? '').trim();
  if (!group) return { key: '', kind: 'upload', label: 'Файл' };
  const lower = group.toLowerCase();
  if (lower === 'dev') return { key: group, kind: 'dev', label: 'DEV' };
  if (lower === 'fbroker' || lower === 'prod') return { key: group, kind: 'prod', label: 'PROD' };
  return { key: group, kind: 'other', label: group.toUpperCase() };
}

export function SetTag({ groupId }: { groupId: string | null | undefined }) {
  const set = setOf(groupId);
  const title = set.kind === 'upload' ? 'Загружен файлом' : `Набор ${set.key}`;
  return (
    <span className="set-tag" data-set={set.kind} title={title}>
      {set.label}
    </span>
  );
}
