// A project's icon in the sidebar: one
// fixed square whatever its repositories, so every title lines up. One repository: its favicon, else
// its letter on its own hue; two or more: the first two split on the diagonal, each half its favicon
// or its letter; none (Scratch): a dashed square. A chosen image fills the whole square instead, and
// "letter" keeps the letters whatever was found. An image that fails to load falls back to the letter.
// Hand-rolled: LaunchPad has no avatar for a repository.
import React, { useState } from 'react';
import './projectIcons.css';
import type { UserProjectView } from '../../services/api';

/** A stable hue for a repository, so termag is the same colour everywhere. */
function hueOf(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % 360;
}

const repoName = (key: string) => key.slice(key.lastIndexOf('/') + 1) || key;

/** The images a project's glyph draws: its chosen one, or each repository's detected one (by repoKey). */
export interface GlyphIcons {
  image?: string | null;
  repos?: Readonly<Record<string, string>>;
}

/**
 * A project's glyph images from its view (each inline, a data: URI): none for the letters, the image for an
 * image, else each repository's own.
 */
export function glyphIconsOf(project: Pick<UserProjectView, 'icon' | 'repos'> | undefined | null): GlyphIcons | undefined {
  if (!project?.icon || project.icon.choice === 'letter') return undefined;
  if (project.icon.choice === 'image') return project.icon.src ? { image: project.icon.src } : undefined;
  const repos: Record<string, string> = {};
  for (const r of project.repos) if (r.iconSrc) repos[r.repoKey] = r.iconSrc;
  return Object.keys(repos).length > 0 ? { repos } : undefined;
}

function Letter({ repo, half }: { repo: string; half?: 'a' | 'b' }) {
  return (
    <span className="pg-letter" data-half={half} style={{ '--pg-hue': hueOf(repo) } as React.CSSProperties}>
      <span>{repoName(repo).charAt(0).toUpperCase()}</span>
    </span>
  );
}

/** An image in the square (or one half of it), or `fallback` once it fails to load. */
function Img({ src, half, fallback }: { src: string; half?: 'a' | 'b'; fallback: React.ReactNode }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (failed === src) return <>{fallback}</>;
  return (
    <span className="pg-img" data-half={half}>
      <img src={src} alt="" draggable={false} decoding="async" onError={() => setFailed(src)} />
    </span>
  );
}

function Half({ repo, half, icons }: { repo: string; half?: 'a' | 'b'; icons?: GlyphIcons }) {
  const letter = <Letter repo={repo} half={half} />;
  // Keyed by the project's repoKey (owner/name, lowercased); a checkout's own key may differ in case or keep `.git`.
  const src = icons?.repos?.[repo] ?? icons?.repos?.[repo.toLowerCase().replace(/\.git$/, '')];
  return src ? <Img src={src} half={half} fallback={letter} /> : letter;
}

export function ProjectGlyph({ repos, size = 15, badge = null, tip, icons }: {
  /** The project's repositories, `owner/name`, in checkout order. */
  repos: readonly string[];
  size?: number;
  /** Drawn on the bottom-right corner: a session's model mark. */
  badge?: React.ReactNode;
  /** Its tooltip (chat/sessionCard.ts projectTip): the simple UI's own, from data-tip (Tooltips.tsx). */
  tip?: string;
  /** Its images (glyphIconsOf); none draws the letters. */
  icons?: GlyphIcons;
}) {
  const style = { '--pg-size': `${size}px` } as React.CSSProperties;
  const letters = (
    <>
      {repos.length === 0 && <span className="pg-scratch" />}
      {repos.length === 1 && <Half repo={repos[0]} icons={icons} />}
      {repos.length > 1 && (
        <span className="pg-split"><Half repo={repos[0]} half="a" icons={icons} /><Half repo={repos[1]} half="b" icons={icons} /></span>
      )}
    </>
  );
  return (
    <span className="pg" style={style} data-tip={tip} data-badged={badge ? '' : undefined} aria-hidden="true">
      {icons?.image ? <Img src={icons.image} fallback={letters} /> : letters}
      {badge && <span className="pg-badge">{badge}</span>}
    </span>
  );
}
