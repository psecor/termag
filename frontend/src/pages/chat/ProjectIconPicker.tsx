// Choosing a project's icon, under user-projects-enabled:
// Automatic (each repository's detected icon, else its letter), the letters, each icon found in the
// repositories, and Upload…. "Change icon…" in the project head's ⋯ menu opens it in a dialog
// (ChangeIconDialog); New project's repositories step shows it under the list (ProjectPicker.tsx, with
// useRepoIconCandidates), its pick, candidates and uploads part of that menu's draft.
// LaunchPad's RadioGroup of RadioButtons (one choice, arrow keys between them), FileTrigger and Modal.
// An upload is drawn into a 128 × 128 PNG here before it's sent (64 × 64 if that's over 32 KiB), whatever
// was picked (an SVG too). Every image is a data: URI: no route serves an icon.
import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert, AlertText, Button, ButtonGroup, Dialog, FileTrigger, Heading, Label, Modal, ModalOverlay, ProgressBar, RadioButton,
  RadioGroup, Text,
} from '@launchpad-ui/components';
import { userProjectsApi, type ProjectIconCandidate, type ProjectIconChoice, type RepoIcons } from '../../services/api';
import { LP_THEME } from '../../launchpad/theme';
import { ProjectGlyph, type GlyphIcons } from './ProjectGlyph';
import { useSimpleDataIfAny, type OwnProject } from './simpleData';
import './projectIcons.css';

/** What the picker holds: automatic, the letters, or one of the person's icons. */
export type IconPick = { choice: 'auto' } | { choice: 'letter' } | { choice: 'image'; iconId: string };

/** The picker's tiles: automatic, the letters, each repository's candidates (deduplicated), then uploads. */
export interface IconTile {
  key: string;
  pick: IconPick;
  caption: string;
  /** Its tooltip: where it came from. */
  title: string;
  icons?: GlyphIcons;
}

const AUTO = 'auto';
const LETTER = 'letter';
const imageKey = (id: string) => `img:${id}`;
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

export function keyOfPick(pick: IconPick): string {
  return pick.choice === 'image' ? imageKey(pick.iconId) : pick.choice;
}

export function pickOf(choice: ProjectIconChoice | undefined | null): IconPick {
  if (choice?.choice === 'letter') return { choice: 'letter' };
  if (choice?.choice === 'image' && choice.imageId) return { choice: 'image', iconId: choice.imageId };
  return { choice: 'auto' };
}

/** The tiles for a project's repositories and the person's uploads. */
export function iconTiles(
  repoKeys: readonly string[], repos: readonly RepoIcons[], uploads: readonly ProjectIconCandidate[], current: ProjectIconCandidate | null = null,
): IconTile[] {
  const auto: Record<string, string> = {};
  for (const r of repos) {
    const src = r.candidates.find(c => c.id === r.detectedId)?.src;
    if (src) auto[r.repoKey] = src;
  }
  const detected = repoKeys.filter(k => auto[k]).length;
  const tiles: IconTile[] = [
    {
      key: AUTO, pick: { choice: 'auto' }, caption: 'Automatic', icons: { repos: auto },
      title: detected > 0 ? "Each repository's own icon, else its letter, as the repository changes" : 'Its letters, until an icon turns up in a repository',
    },
    { key: LETTER, pick: { choice: 'letter' }, caption: 'Letters', title: 'Letter tiles, whatever the repositories have' },
  ];
  const seen = new Set<string>();
  for (const r of repos) {
    for (const c of r.candidates) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      tiles.push({
        key: imageKey(c.id), pick: { choice: 'image', iconId: c.id }, caption: c.path ? baseName(c.path) : 'Icon',
        title: `${r.repoKey}: ${c.path ?? 'icon'}`, icons: { image: c.src },
      });
    }
  }
  for (const u of uploads) {
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    tiles.push({ key: imageKey(u.id), pick: { choice: 'image', iconId: u.id }, caption: 'Uploaded', title: 'An image you uploaded', icons: { image: u.src } });
  }
  // The image it shows now, when nothing above lists it (its repositories couldn't be read): kept in view, so
  // what's picked is what's shown and Save can move off it.
  if (current && !seen.has(current.id)) {
    tiles.push({ key: imageKey(current.id), pick: { choice: 'image', iconId: current.id }, caption: 'Current', title: 'The icon it shows now', icons: { image: current.src } });
  }
  return tiles;
}

/** The most an upload may be before it's drawn small: a phone photo, not a video. */
const UPLOAD_SOURCE_MAX = 8 * 1024 * 1024;
/** The server's cap on an icon (backend services/projectIcons.ts ICON_MAX_BYTES). */
export const ICON_MAX_BYTES = 32 * 1024;
const UPLOAD_SIZES = [128, 64];

/**
 * An image file drawn centred into a 128 × 128 PNG (its aspect kept), as every upload is sent, or 64 × 64
 * when that's over the server's 32 KiB (a busy photo): either is crisp at 18 px on a 3× screen.
 */
export async function toIconPng(file: Blob): Promise<Blob> {
  if (file.size > UPLOAD_SOURCE_MAX) throw new Error('Pick an image under 8 MB');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode().catch(() => { throw new Error("That file isn't an image this browser can read"); });
    let blob: Blob | null = null;
    for (const size of UPLOAD_SIZES) {
      blob = await drawPng(img, size);
      if (blob.size <= ICON_MAX_BYTES) return blob;
    }
    throw new Error('That image is too detailed to make a small icon from; try a simpler one');
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function drawPng(img: HTMLImageElement, size: number): Promise<Blob> {
  const w = img.naturalWidth || size;
  const h = img.naturalHeight || size;
  const scale = Math.min(size / w, size / h);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error("This browser can't draw the image");
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (size - w * scale) / 2, (size - h * scale) / 2, w * scale, h * scale);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error("Couldn't draw the image"))), 'image/png'));
}

/** A blob as a data: URI, to show an upload at once (the server sends icons back only inline too). */
export function blobSrc(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the image"));
    reader.readAsDataURL(blob);
  });
}

const errorText = (err: unknown, fallback: string) => {
  const e = (err as { response?: { data?: { error?: unknown } } })?.response?.data?.error;
  return typeof e === 'string' && e ? e : err instanceof Error && err.message ? err.message : fallback;
};

export type IconsRead = { kind: 'loading' } | { kind: 'failed'; error: string } | { kind: 'ready'; repos: RepoIcons[]; upload: ProjectIconCandidate | null };

/** A pick's image as the picker shows it (a data: URI), for a view made before the server's next answer; null for none. */
export function pickSrc(read: IconsRead, uploads: readonly ProjectIconCandidate[], pick: IconPick): string | null {
  if (pick.choice !== 'image') return null;
  const all = [...uploads, ...(read.kind === 'ready' ? [...(read.upload ? [read.upload] : []), ...read.repos.flatMap(r => r.candidates)] : [])];
  return all.find(c => c.id === pick.iconId)?.src ?? null;
}

/** The pick to save: the one picked when its tile is shown, else Automatic (still reading, or an icon of a repository since unpicked). */
export function effectivePick(repoKeys: readonly string[], read: IconsRead, uploads: readonly ProjectIconCandidate[], pick: IconPick): IconPick {
  if (pick.choice !== 'image') return pick;
  const shown = read.kind === 'ready' ? [...(read.upload ? [read.upload] : []), ...uploads] : uploads;
  const tiles = iconTiles(repoKeys, read.kind === 'ready' ? read.repos : [], shown);
  return tiles.some(t => t.key === keyOfPick(pick)) ? pick : { choice: 'auto' };
}

/**
 * The tiles and Upload…: a controlled choice over what was read. The uploads made here belong to the caller
 * (`uploads`, `onUploaded`), so they outlive this picker (New project's Back, then its repositories again),
 * and the caller hears when an upload is under way, to hold its own Save or Create until it lands.
 */
export function ProjectIconPicker({ repoKeys, read, value, onChange, uploads, onUploaded, onBusyChange, current = null, label = 'Icon', showLabel = true, size = 18 }: {
  /** The project's repositories, owner/name, in order: the letters and the split. */
  repoKeys: readonly string[];
  read: IconsRead;
  value: IconPick;
  onChange: (pick: IconPick) => void;
  uploads: readonly ProjectIconCandidate[];
  onUploaded: (upload: ProjectIconCandidate) => void;
  onBusyChange?: (busy: boolean) => void;
  /** The image the project shows now, from its list view: a tile even when the read failed. */
  current?: ProjectIconCandidate | null;
  label?: string;
  /** Its label over the tiles; the dialog's heading already says it. */
  showLabel?: boolean;
  /** The previews' size: 18 in the dialog (a head's), smaller in New project. */
  size?: number;
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const repos = read.kind === 'ready' ? read.repos : [];
  const shownUploads = useMemo(() => [...(read.kind === 'ready' && read.upload ? [read.upload] : []), ...uploads], [read, uploads]);
  const tiles = iconTiles(repoKeys, repos, shownUploads, current);
  const listed = tiles.some(t => t.key === keyOfPick(value));
  const selected = listed ? keyOfPick(value) : AUTO;
  // A choice no tile shows (an icon of a repository since unpicked) becomes Automatic, so what's saved is what's shown.
  useEffect(() => {
    if (read.kind === 'ready' && !listed) onChange({ choice: 'auto' });
  }, [read.kind, listed]);
  useEffect(() => { onBusyChange?.(uploading); }, [uploading]);
  // Unmounted mid-upload (Back, a picked repository dropped): the caller's Save or Create isn't held by it any more.
  useEffect(() => () => { onBusyChange?.(false); }, []);

  async function upload(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError('');
    try {
      const png = await toIconPng(file);
      const [saved, src] = await Promise.all([userProjectsApi.uploadIcon(png), blobSrc(png)]);
      onUploaded({ id: saved.id, path: null, mimeType: saved.mimeType, src });
      onChange({ choice: 'image', iconId: saved.id });
    } catch (err) {
      setUploadError(errorText(err, "Couldn't upload the image"));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="pi-picker">
      <RadioGroup aria-label={label} orientation="horizontal" value={selected} className="pi-group"
        onChange={key => { const t = tiles.find(x => x.key === key); if (t) onChange(t.pick); }}>
        {showLabel && <Label className="pi-label">{label}</Label>}
        <div className="pi-tiles">
          {tiles.map(t => (
            <RadioButton key={t.key} value={t.key} variant="minimal" className="pi-tile" aria-label={`${t.caption}: ${t.title}`}>
              <ProjectGlyph repos={repoKeys} size={size * 2} icons={t.icons} tip={t.title} />
              <span className="pi-caption">{t.caption}</span>
            </RadioButton>
          ))}
        </div>
      </RadioGroup>
      <div className="pi-foot">
        <FileTrigger acceptedFileTypes={['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon']}
          onSelect={files => { void upload(files); }}>
          <Button size="small" isDisabled={uploading}>{uploading ? 'Uploading…' : 'Upload…'}</Button>
        </FileTrigger>
        {read.kind === 'loading' && <span className="pi-note">Looking in the repositories…</span>}
        {read.kind === 'failed' && <span className="pi-error">{read.error}</span>}
        {read.kind === 'ready' && repos.every(r => r.candidates.length === 0) && repoKeys.length > 0 && (
          <span className="pi-note">No icon found in {repoKeys.length === 1 ? 'the repository' : 'its repositories'}</span>
        )}
        {uploadError && <span className="pi-error" role="alert">{uploadError}</span>}
      </div>
    </div>
  );
}

/** "Change icon…": the project's picker in a dialog; Save stores the choice, once any upload has landed. */
export function ChangeIconDialog({ project, onClose }: { project: OwnProject; onClose: () => void }) {
  const data = useSimpleDataIfAny();
  // The project as the list has it: its repositories, its choice and its image now, so a failed read still
  // offers the letters, Automatic, Upload… and the current image, for the right repositories.
  const listed = data?.userProjects.list?.find(p => p.id === project.id);
  const [read, setRead] = useState<IconsRead>({ kind: 'loading' });
  const [repoKeys, setRepoKeys] = useState<string[]>(() => listed?.repos.map(r => r.repoKey) ?? []);
  const [value, setValue] = useState<IconPick>(() => pickOf(listed?.icon));
  const [initial, setInitial] = useState<string>(() => keyOfPick(pickOf(listed?.icon)));
  const [uploads, setUploads] = useState<ProjectIconCandidate[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = listed?.icon?.choice === 'image' && listed.icon.imageId && listed.icon.src
    ? { id: listed.icon.imageId, path: null, mimeType: '', src: listed.icon.src } : null;
  useEffect(() => {
    let live = true;
    userProjectsApi.icons(project.id).then(view => {
      if (!live) return;
      setRepoKeys(view.repos.map(r => r.repoKey));
      setValue(pickOf(view));
      setInitial(keyOfPick(pickOf(view)));
      setRead({ kind: 'ready', repos: view.repos, upload: view.upload });
    }).catch(err => { if (live) setRead({ kind: 'failed', error: errorText(err, "Couldn't read the project's icons") }); });
    return () => { live = false; };
  }, [project.id]);
  const save = async () => {
    if (busy || uploading) return;
    if (keyOfPick(value) === initial) { onClose(); return; }
    setBusy(true); setError('');
    try {
      await userProjectsApi.setIcon(project.id, value);
      await data?.userProjects.reload();
      onClose();
    } catch (err) {
      setError(errorText(err, "Couldn't change the icon"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalOverlay isOpen isDismissable={!busy} onOpenChange={open => { if (!open) onClose(); }} className={LP_THEME}>
      <Modal size="small" className="chat-project-modal">
        <Dialog className="chat-project-dialog" aria-label={`Change ${project.name}'s icon`}>
          <form onSubmit={e => { e.preventDefault(); void save(); }}>
            <Heading slot="title" level={2} size="medium">Change icon</Heading>
            <Text elementType="p" slot="subtitle" className="chat-project-dialog-note">
              {project.name}'s icon in the sidebar. Automatic follows its repositories' favicons.
            </Text>
            {/* Nothing to pick until the read answers (up to 10 s), so its answer never replaces a pick made meanwhile. */}
            {read.kind === 'loading'
              ? <ProgressBar isIndeterminate size="small" variant="spinner" aria-label="Looking for icons in its repositories" />
              : <ProjectIconPicker repoKeys={repoKeys} read={read} value={value} onChange={setValue} showLabel={false} current={current}
                  uploads={uploads} onUploaded={u => setUploads(list => [...list.filter(x => x.id !== u.id), u])} onBusyChange={setUploading} />}
            {error && <Alert status="error" hideIcon><AlertText><p>{error}</p></AlertText></Alert>}
            <ButtonGroup className="chat-project-dialog-buttons">
              <Button variant="minimal" onPress={onClose} isDisabled={busy}>Cancel</Button>
              <Button variant="primary" type="submit" isDisabled={busy || uploading || read.kind === 'loading'}>{busy ? 'Saving…' : uploading ? 'Uploading…' : 'Save'}</Button>
            </ButtonGroup>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/**
 * New project's icon candidates for the repositories picked, read once the picking settles. The caller
 * (ProjectPicker) holds what this reads, so it outlives the repositories step's picker across Back.
 */
export function useRepoIconCandidates(repoKeys: readonly string[]): IconsRead {
  const key = repoKeys.join(',');
  // What was read, with the key it was read for: a render for other repositories (the first pick, a pick
  // since) reads as still loading until its own look answers, never as an empty "nothing found".
  const [state, setState] = useState<{ key: string; read: IconsRead }>({ key: '', read: { kind: 'ready', repos: [], upload: null } });
  useEffect(() => {
    if (!key) { setState({ key: '', read: { kind: 'ready', repos: [], upload: null } }); return; }
    let live = true;
    // After the picking settles, so a quick run of picks reads GitHub once.
    const timer = setTimeout(() => {
      userProjectsApi.iconCandidates(key.split(','))
        .then(r => { if (live) setState({ key, read: { kind: 'ready', repos: r.repos, upload: null } }); })
        .catch(err => { if (live) setState({ key, read: { kind: 'failed', error: errorText(err, "Couldn't look for icons") } }); });
    }, 400);
    return () => { live = false; clearTimeout(timer); };
  }, [key]);
  if (state.key === key) return state.read;
  return key ? { kind: 'loading' } : { kind: 'ready', repos: [], upload: null };
}
