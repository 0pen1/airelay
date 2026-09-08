// Lightweight toast notifications for protocol errors.
//
// The relay/agent send { type:'error', code, message } for failures the user
// should know about (session occupied, agent unavailable, auth expired…).
// These render as auto-dismissing toasts at the top of the viewport.

export function showToast(message: string, kind: 'error' | 'info' = 'error'): void {
  const container = getContainer();
  const toast = document.createElement('div');
  toast.className = `toast toast--${kind}`;
  toast.setAttribute('role', 'alert');
  toast.textContent = message;
  container.appendChild(toast);
  // Trigger the slide-in on the next frame (transition needs a start state).
  requestAnimationFrame(() => toast.classList.add('toast--show'));
  setTimeout(() => {
    toast.classList.remove('toast--show');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function getContainer(): HTMLElement {
  let el = document.getElementById('toast-container');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast-container';
    el.style.cssText = [
      'position:fixed', 'top:calc(env(safe-area-inset-top) + 8px)',
      'left:50%', 'transform:translateX(-50%)', 'z-index:100',
      'display:flex', 'flex-direction:column', 'gap:8px', 'width:min(90vw, 360px)',
      'pointer-events:none',
    ].join(';');
    document.body.appendChild(el);
  }
  return el;
}

// Styles are injected once (matches the app's dark terminal aesthetic).
const style = document.createElement('style');
style.textContent = `
  .toast {
    background: #1e1e1c; color: #f0ede8;
    border: 1px solid #3a3a38; border-left: 3px solid oklch(50% 0.20 25);
    border-radius: 8px; padding: 10px 14px;
    font-size: 0.85rem; line-height: 1.4;
    opacity: 0; transform: translateY(-8px);
    transition: opacity 250ms, transform 250ms;
    box-shadow: 0 4px 12px oklch(0% 0 0 / 0.3);
  }
  .toast--info { border-left-color: oklch(55% 0.18 255); }
  .toast--show { opacity: 1; transform: translateY(0); }
`;
document.head.appendChild(style);
