import { describe, expect, it, vi } from 'vitest';
import {
  AudioPreRollBuffer,
  processAudioFrame,
  shouldBlockAudioFrame,
  SPEAKING_ECHO_GUARD_MS,
} from './audioFrame';
import { EnergyVad } from './vad';
import { SpeechQueue, type TtsAdapter } from './ttsAdapters';
import { mergeVoicePreferences } from '../../hooks/useJarvisVoice';

function frame(amplitude: number): Float32Array {
  return new Float32Array(20).fill(amplitude);
}

describe('M.E.G.A. audio frame routing', () => {
  it('does not drop audio in the processing guard while M.E.G.A. is speaking', () => {
    expect(shouldBlockAudioFrame('speaking', true)).toBe(false);
    expect(shouldBlockAudioFrame('hearing', true)).toBe(false);
    expect(shouldBlockAudioFrame('thinking', true)).toBe(true);
  });

  it('keeps the first speaking frames in a bounded pre-roll buffer', () => {
    const preRoll = new AudioPreRollBuffer();
    preRoll.push(frame(0.01), 60);
    preRoll.push(frame(0.02), 60);
    preRoll.push(frame(0.03), 60);
    preRoll.push(frame(0.04), 60);

    expect(preRoll.sampleCount).toBe(60);
    expect(preRoll.snapshot().map((chunk) => Number(chunk[0].toFixed(2))))
      .toEqual([0.02, 0.03, 0.04]);
    expect(preRoll.hasAboveThreshold(0.035)).toBe(true);
  });

  it('detects speaking voice through the shared frame handler, cancels TTS and dispatches transcription', async () => {
    let finishTts: (() => void) | null = null;
    const adapter: TtsAdapter = {
      speak: vi.fn(() => new Promise<void>((resolve) => {
        finishTts = resolve;
      })),
      cancel: vi.fn(() => finishTts?.()),
      subscribe: vi.fn(() => () => undefined),
    };
    const queue = new SpeechQueue(adapter, () => ({ speed: 1 }));
    queue.enqueue('Resposta atual.');
    await vi.waitFor(() => expect(adapter.speak).toHaveBeenCalledOnce());

    const vad = new EnergyVad();
    const transcription = vi.fn();
    let state: 'speaking' | 'hearing' | 'transcribing' = 'speaking';
    const captured: Float32Array[] = [];
    let started = false;
    const process = (samples: Float32Array, elapsedSinceTtsStartMs: number) => {
      const result = processAudioFrame(vad, samples, 1_000, {
        state,
        allowVoiceInterruption: true,
        sensitivity: 0.5,
        elapsedSinceTtsStartMs,
      });
      if (result.disposition !== 'sent-to-vad') return result;
      if (result.event === 'speech-start' && state === 'speaking') {
        started = true;
        state = 'hearing';
        queue.park();
      } else if (result.event === 'speech-end') {
        state = 'transcribing';
        transcription(captured);
      }
      if (started && state !== 'transcribing') captured.push(samples.slice());
      return result;
    };

    for (let index = 0; index < 12; index += 1) {
      process(frame(0.02), SPEAKING_ECHO_GUARD_MS + 100);
    }
    for (let index = 0; index < 20; index += 1) process(frame(0.02), 1_000);
    let speechEnded = false;
    for (let index = 0; index < 50; index += 1) {
      if (process(frame(0.001), 1_000).event === 'speech-end') speechEnded = true;
    }

    await queue.whenIdle();
    expect(adapter.cancel).toHaveBeenCalled();
    expect(state).toBe('transcribing');
    expect(transcription).toHaveBeenCalledOnce();
    expect(captured.length).toBeGreaterThan(0);
    expect(speechEnded).toBe(true);
  });

  it('continues VAD processing when speech crosses the TTS-to-idle transition', () => {
    const vad = new EnergyVad();
    let state: 'speaking' | 'hearing' | 'idle' = 'speaking';
    let started = false;

    for (let index = 0; index < 10; index += 1) {
      const result = processAudioFrame(vad, frame(0.02), 1_000, {
        state,
        allowVoiceInterruption: true,
        sensitivity: 0.5,
        elapsedSinceTtsStartMs: 1_000,
      });
      if (result.event === 'speech-start') {
        state = 'hearing';
        started = true;
      }
    }
    expect(started).toBe(true);

    state = 'idle';
    for (let index = 0; index < 20; index += 1) {
      processAudioFrame(vad, frame(0.02), 1_000, {
        state,
        allowVoiceInterruption: true,
        sensitivity: 0.5,
        elapsedSinceTtsStartMs: 2_000,
      });
    }
    let speechEnded = false;
    for (let index = 0; index < 50; index += 1) {
      const result = processAudioFrame(vad, frame(0.001), 1_000, {
        state,
        allowVoiceInterruption: true,
        sensitivity: 0.5,
        elapsedSinceTtsStartMs: 2_000,
      });
      if (result.event === 'speech-end') speechEnded = true;
    }

    expect(speechEnded).toBe(true);
  });

  it('uses an ambient-noise-relative speaking threshold within safe bounds', () => {
    const quiet = new EnergyVad();
    const noisy = new EnergyVad();
    const quietThreshold = quiet.speakingThresholdFor(0.5);
    for (let index = 0; index < 100; index += 1) noisy.process(0.005, 20, { sensitivity: 0.5 });
    const noiseAdjustedThreshold = noisy.speakingThresholdFor(0.5);

    expect(quietThreshold).toBeGreaterThan(quiet.thresholdFor(0.5));
    expect(noiseAdjustedThreshold).toBeGreaterThan(quietThreshold);
    expect(noiseAdjustedThreshold).toBeLessThanOrEqual(0.024);
  });

  it('enables interruption for older saved preferences without the new option', () => {
    expect(mergeVoicePreferences({ sensitivity: 0.5 }).allowVoiceInterruption).toBe(true);
    expect(mergeVoicePreferences({ allowVoiceInterruption: false }).allowVoiceInterruption).toBe(false);
    expect(mergeVoicePreferences({ wakeWord: true }).allowLegacyWakeWordAlias).toBe(false);
    expect(mergeVoicePreferences({ allowLegacyWakeWordAlias: true }).allowLegacyWakeWordAlias).toBe(true);
  });
});
