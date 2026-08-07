import { useEffect, useRef, useState } from 'react';
import { post, patch } from '../api';
import { Spinner } from './Loading';
import { useDismiss } from '../useDismiss';

const FRAME = 224; // on-screen circular frame (px)
const OUTPUT = 256; // stored avatar size (px)

/**
 * Circular avatar crop editor: live preview, drag to reposition, slider to
 * zoom. The CROPPED RESULT is persisted (a 256px JPEG drawn from the exact
 * frame the user sees) — badges everywhere simply render the stored image,
 * no crop parameters to keep in sync.
 */
export default function AvatarEditor({ file, onSaved, onClose }: { file: File; onSaved: () => void; onClose: () => void }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const dialogRef = useDismiss<HTMLDivElement>(onClose, !busy);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const el = new Image();
    el.onload = () => setImg(el);
    el.onerror = () => setError('Could not read this file as an image.');
    el.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // cover-fit base scale; zoom multiplies it
  const baseScale = img ? FRAME / Math.min(img.naturalWidth, img.naturalHeight) : 1;
  const scale = baseScale * zoom;
  const dw = (img?.naturalWidth ?? 0) * scale;
  const dh = (img?.naturalHeight ?? 0) * scale;

  const clamp = (v: number, span: number) => {
    const max = Math.max(0, (span - FRAME) / 2);
    return Math.min(max, Math.max(-max, v));
  };
  const ox = clamp(offset.x, dw);
  const oy = clamp(offset.y, dh);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startY: e.clientY, baseX: ox, baseY: oy };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setOffset({
      x: drag.current.baseX + (e.clientX - drag.current.startX),
      y: drag.current.baseY + (e.clientY - drag.current.startY),
    });
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const save = async () => {
    if (!img) return;
    setBusy(true);
    setError(null);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = OUTPUT;
      canvas.height = OUTPUT;
      const g = canvas.getContext('2d')!;
      const f = OUTPUT / FRAME;
      g.fillStyle = '#fff';
      g.fillRect(0, 0, OUTPUT, OUTPUT);
      // draw exactly what the frame shows, scaled to the output size
      g.drawImage(img, (FRAME / 2 - dw / 2 + ox) * f, (FRAME / 2 - dh / 2 + oy) * f, dw * f, dh * f);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('crop failed'))), 'image/jpeg', 0.9),
      );
      const { key, uploadUrl } = await post<{ key: string; uploadUrl: string }>('/api/me/uploads/presign', {
        filename: 'avatar.jpg',
        contentType: 'image/jpeg',
        purpose: 'avatar',
      });
      const put = await fetch(uploadUrl, { method: 'PUT', body: blob, headers: { 'Content-Type': 'image/jpeg' } });
      if (!put.ok) throw new Error(`upload failed (${put.status})`);
      await patch('/api/me/profile', { avatarKey: key });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'saving failed');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-40 flex items-start justify-center pt-10 px-4" onClick={busy ? undefined : onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Adjust profile picture"
        className="bg-white rounded-xl shadow-xl p-5 space-y-4 w-full max-w-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold">Adjust your picture</h2>
        <p className="text-sm text-gray-500">Drag to reposition, zoom to frame. The circle is exactly your badge.</p>

        <div className="flex justify-center">
          {!img && !error && <Spinner label="Reading image" />}
          {img && (
            <div
              className="relative overflow-hidden rounded-full ring-2 ring-slate-300 cursor-move touch-none select-none"
              style={{ width: FRAME, height: FRAME }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              role="application"
              aria-label="Picture crop area, drag to reposition"
            >
              <img
                src={img.src}
                alt=""
                draggable={false}
                className="absolute max-w-none"
                style={{
                  width: dw,
                  height: dh,
                  left: FRAME / 2 - dw / 2 + ox,
                  top: FRAME / 2 - dh / 2 + oy,
                }}
              />
            </div>
          )}
        </div>

        <label className="block text-sm">
          Zoom
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="w-full"
            aria-label="Zoom"
          />
        </label>

        {error && (
          <p role="alert" className="text-sm text-red-700">⚠ {error}</p>
        )}
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} disabled={busy} className="border rounded px-3 py-1 disabled:opacity-50">
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={busy || !img}
            className="bg-slate-800 text-white rounded px-3 py-1 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save picture'}
          </button>
        </div>
      </div>
    </div>
  );
}
