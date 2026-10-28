import { describe, expect, it, vi } from 'vitest';
import {
  classifyInterruption,
  getFinalResponseSpeech,
  JarvisResponseSpeaker,
  getRepetitionCount,
} from './responseSpeech';
import { SpeechQueue, type TtsAdapter, type TtsEvent } from './ttsAdapters';

function createSpeaker() {
  const spoken: string[] = [];
  const listeners = new Set<(event: TtsEvent) => void>();
  const adapter: TtsAdapter = {
    speak: vi.fn(async (text: string) => {
      spoken.push(text);
    }),
    cancel: vi.fn(),
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  const queue = new SpeechQueue(adapter, () => ({ speed: 1 }));
  return { speaker: new JarvisResponseSpeaker(queue), queue, adapter, spoken };
}

describe('Jarvis response speech', () => {
  it('does not re-enqueue the full response when all sentences streamed already', () => {
    expect(getFinalResponseSpeech('Resposta única.', '')).toBe('');
    expect(getFinalResponseSpeech('Primeira. Segunda.', '')).toBe('');
    expect(getFinalResponseSpeech('Primeira.', 'Segunda sem pontuação'))
      .toBe('Segunda sem pontuação');
    expect(getFinalResponseSpeech('', '')).toBe('Não consegui gerar uma resposta.');
  });

  it('speaks each streamed sentence once and ignores a duplicate utterance id', async () => {
    const { speaker, queue, spoken } = createSpeaker();

    expect(speaker.speakResponse('Primeira frase.', 'response-1', 'response-1:0')).toBe(true);
    expect(speaker.speakResponse('Primeira frase.', 'response-1', 'response-1:0')).toBe(false);
    expect(speaker.speakResponse('Segunda frase.', 'response-1', 'response-1:1')).toBe(true);

    await queue.whenIdle();
    expect(spoken).toEqual(['Primeira frase.', 'Segunda frase.']);
  });

  it('cancels speech from a previous response before starting a new one', async () => {
    const spoken: string[] = [];
    let activeCount = 0;
    let maxActiveCount = 0;
    const controls: {
      cancelActive?: () => void;
      startNewSpeech?: () => void;
      finishNewSpeech?: () => void;
    } = {};
    const adapter: TtsAdapter = {
      speak: vi.fn((text) => new Promise<void>((resolve) => {
        activeCount += 1;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        let cancelled = false;
        const finish = () => {
          activeCount -= 1;
          if (!cancelled) spoken.push(text);
          resolve();
        };
        if (text === 'Resposta anterior.') {
          controls.cancelActive = () => {
            cancelled = true;
            finish();
          };
        } else {
          controls.startNewSpeech?.();
          controls.finishNewSpeech = finish;
        }
      })),
      cancel: vi.fn(() => controls.cancelActive?.()),
      subscribe: vi.fn(() => () => undefined),
    };
    const queue = new SpeechQueue(adapter, () => ({ speed: 1 }));
    const speaker = new JarvisResponseSpeaker(queue);
    const newSpeechStarted = new Promise<void>((resolve) => {
      controls.startNewSpeech = resolve;
    });

    speaker.speakResponse('Resposta anterior.', 'response-1');
    speaker.speakResponse('Nova resposta.', 'response-2');
    await newSpeechStarted;
    controls.finishNewSpeech?.();
    await queue.whenIdle();

    expect(adapter.cancel).toHaveBeenCalledTimes(2);
    expect(maxActiveCount).toBe(1);
    expect(spoken).toEqual(['Nova resposta.']);
  });

  it('replays the last completed response the requested number of times', async () => {
    const { speaker, queue, spoken } = createSpeaker();

    speaker.speakResponse('Resposta original.', 'response-1');
    await queue.whenIdle();
    speaker.completeResponse('response-1', 'Resposta original.');

    expect(speaker.repeatLastResponse('repeat-1', 2)).toBe('Resposta original.');
    await queue.whenIdle();
    speaker.completeResponse('repeat-1', 'Resposta original.');

    expect(spoken).toEqual([
      'Resposta original.',
      'Resposta original.',
      'Resposta original.',
    ]);
  });

  it('speaks three consecutive responses once each', async () => {
    const { speaker, queue, spoken } = createSpeaker();

    for (let index = 1; index <= 3; index += 1) {
      const responseId = `response-${index}`;
      const response = `Resposta ${index}.`;
      speaker.speakResponse(response, responseId);
      await queue.whenIdle();
      speaker.completeResponse(responseId, response);
    }

    expect(spoken).toEqual(['Resposta 1.', 'Resposta 2.', 'Resposta 3.']);
  });

  it('does not replay a response that has not been completed', () => {
    const { speaker } = createSpeaker();

    expect(speaker.repeatLastResponse('repeat-1', 1)).toBeNull();
  });

  it('parks the interrupted phrase and buffers new sentences until resumed', async () => {
    const { speaker, queue, spoken } = createSpeaker();

    speaker.speakResponse('Frase que estava falando.', 'response-park', 'response-park:0');
    speaker.speakResponse('Frase que ainda estava na fila.', 'response-park', 'response-park:1');
    expect(speaker.parkCurrentResponse()).toBe(true);
    speaker.updateResponseText('response-park', 'Frase que estava falando. Frase nova.');
    speaker.speakResponse('Frase nova.', 'response-park', 'response-park:2');
    expect(spoken).toEqual(['Frase que estava falando.']);

    await queue.whenIdle();
    const resumed = speaker.resumeLatest();
    expect(resumed).toEqual({
      responseId: 'response-park',
      fullText: 'Frase que estava falando. Frase nova.',
      complete: false,
    });
    await queue.whenIdle();
    speaker.completeResponse('response-park', resumed?.fullText ?? '');

    expect(spoken).toEqual([
      'Frase que estava falando.',
      'Frase que estava falando.',
      'Frase que ainda estava na fila.',
      'Frase nova.',
    ]);
  });

  it('keeps an interrupted response parked when another response starts', async () => {
    const { speaker, queue, spoken } = createSpeaker();
    speaker.speakResponse('Resposta interrompida.', 'parked-1');
    speaker.parkCurrentResponse();
    await queue.whenIdle();

    speaker.speakResponse('Resposta nova.', 'new-2');
    await queue.whenIdle();
    speaker.completeResponse('new-2', 'Resposta nova.');

    const resumed = speaker.resumeLatest();
    expect(resumed?.responseId).toBe('parked-1');
    await queue.whenIdle();
    expect(spoken).toEqual(['Resposta interrompida.', 'Resposta nova.', 'Resposta interrompida.']);
  });

  it('does not replace the latest spoken response when an older parked stream finishes later', async () => {
    const { speaker, queue, spoken } = createSpeaker();
    speaker.speakResponse('Resposta antiga interrompida.', 'old-response');
    speaker.parkCurrentResponse();
    await queue.whenIdle();

    speaker.speakResponse('Resposta nova completa.', 'new-response');
    await queue.whenIdle();
    speaker.completeResponse('new-response', 'Resposta nova completa.');
    speaker.completeResponse('old-response', 'Resposta antiga completa.');

    expect(speaker.repeatLastResponse('repeat-new', 1)).toBe('Resposta nova completa.');
    await queue.whenIdle();
    expect(spoken).toEqual([
      'Resposta antiga interrompida.',
      'Resposta nova completa.',
      'Resposta nova completa.',
    ]);
  });

  it('retains only the three newest parked responses and expires them after two minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const { speaker, queue } = createSpeaker();
      for (let index = 1; index <= 4; index += 1) {
        speaker.speakResponse(`Resposta ${index}.`, `parked-${index}`);
        speaker.parkCurrentResponse();
        await queue.whenIdle();
        vi.setSystemTime(index * 1000);
      }

      expect(speaker.resumeLatest()?.responseId).toBe('parked-4');
      speaker.cancel();

      const expiring = createSpeaker();
      expiring.speaker.speakResponse('Resposta temporária.', 'temporary');
      expiring.speaker.parkCurrentResponse();
      await expiring.queue.whenIdle();
      vi.setSystemTime(125_000);
      expect(expiring.speaker.hasParkedResponse).toBe(false);
      expect(expiring.speaker.resumeLatest()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('classifyInterruption', () => {
  it.each([
    'continue',
    'continua de onde parou',
    'pode prosseguir',
    'pode seguir',
    'desculpa, continua',
    'sinto muito, prossiga com o tempo',
    'Mega, que horas são, quer dizer, esquece isso, prossiga com o tempo',
    'como você estava dizendo',
    'voltando ao que você falava',
  ])('recognizes resume command: %s', (text) => {
    expect(classifyInterruption(text).type).toBe('resume');
  });

  it.each(['para', 'pare', 'chega', 'silêncio', 'fica quieto'])(
    'recognizes stop command: %s',
    (text) => expect(classifyInterruption(text).type).toBe('stop'),
  );

  it('classifies filler and matching speech as noise and echo', () => {
    expect(classifyInterruption('hm').type).toBe('noise');
    expect(classifyInterruption('A previsão do tempo é sol hoje.', 'A previsão do tempo é sol hoje.').type)
      .toBe('echo');
    expect(classifyInterruption('Que horas são agora?', 'A previsão do tempo para hoje é ensolarado.').type)
      .toBe('question');
  });

  it('does not mistake an ordinary question about continuing for a resume command', () => {
    expect(classifyInterruption('Como faço para continuar uma série no Netflix?').type).toBe('question');
  });

  it('recognizes M.E.G.A. interruption commands and only accepts the prior name when enabled', () => {
    expect(classifyInterruption('Mega pare').type).toBe('stop');
    expect(classifyInterruption('Jarvis pare').type).toBe('question');
    expect(classifyInterruption('Jarvis pare', '', { allowLegacyAlias: true }).type).toBe('stop');
  });
});

describe('getRepetitionCount', () => {
  it.each([
    ['repita', 1],
    ['repete isso', 1],
    ['fala de novo', 1],
    ['diga novamente', 1],
    ['não entendi, repete', 1],
    ['pode repetir?', 1],
    ['repita 2 vezes', 2],
    ['pode repetir 2 vezes, por favor', 2],
    ['repete três vezes', 3],
    ['repita 20 vezes', 10],
  ])('recognizes %s', (text, expected) => {
    expect(getRepetitionCount(text)).toBe(expected);
  });

  it('does not treat unrelated or negated requests as a replay command', () => {
    expect(getRepetitionCount('O que significa repetir?')).toBeNull();
    expect(getRepetitionCount('Não repita isso')).toBeNull();
  });
});
