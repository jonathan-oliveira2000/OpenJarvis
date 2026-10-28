import { describe, expect, it, vi } from 'vitest';
import { synthesizeSpeech } from '../api';
import {
  createTtsAdapter,
  SERVER_TTS_PREFETCH_LIMIT,
  SpeechQueue,
  type TtsAdapter,
  type TtsEvent,
} from './ttsAdapters';

vi.mock('../api', () => ({ synthesizeSpeech: vi.fn() }));

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

describe('M.E.G.A TTS sentence queue', () => {
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
    queue.enqueue('M.E.G.A está pronta. MEGA!');
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

  it('prefetches only the next utterance while the current one is playing', async () => {
    const listeners = new Set<(event: TtsEvent) => void>();
    const spoken: string[] = [];
    const prefetched: string[] = [];
    let finishFirst: () => void = () => {};
    const emit = (event: TtsEvent) => listeners.forEach((listener) => listener(event));
    const adapter: TtsAdapter = {
      speak: vi.fn(async (text) => {
        spoken.push(text);
        emit({ type: 'start' });
        if (text === 'Primeira.') {
          await new Promise<void>((resolve) => {
            finishFirst = resolve;
          });
        }
        emit({ type: 'end' });
      }),
      prefetch: vi.fn((text) => prefetched.push(text)),
      cancel: vi.fn(() => emit({ type: 'end' })),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const queue = new SpeechQueue(adapter, () => ({ speed: 1 }));

    queue.enqueue('Primeira.');
    queue.enqueue('Segunda.');
    queue.enqueue('Terceira.');
    expect(SERVER_TTS_PREFETCH_LIMIT).toBe(1);
    expect(prefetched).toEqual(['Segunda.']);

    finishFirst();
    await queue.whenIdle();
    expect(prefetched).toEqual(['Segunda.', 'Terceira.']);
    expect(spoken).toEqual(['Primeira.', 'Segunda.', 'Terceira.']);
    queue.dispose();
  });

  it('aborts and discards prefetched server synthesis when cancelled', () => {
    const synthesize = vi.mocked(synthesizeSpeech);
    let firstSignal: AbortSignal | undefined;
    synthesize.mockImplementation((_text, options) => {
      if (!firstSignal) {
        firstSignal = options?.signal;
        return new Promise<Blob>((_resolve, reject) => {
          firstSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      }
      return Promise.resolve(new Blob(['audio']));
    });

    const adapter = createTtsAdapter('server');
    const options = { speed: 1, utteranceId: 'next-phrase' };
    adapter.prefetch?.('Próxima frase.', options);
    expect(synthesize).toHaveBeenCalledTimes(1);

    adapter.cancel();
    expect(firstSignal?.aborted).toBe(true);

    adapter.prefetch?.('Próxima frase.', options);
    expect(synthesize).toHaveBeenCalledTimes(2);
    adapter.cancel();
    synthesize.mockReset();
  });
});
