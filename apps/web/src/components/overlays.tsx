"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, AlertCircle } from "lucide-react";

/* =====================================================================================================================
 * Confirmation dialog + toasts.
 *  - Native <dialog> (focus trap, Esc, inert background, top layer) styled as a centred dialog on desktop and a bottom
 *    sheet on phones.
 *  - The sheet follows the finger 1:1, rubber-bands upward, and on release projects where the throw would land
 *    (velocity / 1000 * d / (1 - d)) to decide dismiss vs. settle, handing the release velocity to a spring.
 *  - Confirmation is reserved for consequential actions; completion is acknowledged with a toast.
 * ================================================================================================================= */

export interface ConfirmOptions { title: string; message?: string; confirmLabel?: string; cancelLabel?: string; destructive?: boolean }
type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>;
type ToastKind = "success" | "error";
type ToastFn = (message: string, kind?: ToastKind) => void;

const ConfirmCtx = createContext<ConfirmFn | null>(null);
const ToastCtx = createContext<ToastFn | null>(null);
export const useConfirm = (): ConfirmFn => { const c = useContext(ConfirmCtx); if (!c) throw new Error("useConfirm outside provider"); return c; };
export const useToast = (): ToastFn => { const c = useContext(ToastCtx); if (!c) throw new Error("useToast outside provider"); return c; };

const DECEL = 0.998;
const project = (v: number) => (v / 1000) * DECEL / (1 - DECEL); // px/s -> px of coasting distance
const rubber = (over: number, dim: number, c = 0.55) => (over * dim * c) / (dim + c * Math.abs(over));
const isPhone = () => typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches;
const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function ConfirmDialog({ opts, onClose }: { opts: ConfirmOptions; onClose: (ok: boolean) => void }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const result = useRef(false);
  const closing = useRef(false);
  const drag = useRef<{ id: number; startY: number; samples: { t: number; y: number }[] } | null>(null);

  useEffect(() => { dlg.current?.showModal(); }, []);

  const finish = useCallback((ok: boolean) => {
    if (closing.current) return;
    closing.current = true; result.current = ok;
    const el = panel.current, d = dlg.current;
    const done = () => { d?.close(); onClose(ok); };
    if (!el || reduced()) return done();
    // Exit along the entry path: down on phones (from wherever the drag left it), scale/fade on desktop.
    const phone = isPhone();
    const from = phone ? getComputedStyle(el).transform : "none";
    const anim = el.animate(phone ? [{ transform: from === "none" ? "translateY(0)" : from }, { transform: "translateY(110%)" }] : [{ opacity: 1, scale: 1 }, { opacity: 0, scale: 0.96 }],
      { duration: 220, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" });
    anim.onfinish = done;
  }, [onClose]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!isPhone() || closing.current || (e.target as HTMLElement).closest("button")) return;
    panel.current?.setPointerCapture(e.pointerId);
    // Grab from the current on-screen position (interruptible: a settling spring is cancelled where it is).
    panel.current?.getAnimations().forEach((a) => a.cancel());
    drag.current = { id: e.pointerId, startY: e.clientY, samples: [{ t: e.timeStamp, y: e.clientY }] };
    panel.current?.setAttribute("data-dragging", "true");
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d || d.id !== e.pointerId || !panel.current) return;
    d.samples.push({ t: e.timeStamp, y: e.clientY }); if (d.samples.length > 6) d.samples.shift();
    const dy = e.clientY - d.startY;
    const h = panel.current.offsetHeight;
    panel.current.style.transform = `translateY(${dy >= 0 ? dy : -rubber(-dy, h)}px)`; // resist upward, follow downward
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current; const el = panel.current; if (!d || d.id !== e.pointerId || !el) return;
    drag.current = null; el.removeAttribute("data-dragging");
    const first = d.samples[0]!, last = d.samples[d.samples.length - 1]!;
    const dt = Math.max(1, last.t - first.t);
    const v = ((last.y - first.y) / dt) * 1000; // px/s, positive = downward
    const dy = Math.max(0, e.clientY - d.startY);
    const landing = dy + project(v);
    if (landing > el.offsetHeight * 0.5) return finish(false);
    // Settle back with the release velocity handed to a (smooth) spring: start from the current offset.
    const cur = new DOMMatrixReadOnly(getComputedStyle(el).transform).m42;
    el.style.transform = "";
    if (!reduced()) el.animate([{ transform: `translateY(${cur}px)` }, { transform: "translateY(0)" }], { duration: 420, easing: "cubic-bezier(.2,.9,.25,1)" });
  };

  return (
    <dialog ref={dlg} className="sheet" aria-labelledby="confirm-title" aria-describedby={opts.message ? "confirm-desc" : undefined}
      onCancel={(e) => { e.preventDefault(); finish(false); }}
      onClick={(e) => { if (e.target === dlg.current) finish(false); }}>
      <div ref={panel} className="sheet-panel" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <div className="sheet-grabber" aria-hidden />
        <div>
          <h2 id="confirm-title" className="t-head">{opts.title}</h2>
          {opts.message && <p id="confirm-desc" className="mt-1.5 text-[14px]" style={{ color: "var(--muted)" }}>{opts.message}</p>}
        </div>
        <div className="sheet-actions">
          <button type="button" className="btn btn-secondary btn-lg" onClick={() => finish(false)}>{opts.cancelLabel ?? "Cancel"}</button>
          <button type="button" autoFocus className={opts.destructive ? "btn btn-danger btn-lg" : "btn btn-primary btn-lg"} data-confirm onClick={() => finish(true)}>{opts.confirmLabel ?? "Confirm"}</button>
        </div>
      </div>
    </dialog>
  );
}

interface ToastItem { id: number; message: string; kind: ToastKind; leaving?: boolean }

export function OverlayProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<{ opts: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const confirm = useCallback<ConfirmFn>((opts) => new Promise<boolean>((resolve) => setDialog({ opts, resolve })), []);
  const toast = useCallback<ToastFn>((message, kind = "success") => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-2), { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x))), kind === "error" ? 6000 : 3200);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6250 : 3450);
  }, []);
  const ctx = useMemo(() => ({ confirm, toast }), [confirm, toast]);

  return (
    <ConfirmCtx.Provider value={ctx.confirm}>
      <ToastCtx.Provider value={ctx.toast}>
        {children}
        {dialog && <ConfirmDialog opts={dialog.opts} onClose={(ok) => { dialog.resolve(ok); setDialog(null); }} />}
        <div className="toast-region" role="status" aria-live="polite" aria-atomic="false">
          {toasts.map((t) => (
            <div key={t.id} className="toast" data-leaving={t.leaving ? "true" : undefined} role={t.kind === "error" ? "alert" : undefined}>
              {t.kind === "success" ? <CheckCircle2 size={18} aria-hidden style={{ color: "var(--green-fg)" }} /> : <AlertCircle size={18} aria-hidden style={{ color: "var(--red-fg)" }} />}
              <span>{t.message}</span>
            </div>
          ))}
        </div>
      </ToastCtx.Provider>
    </ConfirmCtx.Provider>
  );
}
