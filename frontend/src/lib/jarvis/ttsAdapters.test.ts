import { describe, expect, it, vi } from 'vitest';
import { SpeechQueue, type TtsAdapter, type TtsEvent } from './ttsAdapters';

function makeFakeAdapter() {
  const spoken: string[] = [];
  const listeners = new Set<(event: TtsEvent) => void>();
  const adapter: TtsAdapter = {
    speak: async (text) => {
      spoken.push(text);
      listeners.forEach((listener) => listener({ type: 'start' }));
    },
    cancel: vi.fn(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { adapter, spoken };
}

describe('M.E.G.A. TTS sentence queue', () => {
  it('speaks queued sentences serially through the common adapter interface', async () => {
    const { adapter, spoken } = makeFakeAdapter();
    const queue = new SpeechQueue(adapter, () => ({ speed: 1 }));
    queue.enqueue('Primeira frase.');
    queue.enqueue('Segunda frase.');
    await queue.whenIdle();
    expect(spoken).toEqual(['Primeira frase.', 'Segunda frase.']);
  });

  it('passes the spoken name to the adapter as Mega, never as spelled letters', async () => {
    const { adapter, spoken } = makeFakeAdapter();
    const queue = new SpeechQueue(adapter, () => ({ speed: 1 }));
    queue.enqueue('M.E.G.A. está pronta. MEGA!');
    await queue.whenIdle();
    expect(spoken).toEqual(['Mega está pronta. Mega!']);
  });

  it('clears pending speech and cancels the active adapter', () => {
    const { adapter } = makeFakeAdapter();
    const queue = new SpeechQueue(adapter, () => ({ speed: 1 }));
    queue.enqueue('Interromper.');
    queue.clear();
    expect(adapter.cancel).toHaveBeenCalledOnce();
  });
});
