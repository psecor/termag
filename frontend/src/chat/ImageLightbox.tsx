import React from 'react';
import { createPortal } from 'react-dom';
import { Dialog } from '../components/Dialog';

/**
 * A message's images at full size over the chat, one at a time: Escape, the
 * backdrop or × closes it; ← and → (or the buttons) step through them.
 */
export function ImageLightbox({ urls, index, onIndex, onClose }: {
  urls: string[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const count = urls.length;
  const step = (by: number) => onIndex((index + by + count) % count);
  const label = count > 1 ? `Image ${index + 1} of ${count}` : 'Image';
  return createPortal(
    // Portalled out of the transcript, but React still bubbles to it: a click here is not a click in the transcript.
    <div onClick={e => e.stopPropagation()}>
      <Dialog ariaLabel={label} onClose={onClose} className="chat-lightbox" backdropClassName="chat-lightbox-backdrop"
        onKeyDown={e => {
          if (count < 2 || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
          e.preventDefault();
          step(e.key === 'ArrowLeft' ? -1 : 1);
        }}>
        <img className="chat-lightbox-img" src={urls[index]} alt={label} />
        {count > 1 && (
          <div className="chat-lightbox-bar">
            <button type="button" className="chat-lightbox-btn" aria-label="Previous image" onClick={() => step(-1)}>‹</button>
            <span className="chat-lightbox-count" aria-live="polite">{index + 1} of {count}</span>
            <button type="button" className="chat-lightbox-btn" aria-label="Next image" onClick={() => step(1)}>›</button>
          </div>
        )}
        <button type="button" className="chat-lightbox-btn chat-lightbox-close" aria-label="Close" onClick={onClose}>×</button>
      </Dialog>
    </div>,
    document.body,
  );
}
