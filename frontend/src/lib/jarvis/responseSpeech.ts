import { removeActivationWord, toSpeechText } from './speechText';
import type { SpeechQueue } from './ttsAdapters';

export function getFinalResponseSpeech(response: string, pendingSpeech: string): string {
  return pendingSpeech || (!response ? 'Não consegui gerar uma resposta.' : '');
}

export type InterruptionIntent =
  | { type: 'echo' | 'noise' | 'stop' | 'resume' | 'question'; count?: never }
  | { type: 'repeat'; count: number };

const RESUME_COMMAND =
  /^(?:(?:desculpa|sinto muito)[, ]+)?(?:pode\s+)?(?:continuar|continue|continua|prossiga|prosseguir|segue|seguir|retome|retoma|terminar)(?:\s+(?:com|de onde parou|o que voce estava dizendo|ao que voce falava).*)?$|^(?:como voce estava dizendo|voltando ao que voce falava)$/u;
const RETRACTION_RESUME =
  /\b(?:quer dizer|deixa pra la|esquece isso|na verdade nao)\b.*\b(?:continuar|continue|continua|prossiga|prosseguir|retome|retoma|segue|seguir)\b/u;
const STOP_COMMAND =
  /^(?:(?:por favor)\s+)?(?:para|pare|chega|silencio|fica quieto|fique quieto)(?:\s+por favor)?$/u;
const FILLER = /^(?:h+m+|a+|e+|eh+|ahn+|hum+|uh+|tosse|ruido)$/u;

function normalizeIntentText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenOverlap(left: string, right: string): number {
  const leftWords = new Set(left.split(' ').filter((word) => word.length > 1));
  const rightWords = new Set(right.split(' ').filter((word) => word.length > 1));
  if (leftWords.size === 0 || rightWords.size === 0) return 0;
  const shared = [...leftWords].filter((word) => rightWords.has(word)).length;
  return shared >= 3 && shared / Math.min(leftWords.size, rightWords.size) >= 0.72 ? 1 : 0;
}

export function classifyInterruption(
  text: string,
  currentlySpokenText = '',
  options: { allowLegacyAlias?: boolean } = {},
): InterruptionIntent {
  const activationText = removeActivationWord(text, options);
  const normalized = normalizeIntentText(activationText ?? text);
  if (!normalized || normalized.length < 2 || FILLER.test(normalized)) return { type: 'noise' };

  const spoken = normalizeIntentText(currentlySpokenText);
  if (spoken && (normalized === spoken || tokenOverlap(normalized, spoken) >= 0.72)) {
    return { type: 'echo' };
  }

  if (STOP_COMMAND.test(normalized)) return { type: 'stop' };

  const repetitionCount = getRepetitionCount(activationText ?? text);
  if (repetitionCount !== null) return { type: 'repeat', count: repetitionCount };

  if (
    RESUME_COMMAND.test(normalized) ||
    RETRACTION_RESUME.test(normalized)
  ) return { type: 'resume' };

  return { type: 'question' };
}

const NUMBER_WORDS: Record<string, number> = {
  uma: 1,
  duas: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
};

export function getRepetitionCount(text: string): number | null {
  const normalized = normalizeIntentText(text);

  if (/\bnao\s+(?:precisa|quero|va|deve)\s+repet\w*/u.test(normalized)) return null;

  const request = normalized
    .replace(/^(?:(?:por favor|pode|poderia|voce pode|voce poderia)(?: por favor)?|quero que voce|nao entendi)\s+/u, '')
    .replace(/\s+por favor$/u, '')
    .replace(/\s+(?:\d+|uma|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)\s+vez(?:es)?$/u, '');
  const isRepeatRequest =
    /^(?:repita|repete|repetir)(?:\s+(?:isso|a resposta|a ultima resposta))?$/u.test(request) ||
    /^(?:fala|fale|diga)\s+(?:isso\s+)?(?:de novo|novamente)$/u.test(request);

  if (!isRepeatRequest) return null;

  const countMatch = normalized.match(/\b(\d+|uma|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)\s+vez(?:es)?\b/u);
  if (!countMatch) return 1;

  const requested = Number(countMatch[1]) || NUMBER_WORDS[countMatch[1]] || 1;
  return Math.min(10, Math.max(1, requested));
}

export class JarvisResponseSpeaker {
  private activeResponseId: string | null = null;
  private completedResponseId: string | null = null;
  private spokenUtteranceIds = new Set<string>();
  private lastSpokenResponse: string | null = null;
  private activeResponseText = '';
  private readonly parkedResponses: Array<{
    responseId: string;
    utterances: string[];
    fullText: string;
    complete: boolean;
    parkedAt: number;
  }> = [];
  private resumeSequence = 0;

  private static readonly MAX_PARKED_RESPONSES = 3;
  private static readonly PARKED_RESPONSE_TTL_MS = 2 * 60 * 1000;

  constructor(private readonly queue: SpeechQueue) {}

  speakResponse(text: string, responseId: string, utteranceId = responseId): boolean {
    const parked = this.parkedResponses.find((response) => response.responseId === responseId);
    if (parked) {
      if (!this.spokenUtteranceIds.has(utteranceId)) {
        this.spokenUtteranceIds.add(utteranceId);
        parked.utterances.push(toSpeechText(text));
      }
      return true;
    }
    if (responseId === this.completedResponseId) return false;
    if (responseId === this.activeResponseId && this.spokenUtteranceIds.has(utteranceId)) {
      return false;
    }

    if (responseId !== this.activeResponseId) {
      this.queue.clear();
      this.activeResponseId = responseId;
      this.spokenUtteranceIds.clear();
      this.activeResponseText = '';
    }

    if (!this.activeResponseText) this.activeResponseText = toSpeechText(text);
    this.spokenUtteranceIds.add(utteranceId);
    this.queue.enqueue(text);
    return true;
  }

  updateResponseText(responseId: string, fullText: string): void {
    const parked = this.parkedResponses.find((response) => response.responseId === responseId);
    if (parked) {
      parked.fullText = fullText;
    } else if (this.activeResponseId === responseId) {
      this.activeResponseText = fullText;
    }
  }

  get currentSpeechText(): string {
    return this.queue.currentText ?? '';
  }

  isParkedResponse(responseId: string): boolean {
    this.pruneParkedResponses();
    return this.parkedResponses.some((response) => response.responseId === responseId);
  }

  isActiveResponse(responseId: string): boolean {
    return this.activeResponseId === responseId;
  }

  get latestParkedResponseText(): string {
    this.pruneParkedResponses();
    return this.parkedResponses[this.parkedResponses.length - 1]?.fullText ?? '';
  }

  get hasParkedResponse(): boolean {
    this.pruneParkedResponses();
    return this.parkedResponses.length > 0;
  }

  parkCurrentResponse(): boolean {
    const responseId = this.activeResponseId;
    if (!responseId) return this.parkedResponses.length > 0;

    this.pruneParkedResponses();
    const utterances = this.queue.park();
    const existingIndex = this.parkedResponses.findIndex((response) => response.responseId === responseId);
    if (existingIndex >= 0) this.parkedResponses.splice(existingIndex, 1);
    this.parkedResponses.push({
      responseId,
      utterances,
      fullText: this.activeResponseText,
      complete: false,
      parkedAt: Date.now(),
    });
    while (this.parkedResponses.length > JarvisResponseSpeaker.MAX_PARKED_RESPONSES) {
      this.parkedResponses.shift();
    }

    this.activeResponseId = null;
    this.spokenUtteranceIds.clear();
    return true;
  }

  resumeLatest(): { responseId: string; fullText: string; complete: boolean } | null {
    this.pruneParkedResponses();
    const parked = this.parkedResponses.pop();
    if (!parked) return null;

    this.activeResponseId = parked.responseId;
    this.activeResponseText = parked.fullText;
    this.spokenUtteranceIds.clear();
    for (const text of parked.utterances) {
      const utteranceId = `${parked.responseId}:resume:${this.resumeSequence++}`;
      this.spokenUtteranceIds.add(utteranceId);
      this.queue.enqueue(text);
    }
    return {
      responseId: parked.responseId,
      fullText: parked.fullText,
      complete: parked.complete,
    };
  }

  finalizeLatestParkedResponse(): void {
    this.pruneParkedResponses();
    const parked = this.parkedResponses[this.parkedResponses.length - 1];
    if (!parked) return;
    parked.complete = true;
  }

  completeResponse(responseId: string, text: string): void {
    const parked = this.parkedResponses.find((response) => response.responseId === responseId);
    if (parked) {
      parked.complete = true;
      parked.fullText = text;
      return;
    }
    if (this.activeResponseId !== responseId) return;
    this.lastSpokenResponse = toSpeechText(text) || null;
    this.completedResponseId = responseId;
    this.activeResponseId = null;
    this.spokenUtteranceIds.clear();
    this.activeResponseText = '';
  }

  repeatLastResponse(responseId: string, count: number): string | null {
    const text = this.activeResponseText || this.lastSpokenResponse || this.latestParkedResponseText;
    if (!text) return null;

    this.queue.clear();
    this.activeResponseId = null;
    this.spokenUtteranceIds.clear();
    for (let index = 0; index < count; index += 1) {
      this.speakResponse(text, responseId, `${responseId}:repeat:${index}`);
    }
    return text;
  }

  cancel(): void {
    this.queue.clear();
    this.activeResponseId = null;
    this.spokenUtteranceIds.clear();
    this.activeResponseText = '';
    this.parkedResponses.length = 0;
  }

  private pruneParkedResponses(): void {
    const expiredBefore = Date.now() - JarvisResponseSpeaker.PARKED_RESPONSE_TTL_MS;
    for (let index = this.parkedResponses.length - 1; index >= 0; index -= 1) {
      if (this.parkedResponses[index].parkedAt < expiredBefore) {
        this.parkedResponses.splice(index, 1);
      }
    }
  }
}
