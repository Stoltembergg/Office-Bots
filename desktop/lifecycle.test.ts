import { describe, expect, it, vi } from 'vitest';
import { createBeforeQuitHandler } from './lifecycle';

describe('desktop quit lifecycle', () => {
  it('keeps repeated quit requests blocked until cleanup completes', async () => {
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    const stop = vi.fn(() => cleanup);
    const quit = vi.fn();
    const handler = createBeforeQuitHandler(stop, quit);
    const firstEvent = { preventDefault: vi.fn() };
    const repeatedEvent = { preventDefault: vi.fn() };
    const finalEvent = { preventDefault: vi.fn() };

    const shutdown = handler(firstEvent);
    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    handler(repeatedEvent);
    expect(repeatedEvent.preventDefault).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();

    finishCleanup();
    await shutdown;
    expect(quit).toHaveBeenCalledOnce();
    expect(handler(finalEvent)).toBeUndefined();
    expect(finalEvent.preventDefault).not.toHaveBeenCalled();
  });

  it('quits after cleanup reports an error', async () => {
    const error = new Error('cleanup failed');
    const onError = vi.fn();
    const quit = vi.fn();
    const handler = createBeforeQuitHandler(async () => { throw error; }, quit, onError);

    await handler({ preventDefault: vi.fn() });

    expect(onError).toHaveBeenCalledWith(error);
    expect(quit).toHaveBeenCalledOnce();
  });
});
