import { useEffect, useState } from 'react';
import { JarvisHud } from '../components/Jarvis/JarvisHud';
import { useJarvisVoice } from '../hooks/useJarvisVoice';
import { getBrowserVoices } from '../lib/jarvis/ttsAdapters';
import { jarvisStrings } from '../lib/jarvis/strings';

export function JarvisPage() {
  const voice = useJarvisVoice();
  const [input, setInput] = useState('');
  const [browserVoices, setBrowserVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    const refreshVoices = () => setBrowserVoices(getBrowserVoices());
    refreshVoices();
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.addEventListener('voiceschanged', refreshVoices);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', refreshVoices);
  }, []);

  const sendMessage = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = input.trim();
    if (!message) return;
    setInput('');
    void voice.sendText(message);
  };

  const update = voice.updatePreferences;
  const preferences = voice.preferences;
  const isBusy = voice.state === 'thinking' || voice.state === 'transcribing';

  return (
    <section className="relative flex h-full min-h-0 w-full flex-col overflow-auto">
      <div className="jarvis-blueprint pointer-events-none absolute inset-0" aria-hidden="true" />

      <div className="relative z-[1] flex min-h-0 flex-1 flex-col items-center justify-center px-5 py-3">
        <JarvisHud state={voice.state} amplitude={voice.amplitude} reducedMotion={false} />
        <p
          className="mt-2 min-h-6 text-center text-sm tracking-wide"
          style={{ color: 'var(--color-text-secondary)' }}
          aria-live="polite"
          aria-atomic="true"
        >
          {jarvisStrings.status[voice.state]}
        </p>
        {voice.microphoneActive && (
          <p className="mt-1 text-xs text-emerald-500" role="status">
            Microfone ativo
          </p>
        )}
        {!voice.activated && (
          <button
            type="button"
            onClick={() => void voice.start()}
            className="mt-4 rounded-full border px-6 py-3 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{
              borderColor: 'var(--color-accent)',
              color: 'var(--color-accent)',
              background: 'var(--color-bg-secondary)',
            }}
          >
            Ativar escuta
          </button>
        )}
        {voice.error && (
          <p className="mt-2 max-w-xl text-center text-sm text-red-500" role="alert">
            {voice.error}
          </p>
        )}
        {preferences.captions && voice.lastTranscript && (
          <p
            className="mt-3 max-w-2xl text-center text-sm"
            style={{ color: 'var(--color-text-secondary)' }}
            aria-live="polite"
          >
            Você disse: {voice.lastTranscript}
          </p>
        )}
        {isBusy && (
          <button
            type="button"
            onClick={voice.interrupt}
            className="mt-3 rounded-md border px-3 py-1.5 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
          >
            Cancelar resposta
          </button>
        )}
        {voice.state === 'speaking' && (
          <button
            type="button"
            onClick={voice.interrupt}
            className="mt-3 rounded-md border px-3 py-1.5 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
          >
            Interromper fala (Esc)
          </button>
        )}
      </div>

      <footer className="relative z-[1] mx-auto flex w-full max-w-3xl flex-col gap-3 px-5 pb-4">
        <form className="flex items-center gap-2" onSubmit={sendMessage}>
          <label className="sr-only" htmlFor="jarvis-fallback-input">
            {jarvisStrings.fallbackLabel}
          </label>
          <input
            id="jarvis-fallback-input"
            type="text"
            value={input}
            onChange={(event) => setInput(event.currentTarget.value)}
            placeholder={jarvisStrings.fallbackPlaceholder}
            aria-label={jarvisStrings.fallbackLabel}
            className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-xs outline-none"
            style={{
              background: 'var(--color-bg-secondary)',
              borderColor: 'var(--color-border)',
              color: 'var(--color-text-secondary)',
            }}
          />
          <button
            type="submit"
            disabled={!input.trim() || isBusy || voice.state === 'speaking'}
            className="rounded-lg border px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
          >
            Enviar
          </button>
          <button
            type="button"
            onClick={() => voice.state === 'paused' ? void voice.resume() : voice.pause()}
            disabled={!voice.microphoneActive && voice.state !== 'paused'}
            aria-label={voice.state === 'paused' ? jarvisStrings.resume : jarvisStrings.pause}
            title={voice.state === 'paused' ? jarvisStrings.resume : jarvisStrings.pause}
            className="rounded-lg border px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
          >
            {voice.state === 'paused' ? jarvisStrings.resume : jarvisStrings.pause}
          </button>
          {voice.microphoneActive && (
            <button
              type="button"
              onClick={voice.stop}
              className="rounded-lg border px-3 py-2 text-xs"
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
            >
              Parar
            </button>
          )}
        </form>

        <details className="jarvis-demo rounded-lg border" style={{ borderColor: 'var(--color-border)' }}>
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
            {jarvisStrings.demoTitle}
          </summary>
          <div className="grid gap-3 border-t px-3 py-3 sm:grid-cols-2" style={{ borderColor: 'var(--color-border)' }}>
            <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              Voz
              <select
                value={preferences.adapter}
                onChange={(event) => update({ adapter: event.currentTarget.value as 'browser' | 'server', voiceId: '' })}
                className="rounded-md border bg-transparent px-2 py-1.5"
                style={{ borderColor: 'var(--color-border)' }}
              >
                <option value="browser">Navegador (pt-BR)</option>
                <option value="server">Servidor</option>
              </select>
            </label>
            {preferences.adapter === 'browser' ? (
              <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                Voz pt-BR
                <select
                  value={preferences.voiceId}
                  onChange={(event) => update({ voiceId: event.currentTarget.value })}
                  className="rounded-md border bg-transparent px-2 py-1.5"
                  style={{ borderColor: 'var(--color-border)' }}
                >
                  <option value="">Automática (Natural/Online preferida)</option>
                  {browserVoices.map((voiceOption) => (
                    <option key={voiceOption.voiceURI} value={voiceOption.voiceURI}>
                      {voiceOption.name} ({voiceOption.lang})
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                ID da voz do servidor (opcional)
                <input
                  value={preferences.voiceId}
                  onChange={(event) => update({ voiceId: event.currentTarget.value })}
                  className="rounded-md border bg-transparent px-2 py-1.5"
                  style={{ borderColor: 'var(--color-border)' }}
                />
              </label>
            )}
            <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              Velocidade: {preferences.speed.toFixed(1)}×
              <input
                type="range"
                min="0.5"
                max="2"
                step="0.1"
                value={preferences.speed}
                onChange={(event) => update({ speed: Number(event.currentTarget.value) })}
              />
            </label>
            <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              Sensibilidade: {Math.round(preferences.sensitivity * 100)}%
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={preferences.sensitivity}
                onChange={(event) => update({ sensitivity: Number(event.currentTarget.value) })}
              />
            </label>
            <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              <input type="checkbox" checked={preferences.captions} onChange={(event) => update({ captions: event.currentTarget.checked })} />
              Mostrar legenda da última fala
            </label>
            <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              <input type="checkbox" checked={preferences.wakeWord} onChange={(event) => update({ wakeWord: event.currentTarget.checked })} />
              Exigir palavra “Mega”
            </label>
            <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              <input type="checkbox" checked={preferences.allowLegacyWakeWordAlias} onChange={(event) => update({ allowLegacyWakeWordAlias: event.currentTarget.checked })} />
              Permitir o nome anterior como palavra de ativação
            </label>
            <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              <input type="checkbox" checked={preferences.autoStart} onChange={(event) => update({ autoStart: event.currentTarget.checked })} />
              Iniciar escuta automaticamente
            </label>
            <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              <input type="checkbox" checked={preferences.pauseWhenHidden} onChange={(event) => update({ pauseWhenHidden: event.currentTarget.checked })} />
              Pausar quando a aba ficar oculta
            </label>
            <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              <input type="checkbox" checked={preferences.allowVoiceInterruption} onChange={(event) => update({ allowVoiceInterruption: event.currentTarget.checked })} />
              Permitir interromper a M.E.G.A. falando
            </label>
            <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              <input type="checkbox" checked={preferences.interruptionRequiresWakeWord} onChange={(event) => update({ interruptionRequiresWakeWord: event.currentTarget.checked })} />
              Exigir “Mega” para interromper
            </label>
            <p className="text-[11px] sm:col-span-2" style={{ color: 'var(--color-text-tertiary)' }}>
              Fones de ouvido reduzem o eco e oferecem a melhor detecção de interrupções.
            </p>
            <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              Limite de resposta: {preferences.thinkingTimeoutSec}s
              <input
                type="range"
                min="10"
                max="300"
                step="10"
                value={preferences.thinkingTimeoutSec}
                onChange={(event) => update({ thinkingTimeoutSec: Number(event.currentTarget.value) })}
              />
            </label>
          </div>
        </details>
      </footer>
    </section>
  );
}
