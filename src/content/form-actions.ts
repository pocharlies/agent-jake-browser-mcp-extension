/**
 * Content-script side of browser_drop and browser_fill_form.
 * Runs in the frame the ref belongs to, so both work inside iframes as well.
 */
import { findElement } from './selector';

export interface DropFile {
  name: string;
  mimeType: string;
  base64: string;
}

/**
 * Drop files and/or MIME data on an element as if dragged in from outside the page:
 * dragenter → dragover → drop, all carrying the same DataTransfer.
 */
export async function handleDispatchDrop(payload: {
  selector: string;
  files?: DropFile[];
  data?: Record<string, string>;
}): Promise<{ dropped: string[]; accepted: boolean }> {
  const element = await findElement(payload.selector, { visible: true });
  const dt = new DataTransfer();
  for (const f of payload.files ?? []) {
    const bin = atob(f.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new File([bytes], f.name, { type: f.mimeType }));
  }
  for (const [type, value] of Object.entries(payload.data ?? {})) dt.setData(type, value);

  const rect = element.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    dataTransfer: dt,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
  element.dispatchEvent(new DragEvent('dragenter', init));
  // A drop target says "yes" by cancelling dragover; report it so a silent no-op shows.
  const accepted = !element.dispatchEvent(new DragEvent('dragover', init));
  element.dispatchEvent(new DragEvent('drop', init));

  return { dropped: [...(payload.files ?? []).map((f) => f.name), ...Object.keys(payload.data ?? {})], accepted };
}

type FieldKind = 'textbox' | 'checkbox' | 'radio' | 'combobox' | 'slider';

function kindOf(el: Element): FieldKind {
  const type = (el.getAttribute('type') || '').toLowerCase();
  const role = el.getAttribute('role');
  if (el instanceof HTMLSelectElement) return 'combobox';
  if (type === 'checkbox' || role === 'checkbox' || role === 'switch') return 'checkbox';
  if (type === 'radio' || role === 'radio') return 'radio';
  if (type === 'range' || role === 'slider') return 'slider';
  return 'textbox';
}

/**
 * Set a value through the prototype's setter, then fire input/change: frameworks that
 * track the value themselves (React) ignore a plain `el.value = ...`.
 */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export async function handleFillField(payload: {
  selector: string;
  value: string | number | boolean;
  type?: FieldKind;
}): Promise<{ kind: FieldKind }> {
  const el = await findElement(payload.selector);
  const kind = payload.type ?? kindOf(el);
  const value = payload.value;

  if (el instanceof HTMLElement) el.focus({ preventScroll: true });

  switch (kind) {
    case 'checkbox':
    case 'radio': {
      const want = value === true || String(value).toLowerCase() === 'true';
      const isChecked = el instanceof HTMLInputElement ? el.checked : el.getAttribute('aria-checked') === 'true';
      if (isChecked !== want) (el as HTMLElement).click();
      break;
    }
    case 'combobox': {
      if (!(el instanceof HTMLSelectElement)) throw new Error('combobox field is not a <select>');
      const v = String(value);
      const opt = [...el.options].find((o) => o.label === v || o.text.trim() === v) ?? [...el.options].find((o) => o.value === v);
      if (!opt) throw new Error(`No option "${v}"`);
      el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      break;
    }
    default: {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) setNativeValue(el, String(value));
      else if (el instanceof HTMLElement && el.isContentEditable) {
        el.textContent = String(value);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
      } else throw new Error(`Not a fillable field: <${el.tagName.toLowerCase()}>`);
    }
  }
  return { kind };
}
