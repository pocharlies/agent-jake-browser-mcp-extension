import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findElement } from '@/content/selector';
import { handleFillField } from '@/content/form-actions';

vi.mock('@/content/selector', () => ({ findElement: vi.fn() }));

class FakeElement {
  focus = vi.fn();
  click = vi.fn();
  getAttribute(name: string): string | null { return name === 'type' ? 'radio' : null; }
}

class FakeInput extends FakeElement {
  checked = true;
}

beforeEach(() => {
  vi.stubGlobal('HTMLElement', FakeElement);
  vi.stubGlobal('HTMLInputElement', FakeInput);
  vi.stubGlobal('HTMLSelectElement', class {});
});

afterEach(() => vi.unstubAllGlobals());

describe('radio fill', () => {
  it('rejects unchecking a selected radio instead of reporting success', async () => {
    const radio = new FakeInput();
    vi.mocked(findElement).mockResolvedValue(radio as unknown as Element);

    await expect(handleFillField({ selector: '#selected', value: false })).rejects.toThrow('cannot be unchecked');
    expect(radio.click).not.toHaveBeenCalled();
    expect(radio.checked).toBe(true);
  });

  it('accepts false when the radio is already unselected', async () => {
    const radio = new FakeInput();
    radio.checked = false;
    vi.mocked(findElement).mockResolvedValue(radio as unknown as Element);

    await expect(handleFillField({ selector: '#other', value: false })).resolves.toEqual({ kind: 'radio' });
    expect(radio.click).not.toHaveBeenCalled();
  });
});
