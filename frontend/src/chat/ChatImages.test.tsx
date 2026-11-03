// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageImages } from './ChatImages';
import type { ChatImage } from './sdkChat';

const A = 'data:image/png;base64,QQ==';
const B = 'data:image/png;base64,Qg==';
const C = 'data:image/png;base64,Qw==';

describe('MessageImages lightbox', () => {
  let container: HTMLDivElement;
  let root: Root;
  // What the last click left: whether the page took it, so jsdom never tries to navigate.
  let prevented: boolean | null;
  const stopNavigation = (e: Event) => { prevented = e.defaultPrevented; e.preventDefault(); };
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    prevented = null;
    document.addEventListener('click', stopNavigation);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.removeEventListener('click', stopNavigation);
  });

  const render = (images: ChatImage[]) =>
    act(() => root.render(<MessageImages images={images} projectId="p1" workstream="main" />));
  const thumbs = () => [...container.querySelectorAll<HTMLAnchorElement>('a.sdk-image')];
  const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
  const shown = () => dialog()?.querySelector<HTMLImageElement>('.chat-lightbox-img')?.getAttribute('src');
  const click = (el: Element, init: MouseEventInit = {}) =>
    act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })); });
  const key = (k: string) =>
    act(() => { dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });

  it('opens a clicked thumbnail full size, and closes back to it on Escape', () => {
    render([{ mediaType: 'image/png', src: A }, { mediaType: 'image/png', src: B }]);
    click(thumbs()[1]);
    expect(prevented).toBe(true);
    expect(dialog()?.getAttribute('aria-label')).toBe('Image 2 of 2');
    expect(shown()).toBe(B);
    key('Escape');
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(thumbs()[1]);
  });

  it('steps through the message\'s images with the arrow keys and buttons, wrapping', () => {
    render([{ mediaType: 'image/png', src: A }, { mediaType: 'image/png', src: B }, { mediaType: 'image/png', src: C }]);
    click(thumbs()[0]);
    key('ArrowRight');
    expect(shown()).toBe(B);
    key('ArrowLeft');
    key('ArrowLeft');
    expect(shown()).toBe(C);
    expect(dialog()?.querySelector('.chat-lightbox-count')?.textContent).toBe('3 of 3');
    click(dialog()!.querySelector('[aria-label="Next image"]')!);
    expect(shown()).toBe(A);
    click(dialog()!.querySelector('[aria-label="Close"]')!);
    expect(dialog()).toBeNull();
  });

  it('shows one image without the stepping bar, and the backdrop closes it', () => {
    render([{ mediaType: 'image/png', src: A }]);
    click(thumbs()[0]);
    expect(dialog()?.querySelector('.chat-lightbox-bar')).toBeNull();
    key('ArrowRight');
    expect(shown()).toBe(A);
    const backdrop = document.body.querySelector('.chat-lightbox-backdrop')!;
    act(() => { backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    click(backdrop);
    expect(dialog()).toBeNull();
  });

  it('leaves a modified or middle click to the browser, which opens a new tab', () => {
    render([{ mediaType: 'image/png', src: A }]);
    click(thumbs()[0], { metaKey: true });
    expect(prevented).toBe(false);
    click(thumbs()[0], { button: 1 });
    expect(prevented).toBe(false);
    expect(dialog()).toBeNull();
  });

  it('stacks two or more images with the first in front, and only it is a tab stop', () => {
    render([{ mediaType: 'image/png', src: A }, { mediaType: 'image/png', src: B }, { mediaType: 'image/png', src: C }]);
    const stack = container.querySelector('.sdk-images')!;
    expect(stack.classList.contains('sdk-image-stack')).toBe(true);
    expect(stack.getAttribute('aria-label')).toBe('3 images');
    expect(thumbs().map(t => t.dataset.layer)).toEqual(['0', '1', '2']);
    expect(thumbs().map(t => t.tabIndex)).toEqual([0, -1, -1]);
    click(thumbs()[0]);
    expect(dialog()?.getAttribute('aria-label')).toBe('Image 1 of 3');
  });

  it('leaves a single image unstacked', () => {
    render([{ mediaType: 'image/png', src: A }]);
    expect(container.querySelector('.sdk-image-stack')).toBeNull();
    expect(thumbs()[0].dataset.layer).toBeUndefined();
  });

  it('shows a PDF as a named chip beside the images, outside the lightbox', () => {
    render([{ mediaType: 'application/pdf', src: 'data:application/pdf;base64,JVBERi0=', name: 'spec.pdf' }, { mediaType: 'application/pdf', path: '~/.termag/chat-images/k/abc.pdf' }, { mediaType: 'image/png', src: A }]);
    const chips = [...container.querySelectorAll<HTMLElement>('.sdk-file')];
    expect(chips.map(c => c.textContent)).toEqual(['PDFspec.pdf', 'PDFPDF document']);
    expect(chips[0].getAttribute('download')).toBe('spec.pdf');
    expect(thumbs()).toHaveLength(1);
    expect(container.querySelector('.sdk-image-stack')).toBeNull();
  });

  it('skips an image that could not be shown', () => {
    render([{ mediaType: 'image/png', src: A }, { mediaType: 'image/png' }, { mediaType: 'image/png', src: C }]);
    expect(thumbs()).toHaveLength(2);
    click(thumbs()[1]);
    expect(dialog()?.getAttribute('aria-label')).toBe('Image 2 of 2');
    expect(shown()).toBe(C);
  });
});
