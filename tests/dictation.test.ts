import { describe, expect, it } from 'vitest';
import { nativeBridge, withSpoken } from '../app/dictation';

describe('dictation in the iPhone app', () => {
  it('puts the spoken words after the draft, one space between', () => {
    expect(withSpoken('', 'hello there')).toBe('hello there');
    expect(withSpoken('Look:', 'the map')).toBe('Look: the map');
    expect(withSpoken('Look:\n', 'the map')).toBe('Look:\nthe map');
    expect(withSpoken('Look: ', '  the map ')).toBe('Look: the map');
    expect(withSpoken('kept', '   ')).toBe('kept');
  });

  it('finds the bridge only inside the app', () => {
    const bridge = { postMessage: () => {} };
    expect(nativeBridge({ webkit: { messageHandlers: { trialog: bridge } } })).toBe(bridge);
    expect(nativeBridge({ webkit: { messageHandlers: {} } })).toBeNull();
    expect(nativeBridge({})).toBeNull();
    expect(nativeBridge(undefined)).toBeNull();
  });
});
