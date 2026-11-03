// Images in a space file's Markdown (SpaceFileView). One that resolves to a
// file in the same space (chat/spaceImages.ts) is fetched the way the file
// view fetches an image file: the space API signs a URL (sharedView for a
// viewer who came through a share), an image is that URL in an <img> and an
// SVG its text as a data: URL. It is scaled to the column, and a click opens
// the file. Until it loads, or if it can't, it is a link to the file with its
// alt text; a missing one says "(missing)". Any other image is never fetched:
// a link (http(s), another space) or its alt text (data:, other schemes, a
// path out of the space).
import React, { useEffect, useMemo, useState } from 'react';
import { spacesApi } from '../../services/api';
import { MarkdownImageContext, useOpenInPlace } from '../../chat/Markdown';
import { resolveSpaceImage } from '../../chat/spaceImages';
import { fileShow, svgDataUrl } from '../../chat/fileExplorer';
import { spaceFileLink, TEXT_PREVIEW_MAX_BYTES } from '../../utils/spaces';

type Shown =
  | { state: 'loading' }
  | { state: 'ok'; src: string }
  /** No such file, or (through a share) not one shared with this viewer. */
  | { state: 'missing' }
  /** Not an image, or it couldn't be read: the link alone. */
  | { state: 'link' };

function FileImage({ space, path, alt, viaShare }: { space: string; path: string; alt: string; viaShare: boolean }) {
  const [shown, setShown] = useState<Shown>({ state: 'loading' });
  const onLink = useOpenInPlace();
  const href = spaceFileLink(window.location.origin, import.meta.env.BASE_URL, space, path);
  useEffect(() => {
    let cancelled = false;
    setShown({ state: 'loading' });
    (async () => {
      const signed = await (viaShare ? spacesApi.sharedView(space, path) : spacesApi.view(space, path));
      const show = fileShow(signed.view);
      const type = signed.view?.contentType ?? '';
      if (show.kind === 'frame' && type.startsWith('image/')) return { state: 'ok', src: signed.url } as const;
      if (show.kind !== 'svg' || signed.size > TEXT_PREVIEW_MAX_BYTES) return { state: 'link' } as const;
      const res = await fetch(signed.url);
      if (!res.ok) return { state: 'link' } as const;
      return { state: 'ok', src: svgDataUrl(await res.text()) } as const;
    })().then(next => { if (!cancelled) setShown(next); }, err => {
      if (cancelled) return;
      const r = (err as { response?: { status?: number } })?.response;
      setShown({ state: r?.status === 404 ? 'missing' : 'link' });
    });
    return () => { cancelled = true; };
  }, [space, path, viaShare]);

  if (shown.state === 'ok') {
    return (
      <a className="md-img-inline" href={href} target="_blank" rel="noopener noreferrer" title={`Open ${path}`} onClick={onLink(href)}>
        <img src={shown.src} alt={alt || path} referrerPolicy="no-referrer" onError={() => setShown({ state: 'link' })} />
      </a>
    );
  }
  return (
    <>
      <a className="md-img" href={href} target="_blank" rel="noopener noreferrer" title={path} onClick={onLink(href)}
        aria-busy={shown.state === 'loading' || undefined}>{alt || path}</a>
      {shown.state === 'missing' && <span className="md-img-missing"> ({viaShare ? 'not shared' : 'missing'})</span>}
    </>
  );
}

function SpaceImage({ src, alt, space, path, viaShare }: { src: string; alt: string; space: string; path: string; viaShare: boolean }) {
  const onLink = useOpenInPlace();
  const target = resolveSpaceImage(src, { space, path, origin: window.location.origin, base: import.meta.env.BASE_URL });
  if (target.kind === 'file') return <FileImage space={target.space} path={target.path} alt={alt} viaShare={viaShare} />;
  if (target.kind === 'link') {
    return <a className="md-img" href={target.href} target="_blank" rel="noopener noreferrer" title={target.href} onClick={onLink(target.href)}>{alt || 'image'}</a>;
  }
  return <>{alt}</>;
}

/** Markdown inside draws its images as the space file at `space`/`path` sees them. */
export function SpaceMarkdownImages({ space, path, viaShare, children }: { space: string; path: string; viaShare: boolean; children: React.ReactNode }) {
  const draw = useMemo(() => (img: { src: string; alt: string }) => (
    <SpaceImage src={img.src} alt={img.alt} space={space} path={path} viaShare={viaShare} />
  ), [space, path, viaShare]);
  return <MarkdownImageContext.Provider value={draw}>{children}</MarkdownImageContext.Provider>;
}
