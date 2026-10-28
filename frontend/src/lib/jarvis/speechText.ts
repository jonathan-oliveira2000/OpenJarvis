const CODE_BLOCK = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g;
const EMOJI_OR_SYMBOL = /[\p{Extended_Pictographic}\p{S}]/gu;
const MEGA_NAME = /\bM\s*\.?\s*E\s*\.?\s*G\s*\.?\s*A\s*\.?(?![\p{L}\p{N}])/giu;

export const INITIAL_CLAUSE_MIN_CHARS = 48;
export const MIN_SPEECH_FRAGMENT_CHARS = 20;

export function toSpeechText(text: string): string {
  return text
    .replace(CODE_BLOCK, 'O código está na tela de chat.')
    .replace(MEGA_NAME, 'Mega')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, '')
    .replace(/<https?:\/\/[^>]+>/gi, '')
    .replace(/https?:\/\/\S+|www\.\S+/gi, '')
    .replace(/^\s{0,3}(?:#{1,6}\s*|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/(`{1,2})(.*?)\1/g, '$2')
    .replace(/(\*\*|__)(.*?)\1|(\*|_)(.*?)\3|~~(.*?)~~/g, '$2$4$5')
    .replace(/<[^>]*>/g, '')
    .replace(EMOJI_OR_SYMBOL, ' ')
    .replace(/[^\p{L}\p{N}\s.,!?;:'"()[\]{}%\-]/gu, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/([.,!?;:])(?=\S)(?!\d)/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function splitSentences(text: string): string[] {
  const normalized = toSpeechText(text);
  if (!normalized) return [];
  return normalized.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
}

export function takeCompleteSentences(text: string): { sentences: string[]; remainder: string } {
  const openingFence = text.indexOf('```');
  const closingFence = openingFence >= 0 ? text.indexOf('```', openingFence + 3) : -1;
  const openingTilde = text.indexOf('~~~');
  const closingTilde = openingTilde >= 0 ? text.indexOf('~~~', openingTilde + 3) : -1;
  const openFence = openingFence >= 0 && closingFence < 0
    ? openingFence
    : openingTilde >= 0 && closingTilde < 0
      ? openingTilde
      : -1;
  const processable = openFence < 0 ? text : text.slice(0, openFence);
  const withheld = openFence < 0 ? '' : text.slice(openFence);
  const normalized = toSpeechText(processable);
  const matches = normalized.match(/[^.!?]+[.!?]+(?:["')\]]*)/g) ?? [];
  const complete = matches.map((sentence) => sentence.trim()).filter(Boolean);
  const sentences: string[] = [];
  let shortFragment = '';
  for (const sentence of complete) {
    const combined = shortFragment ? `${shortFragment} ${sentence}` : sentence;
    if (combined.length < MIN_SPEECH_FRAGMENT_CHARS) {
      shortFragment = combined;
      continue;
    }
    sentences.push(combined);
    shortFragment = '';
  }
  const unprocessed = `${normalized.slice(matches.join('').length).trim()}${withheld}`;
  const remainder = [
    shortFragment,
    unprocessed,
  ].filter(Boolean).join(' ');
  return { sentences, remainder };
}

export function takeInitialClause(
  text: string,
  minChars = INITIAL_CLAUSE_MIN_CHARS,
): { clause: string | null; remainder: string } {
  const normalized = toSpeechText(text);
  for (let index = 0; index < normalized.length; index += 1) {
    const punctuation = normalized[index];
    if (punctuation !== ',' && punctuation !== ';' && punctuation !== ':') continue;

    const previous = normalized[index - 1] ?? '';
    const next = normalized[index + 1] ?? '';
    if (/\d/u.test(previous) && /\d/u.test(next)) continue;

    const clause = normalized.slice(0, index + 1).trim();
    if (clause.length < minChars) continue;
    if (/(?:\b(?:dr|dra|sr|sra|srta|prof|profa|p|ex|etc)\.)$/iu.test(clause.slice(0, -1).trim())) {
      continue;
    }

    return {
      clause,
      remainder: normalized.slice(index + 1).trim(),
    };
  }
  return { clause: null, remainder: normalized };
}

export function removeActivationWord(
  text: string,
  options: { allowLegacyAlias?: boolean } = {},
): string | null {
  let normalized = '';
  const originalOffsets: number[] = [];
  let originalOffset = 0;
  for (const character of text) {
    originalOffset += character.length;
    const plain = character.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('pt-BR');
    normalized += plain;
    for (let index = 0; index < plain.length; index += 1) originalOffsets.push(originalOffset);
  }
  const activationPattern = options.allowLegacyAlias
    ? /^\s*(?:(?:ei|oi|e\s+ai|ok)\s+)?(?:mega|megah|jarvis)\b[\s,:;.!?—-]*/u
    : /^\s*(?:(?:ei|oi|e\s+ai|ok)\s+)?(?:mega|megah)\b[\s,:;.!?—-]*/u;
  const match = normalized.match(activationPattern);
  if (!match) return null;
  if (/^(?:sena|promocao|byte|bytes)\b/u.test(normalized.slice(match[0].length).trimStart())) return null;
  const originalEnd = originalOffsets[match[0].length - 1] ?? 0;
  return text.slice(originalEnd).trim();
}
