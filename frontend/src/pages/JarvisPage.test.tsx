import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { JarvisPage } from './JarvisPage';
import { jarvisStrings } from '../lib/jarvis/strings';

describe('JarvisPage', () => {
  it('renders an accessible HUD and a collapsed demo without a message history', () => {
    const markup = renderToStaticMarkup(<JarvisPage />);
    const visibleText = markup.replace(/<[^>]*>/g, ' ');

    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('<details');
    expect(markup).not.toContain('<details open');
    expect(markup).toContain('aria-label="Mensagem para a M.E.G.A."');
    expect(markup).toContain('Ativar escuta');
    expect(markup).toContain('Configurações de voz');
    expect(markup).toContain('Permitir interromper a M.E.G.A. falando');
    expect(markup).toContain('Exigir “Mega” para interromper');
    expect(visibleText).not.toMatch(/jarvis/i);
    expect(markup).not.toContain('listitem');
  });

  it('uses the new spoken identity in its system persona', () => {
    expect(jarvisStrings.systemPrompt).toContain('M.E.G.A.');
    expect(jarvisStrings.systemPrompt).toContain('Máquina Extremamente Genial (Aparentemente)');
    expect(jarvisStrings.systemPrompt).toContain('nunca se chame Jarvis');
  });
});
