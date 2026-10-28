const CODE_BLOCK = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g;
const EMOJI_OR_SYMBOL = /[\p{Extended_Pictographic}\p{S}]/gu;
const MEGA_NAME = /\bM\s*\.?\s*E\s*\.?\s*G\s*\.?\s*A\s*\.?(?![\p{L}\p{N}])/giu;

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
    .replace(/([.,!?;:])(?=\S)/g, '$1 ')
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
  const remainder = `${normalized.slice(matches.join('').length).trim()}${withheld}`;
  return { sentences: complete, remainder };
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
