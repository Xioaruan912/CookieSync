import { useGSAP } from '@gsap/react';
import { Button } from '@sync-your-cookie/ui';
import gsap from 'gsap';
import { X } from 'lucide-react';
import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';

gsap.registerPlugin(useGSAP);

interface Props {
  title: string;
  sheet?: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function OverviewDialog({ title, sheet, onClose, children }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const closing = useRef(false);
  const titleId = useId();

  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    (element?.querySelector<HTMLElement>('[data-initial-focus]') || closeButton.current)?.focus({
      preventScroll: true,
    });
    return () => element?.close();
  }, []);

  const { contextSafe } = useGSAP(
    () => {
      const media = gsap.matchMedia();
      media.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.fromTo(
          surface.current,
          { y: sheet ? 40 : 12, opacity: 0.72, scale: sheet ? 1 : 0.985 },
          { y: 0, opacity: 1, scale: 1, duration: 0.29, ease: 'power4.out', clearProps: 'transform,opacity' },
        );
      });
      return () => media.revert();
    },
    { scope: dialog },
  );

  const close = contextSafe(() => {
    if (closing.current) return;
    closing.current = true;
    dialog.current?.setAttribute('data-closing', '');
    const finish = () => {
      dialog.current?.close();
      onClose();
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finish();
      return;
    }
    gsap.to(surface.current, {
      y: sheet ? 28 : 9,
      opacity: 0,
      duration: 0.16,
      ease: 'power2.out',
      overwrite: true,
      onComplete: finish,
    });
  });

  return (
    <dialog
      ref={dialog}
      className="overview-dialog"
      data-sheet={sheet || undefined}
      aria-labelledby={titleId}
      onCancel={event => {
        event.preventDefault();
        close();
      }}
      onClick={event => {
        if (event.target === event.currentTarget) close();
      }}>
      <div ref={surface} className="overview-dialog-surface">
        <div className="overview-dialog-head">
          <h2 id={titleId}>{title}</h2>
          <Button ref={closeButton} type="button" size="icon" variant="ghost" aria-label="关闭" onClick={close}>
            <X size={17} aria-hidden="true" />
          </Button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
