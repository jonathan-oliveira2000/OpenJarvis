import { describe, expect, it } from 'vitest';
import {
  removeActivationWord,
  splitSentences,
  takeCompleteSentences,
  takeInitialClause,
  toSpeechText,
} from './speechText';

describe('M.E.G.A speech text helpers', () => {
  it('removes markdown, URLs, emoji, symbols, and never reads code blocks', () => {
    expect(toSpeechText('**Olá!** [documentação](https://example.com) [referência][docs] 😊 `x+y`\n[docs]: https://example.com\n```ts\nconst x = 1;\n```'))
      .toBe('Olá! documentação referência x y O código está na tela de chat.');
  });

  it('speaks the written name as Mega instead of spelling its letters', () => {
    expect(toSpeechText('M.E.G.A responde. MEGA está ouvindo.'))
      .toBe('Mega responde. Mega está ouvindo.');
  });

  it('splits complete sentences while keeping an unfinished stream remainder', () => {
    expect(splitSentences('Olá. Tudo bem?')).toEqual(['Olá.', 'Tudo bem?']);
    expect(takeCompleteSentences('Uma frase. Ainda incompleta')).toEqual({
      sentences: [],
      remainder: 'Uma frase. Ainda incompleta',
    });
    expect(takeCompleteSentences('Sim. Esta é uma resposta que explica a ideia com detalhes.'))
      .toEqual({
        sentences: ['Sim. Esta é uma resposta que explica a ideia com detalhes.'],
        remainder: '',
      });
  });

  it('does not queue a partial fenced code block while streaming', () => {
    expect(takeCompleteSentences('Uma frase completa e longa o bastante. ```ts\nconst text = "não ler."')).toEqual({
      sentences: ['Uma frase completa e longa o bastante.'],
      remainder: '```ts\nconst text = "não ler."',
    });
    expect(toSpeechText('```ts\nconst x = 1;')).toBe('O código está na tela de chat.');
  });

  it('cuts one sufficiently long initial clause at a safe delimiter', () => {
    expect(takeInitialClause(
      'A explicação inicial é suficientemente longa para começar a ser dita, e a continuação vem depois.',
    )).toEqual({
      clause: 'A explicação inicial é suficientemente longa para começar a ser dita,',
      remainder: 'e a continuação vem depois.',
    });
    expect(takeInitialClause('Uma ideia curta, que continua depois.').clause).toBeNull();
  });

  it('does not cut decimal numbers or common abbreviations', () => {
    const decimal = takeInitialClause(
      'A medida inicial descreve 1,5 unidades em uma explicação longa o bastante, e a continuação chega depois.',
    );
    expect(decimal.clause).toBe(
      'A medida inicial descreve 1,5 unidades em uma explicação longa o bastante,',
    );

    const abbreviation = takeInitialClause(
      'O Dr. Silva apresenta um contexto inicial suficientemente longo antes de continuar: os detalhes vêm depois.',
    );
    expect(abbreviation.clause).toBe(
      'O Dr. Silva apresenta um contexto inicial suficientemente longo antes de continuar:',
    );
  });

  it('detects Mega activation variants and strips the prefix', () => {
    expect(removeActivationWord('Mega, abra a tela.')).toBe('abra a tela.');
    expect(removeActivationWord('MÉGA fale.')).toBe('fale.');
    expect(removeActivationWord('Ei Mega, como vai?')).toBe('como vai?');
    expect(removeActivationWord('Oi Mega, como vai?')).toBe('como vai?');
    expect(removeActivationWord('E aí Mega, como vai?')).toBe('como vai?');
    expect(removeActivationWord('Ok Mega, como vai?')).toBe('como vai?');
    expect(removeActivationWord('Megah, abra a tela.')).toBe('abra a tela.');
    expect(removeActivationWord('Mega')).toBe('');
    expect(removeActivationWord('Abra a tela.')).toBeNull();
  });

  it('does not treat common words and phrases as activation calls', () => {
    expect(removeActivationWord('Mega sena')).toBeNull();
    expect(removeActivationWord('Mega promoção')).toBeNull();
    expect(removeActivationWord('Megabyte')).toBeNull();
    expect(removeActivationWord('A promoção é mega')).toBeNull();
  });

  it('accepts the previous activation name only when explicitly enabled', () => {
    expect(removeActivationWord('Jarvis, fale.')).toBeNull();
    expect(removeActivationWord('Ei Járvis, fale.', { allowLegacyAlias: true })).toBe('fale.');
  });
});
