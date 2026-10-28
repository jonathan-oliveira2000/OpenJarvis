"""Tests for speech API endpoints."""

import asyncio
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

fastapi = pytest.importorskip("fastapi")

from fastapi.testclient import TestClient  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402

from openjarvis.speech._stubs import TranscriptionResult  # noqa: E402


@pytest.fixture
def mock_speech_backend():
    backend = MagicMock()
    backend.backend_id = "mock"
    backend.health.return_value = True
    backend.transcribe.return_value = TranscriptionResult(
        text="Hello world",
        language="en",
        confidence=0.95,
        duration_seconds=1.5,
        segments=[],
    )
    return backend


@pytest.fixture
def app_with_speech(mock_speech_backend):
    from fastapi import FastAPI

    from openjarvis.server.api_routes import speech_router

    app = FastAPI()
    app.state.speech_backend = mock_speech_backend
    app.include_router(speech_router)
    return app


@pytest.fixture
def client(app_with_speech):
    return TestClient(app_with_speech)


def test_transcribe_endpoint(client, mock_speech_backend):
    response = client.post(
        "/v1/speech/transcribe",
        files={"file": ("test.wav", b"fake audio data", "audio/wav")},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["text"] == "Hello world"
    assert data["language"] == "en"
    assert data["confidence"] == 0.95
    assert data["duration_seconds"] == 1.5


def test_transcribe_endpoint_passes_wav_format_and_language(
    client, mock_speech_backend
):
    audio = b"fake wav audio"

    response = client.post(
        "/v1/speech/transcribe",
        files={"file": ("speech.wav", audio, "audio/wav")},
        data={"language": "pt"},
    )

    assert response.status_code == 200
    mock_speech_backend.transcribe.assert_called_once_with(
        audio,
        format="wav",
        language="pt",
    )


def test_transcribe_endpoint_offloads_backend_work(client, mock_speech_backend):
    expected = TranscriptionResult(
        text="Offloaded",
        language="en",
        confidence=0.9,
        duration_seconds=1.0,
        segments=[],
    )

    with patch(
        "openjarvis.server.api_routes.asyncio.to_thread",
        new_callable=AsyncMock,
    ) as mock_to_thread:
        mock_to_thread.return_value = expected
        response = client.post(
            "/v1/speech/transcribe",
            files={"file": ("test.wav", b"fake audio data", "audio/wav")},
        )

    assert response.status_code == 200
    mock_to_thread.assert_awaited_once()
    args, kwargs = mock_to_thread.await_args
    assert args == (mock_speech_backend.transcribe, b"fake audio data")
    assert kwargs == {"format": "wav", "language": None}
    assert response.json()["text"] == "Offloaded"


def test_transcribe_endpoint_surfaces_backend_error(client, mock_speech_backend):
    mock_speech_backend.transcribe.side_effect = RuntimeError("missing cublas64_12.dll")

    response = client.post(
        "/v1/speech/transcribe",
        files={"file": ("test.wav", b"fake audio data", "audio/wav")},
    )

    assert response.status_code == 500
    assert "missing cublas64_12.dll" in response.json()["detail"]


def test_transcribe_no_file(client):
    response = client.post("/v1/speech/transcribe")
    assert response.status_code == 400 or response.status_code == 422


def test_health_endpoint(client):
    response = client.get("/v1/speech/health")
    assert response.status_code == 200
    data = response.json()
    assert data["available"] is True
    assert data["backend"] == "mock"


def test_health_endpoint_includes_unavailable_reason(client, mock_speech_backend):
    mock_speech_backend.health.return_value = False
    mock_speech_backend.last_error.return_value = (
        "Install with: uv sync --extra desktop"
    )

    response = client.get("/v1/speech/health")

    assert response.status_code == 200
    data = response.json()
    assert data["available"] is False
    assert data["reason"] == "Install with: uv sync --extra desktop"


def test_health_no_backend():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from openjarvis.server.api_routes import speech_router

    app = FastAPI()
    app.state.speech_backend = None
    app.include_router(speech_router)
    client = TestClient(app)

    response = client.get("/v1/speech/health")
    assert response.status_code == 200
    data = response.json()
    assert data["available"] is False


def test_health_reports_warmup_without_forcing_another_model_load():
    from fastapi import FastAPI

    from openjarvis.server.api_routes import speech_router

    backend = MagicMock()
    backend.backend_id = "faster-whisper"
    app = FastAPI()
    app.state.speech_backend = backend
    app.state.voice_warmup_status = {
        "status": "loading",
        "stt": "loading",
        "tts": "pending",
    }
    app.include_router(speech_router)

    response = TestClient(app).get("/v1/speech/health")

    assert response.status_code == 200
    assert response.json()["warmup"]["stt"] == "loading"
    backend.health.assert_not_called()


def _voice_warmup_app(*, stt_loader, tts_backend, preferred):
    return SimpleNamespace(
        state=SimpleNamespace(
            speech_backend=SimpleNamespace(_ensure_model=stt_loader),
            config=SimpleNamespace(
                speech=SimpleNamespace(
                    tts_backend=preferred,
                    voice_id="pf_dora",
                    voice_speed=1.0,
                )
            ),
            _voice_warmup_lock=threading.Lock(),
            voice_warmup_status={
                "status": "pending",
                "stt": "pending",
                "tts": "pending",
            },
            _tts_resolution_lock=threading.Lock(),
            tts_backend=tts_backend,
            tts_resolved=tts_backend is not None,
        )
    )


def test_voice_warmup_uses_kokoro_and_skips_api_backends():
    from openjarvis.server.app import _warm_voice_models

    stt_loader = MagicMock()
    kokoro = MagicMock()
    kokoro.backend_id = "kokoro"
    local_app = _voice_warmup_app(
        stt_loader=stt_loader,
        tts_backend=kokoro,
        preferred="kokoro",
    )

    _warm_voice_models(local_app)

    stt_loader.assert_called_once_with()
    kokoro.synthesize.assert_called_once_with(
        "Olá.",
        voice_id="pf_dora",
        speed=1.0,
        output_format="wav",
    )
    assert local_app.state.voice_warmup_status == {
        "status": "ready",
        "stt": "ready",
        "tts": "ready",
    }

    cloud_app = _voice_warmup_app(
        stt_loader=MagicMock(),
        tts_backend=None,
        preferred="openai_tts",
    )
    _warm_voice_models(cloud_app)
    assert cloud_app.state.voice_warmup_status["tts"] == "skipped"


def test_voice_warmup_failure_does_not_raise_or_skip_other_local_backend():
    from openjarvis.server.app import _warm_voice_models

    stt_loader = MagicMock(side_effect=RuntimeError("model unavailable"))
    kokoro = MagicMock()
    kokoro.backend_id = "kokoro"
    app = _voice_warmup_app(
        stt_loader=stt_loader,
        tts_backend=kokoro,
        preferred="kokoro",
    )

    _warm_voice_models(app)

    assert app.state.voice_warmup_status == {
        "status": "failed",
        "stt": "failed",
        "tts": "ready",
    }
    kokoro.synthesize.assert_called_once()


def test_voice_warmup_environment_defaults_on_and_accepts_false_values(monkeypatch):
    from openjarvis.server.app import _voice_warmup_enabled

    monkeypatch.delenv("MEGA_VOICE_WARMUP", raising=False)
    assert _voice_warmup_enabled()
    for value in ("0", "false", "no", "off"):
        assert not _voice_warmup_enabled(value)
    for value in ("1", "true", "yes", "on"):
        assert _voice_warmup_enabled(value)


def _voice_warmup_lifespan_app(tmp_path, speech_backend, config):
    from openjarvis.server.app import create_app
    from openjarvis.server.auth_store import AuthStore

    return create_app(
        MagicMock(),
        "test-model",
        config=config,
        speech_backend=speech_backend,
        auth_store=AuthStore(tmp_path / "voice-warmup-auth.db"),
    )


def test_app_lifespan_starts_with_voice_warmup_enabled(
    tmp_path, monkeypatch
):
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.setenv("MEGA_VOICE_WARMUP", "1")
    stt_backend = MagicMock()
    stt_backend.backend_id = "faster-whisper"
    tts_backend = MagicMock()
    tts_backend.backend_id = "kokoro"
    config = SimpleNamespace(
        speech=SimpleNamespace(
            tts_backend="kokoro",
            voice_id="pf_dora",
            voice_speed=1.0,
        )
    )
    app = _voice_warmup_lifespan_app(tmp_path, stt_backend, config)

    with patch(
        "openjarvis.server.api_routes._resolve_tts_backend_sync",
        return_value=tts_backend,
    ):
        with TestClient(app) as client:
            assert client.get("/health").status_code == 200
            warmup_thread = app.state.voice_warmup_thread
            warmup_thread.join(timeout=5)
            assert not warmup_thread.is_alive()
            registration = client.post(
                "/auth/register",
                json={"name": "voice-admin", "password": "safePass123"},
            )
            assert registration.status_code == 201
            login = client.post(
                "/auth/login",
                json={"name": "voice-admin", "password": "safePass123"},
            )
            assert login.status_code == 200
            speech_health = client.get("/v1/speech/health")
            assert speech_health.status_code == 200
            assert speech_health.json()["warmup"] == {
                "status": "ready",
                "stt": "ready",
                "tts": "ready",
            }

    stt_backend._ensure_model.assert_called_once()
    tts_backend.synthesize.assert_called_once_with(
        "Olá.",
        voice_id="pf_dora",
        speed=1.0,
        output_format="wav",
    )
    assert app.state.voice_warmup_status == {
        "status": "ready",
        "stt": "ready",
        "tts": "ready",
    }


def test_app_lifespan_starts_when_voice_warmup_is_disabled(tmp_path, monkeypatch):
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.setenv("MEGA_VOICE_WARMUP", "0")
    stt_backend = MagicMock()
    config = SimpleNamespace(
        speech=SimpleNamespace(
            tts_backend="openai_tts",
            voice_id="",
            voice_speed=1.0,
        )
    )
    app = _voice_warmup_lifespan_app(tmp_path, stt_backend, config)

    with TestClient(app) as client:
        assert client.get("/health").status_code == 200

    assert app.state.voice_warmup_status == {
        "status": "disabled",
        "stt": "disabled",
        "tts": "disabled",
    }
    assert not hasattr(app.state, "voice_warmup_thread")
    stt_backend._ensure_model.assert_not_called()


def test_app_lifespan_survives_voice_warmup_backend_failures(
    tmp_path, monkeypatch, caplog
):
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.setenv("MEGA_VOICE_WARMUP", "1")
    stt_backend = MagicMock()
    stt_backend.backend_id = "faster-whisper"
    stt_backend._ensure_model.side_effect = RuntimeError("STT unavailable")
    tts_backend = MagicMock()
    tts_backend.backend_id = "kokoro"
    tts_backend.synthesize.side_effect = RuntimeError("TTS unavailable")
    config = SimpleNamespace(
        speech=SimpleNamespace(
            tts_backend="kokoro",
            voice_id="pf_dora",
            voice_speed=1.0,
        )
    )
    app = _voice_warmup_lifespan_app(tmp_path, stt_backend, config)

    with patch(
        "openjarvis.server.api_routes._resolve_tts_backend_sync",
        return_value=tts_backend,
    ):
        with TestClient(app) as client:
            assert client.get("/health").status_code == 200
            warmup_thread = app.state.voice_warmup_thread
            warmup_thread.join(timeout=5)
            assert not warmup_thread.is_alive()

    assert app.state.voice_warmup_status == {
        "status": "failed",
        "stt": "failed",
        "tts": "failed",
    }
    assert "STT model warm-up failed" in caplog.text
    assert "Local TTS model warm-up failed" in caplog.text


def test_app_lifespan_survives_unexpected_voice_warmup_exception(
    tmp_path, monkeypatch, caplog
):
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.setenv("MEGA_VOICE_WARMUP", "1")
    config = SimpleNamespace(
        speech=SimpleNamespace(
            tts_backend="openai_tts",
            voice_id="",
            voice_speed=1.0,
        )
    )
    app = _voice_warmup_lifespan_app(tmp_path, MagicMock(), config)

    with patch(
        "openjarvis.server.app._warm_voice_models",
        side_effect=RuntimeError("unexpected worker failure"),
    ):
        with TestClient(app) as client:
            assert client.get("/health").status_code == 200
            warmup_thread = app.state.voice_warmup_thread
            warmup_thread.join(timeout=5)
            assert not warmup_thread.is_alive()

    assert app.state.voice_warmup_status == {
        "status": "failed",
        "stt": "failed",
        "tts": "failed",
    }
    assert "Voice model warm-up failed; the first request will retry" in caplog.text


@pytest.mark.asyncio
async def test_startup_does_not_load_models_when_disabled_or_under_pytest(monkeypatch):
    from openjarvis.server.app import _schedule_voice_warmup

    stt_loader = MagicMock()
    app = SimpleNamespace(
        state=SimpleNamespace(
            _voice_warmup_lock=threading.Lock(),
            voice_warmup_status={
                "status": "pending",
                "stt": "pending",
                "tts": "pending",
            },
            speech_backend=SimpleNamespace(_ensure_model=stt_loader),
        )
    )
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.setenv("MEGA_VOICE_WARMUP", "0")

    await _schedule_voice_warmup(app)

    assert app.state.voice_warmup_status["status"] == "disabled"
    assert not hasattr(app.state, "voice_warmup_thread")
    stt_loader.assert_not_called()

    monkeypatch.setenv("MEGA_VOICE_WARMUP", "1")
    monkeypatch.setenv("PYTEST_CURRENT_TEST", "test_startup_does_not_load_models")
    await _schedule_voice_warmup(app)
    assert not hasattr(app.state, "voice_warmup_thread")
    stt_loader.assert_not_called()


def test_tts_backend_resolution_is_shared_across_concurrent_requests():
    from openjarvis.server.api_routes import _resolve_tts_backend_sync

    backend = MagicMock()
    app = SimpleNamespace(
        state=SimpleNamespace(
            config=SimpleNamespace(
                speech=SimpleNamespace(
                    tts_backend="kokoro",
                    voice_id="pf_dora",
                    voice_speed=1.0,
                )
            ),
            _tts_resolution_lock=threading.Lock(),
            tts_resolved=False,
            tts_backend=None,
        )
    )

    def discover(preferred):
        time.sleep(0.03)
        return backend

    with patch(
        "openjarvis.speech._tts_discovery.get_tts_backend",
        side_effect=discover,
    ) as discover_backend:
        with ThreadPoolExecutor(max_workers=6) as executor:
            resolved = list(
                executor.map(lambda _: _resolve_tts_backend_sync(app), range(6))
            )

    assert all(item is backend for item in resolved)
    discover_backend.assert_called_once_with("kokoro")


# ---------------------------------------------------------------------------
# Text-to-speech
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_tts_backend():
    from openjarvis.speech.tts import TTSResult

    backend = MagicMock()
    backend.backend_id = "mock_tts"
    backend.health.return_value = True
    backend.synthesize.return_value = TTSResult(
        audio=b"RIFFfake-wav-bytes",
        format="wav",
        duration_seconds=1.25,
        voice_id="mock-voice",
        sample_rate=22050,
    )
    return backend


def _tts_app(backend, *, config=None):
    from fastapi import FastAPI

    from openjarvis.server.api_routes import speech_router

    app = FastAPI()
    app.include_router(speech_router)
    # Pre-resolve so the route does not go through backend discovery.
    app.state.tts_backend = backend
    app.state.tts_resolved = True
    app.state.config = config
    return TestClient(app)


def _unresolved_tts_app():
    from fastapi import FastAPI

    from openjarvis.server.api_routes import speech_router

    app = FastAPI()
    app.include_router(speech_router)
    app.state.config = SimpleNamespace(
        speech=SimpleNamespace(
            tts_backend="kokoro", voice_id="bm_george", voice_speed=1.0
        )
    )
    return app


def test_synthesize_returns_wav(mock_tts_backend):
    client = _tts_app(mock_tts_backend)

    response = client.post("/v1/speech/synthesize", json={"text": "Hallo Welt"})

    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.headers["x-sample-rate"] == "22050"
    assert response.headers["x-voice-id"] == "mock-voice"
    assert response.content == b"RIFFfake-wav-bytes"
    assert mock_tts_backend.synthesize.call_args.kwargs["output_format"] == "wav"


def test_synthesize_honours_request_overrides(mock_tts_backend):
    client = _tts_app(mock_tts_backend)

    client.post(
        "/v1/speech/synthesize",
        json={"text": "Hallo", "voice_id": "de_DE-thorsten-medium", "speed": 1.5},
    )

    kwargs = mock_tts_backend.synthesize.call_args.kwargs
    assert kwargs["voice_id"] == "de_DE-thorsten-medium"
    assert kwargs["speed"] == 1.5


def test_synthesize_rejects_empty_text(mock_tts_backend):
    client = _tts_app(mock_tts_backend)

    response = client.post("/v1/speech/synthesize", json={"text": "   "})

    assert response.status_code == 400
    mock_tts_backend.synthesize.assert_not_called()


def test_synthesize_rejects_oversized_text(mock_tts_backend):
    from openjarvis.server.api_routes import _MAX_TTS_CHARS

    client = _tts_app(mock_tts_backend)

    response = client.post(
        "/v1/speech/synthesize", json={"text": "a" * (_MAX_TTS_CHARS + 1)}
    )

    assert response.status_code == 413
    mock_tts_backend.synthesize.assert_not_called()


def test_synthesize_without_backend_returns_501():
    client = _tts_app(None)

    response = client.post("/v1/speech/synthesize", json={"text": "Hallo"})

    assert response.status_code == 501


def test_synthesize_surfaces_backend_failure(mock_tts_backend):
    mock_tts_backend.synthesize.side_effect = RuntimeError("voice model missing")
    client = _tts_app(mock_tts_backend)

    response = client.post("/v1/speech/synthesize", json={"text": "Hallo"})

    assert response.status_code == 500
    assert response.json()["detail"] == "Speech synthesis failed"


def test_synthesize_offloads_backend_work(mock_tts_backend):
    from openjarvis.speech.tts import TTSResult

    client = _tts_app(mock_tts_backend)
    expected = TTSResult(audio=b"RIFFoffloaded", format="wav", sample_rate=22050)

    with patch(
        "openjarvis.server.api_routes.asyncio.to_thread",
        new_callable=AsyncMock,
        return_value=expected,
    ) as to_thread:
        response = client.post("/v1/speech/synthesize", json={"text": "Hallo"})

    assert response.content == b"RIFFoffloaded"
    to_thread.assert_awaited_once()


def test_tts_health_reports_backend(mock_tts_backend):
    client = _tts_app(mock_tts_backend)

    data = client.get("/v1/speech/tts/health").json()

    assert data["available"] is True
    assert data["backend"] == "mock_tts"


def test_tts_health_without_backend():
    client = _tts_app(None)

    data = client.get("/v1/speech/tts/health").json()

    assert data["available"] is False
    assert "reason" in data


def test_tts_health_retries_after_unavailable(mock_tts_backend):
    app = _unresolved_tts_app()
    client = TestClient(app)

    with patch(
        "openjarvis.speech._tts_discovery.get_tts_backend",
        side_effect=[None, mock_tts_backend],
    ) as discover:
        assert client.get("/v1/speech/tts/health").json()["available"] is False
        assert client.get("/v1/speech/tts/health").json()["available"] is True
        assert client.get("/v1/speech/tts/health").json()["available"] is True

    assert discover.call_count == 2


@pytest.mark.asyncio
async def test_concurrent_tts_health_requests_share_resolution(mock_tts_backend):
    app = _unresolved_tts_app()

    def discover(_preferred):
        time.sleep(0.05)
        return mock_tts_backend

    with patch(
        "openjarvis.speech._tts_discovery.get_tts_backend", side_effect=discover
    ) as mock_discover:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            responses = await asyncio.gather(
                *(client.get("/v1/speech/tts/health") for _ in range(3))
            )

    assert all(response.json()["available"] is True for response in responses)
    mock_discover.assert_called_once_with("kokoro")


@pytest.mark.asyncio
async def test_concurrent_unavailable_probes_share_attempt_then_retry(mock_tts_backend):
    app = _unresolved_tts_app()
    attempts = 0

    def discover(_preferred):
        nonlocal attempts
        attempts += 1
        time.sleep(0.05)
        return None if attempts == 1 else mock_tts_backend

    with patch(
        "openjarvis.speech._tts_discovery.get_tts_backend", side_effect=discover
    ):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            responses = await asyncio.gather(
                *(client.get("/v1/speech/tts/health") for _ in range(3))
            )
            assert all(response.json()["available"] is False for response in responses)
            assert attempts == 1
            assert (await client.get("/v1/speech/tts/health")).json()["available"]

    assert attempts == 2


def test_invalid_synthesis_does_not_load_tts_backend():
    client = TestClient(_unresolved_tts_app())

    with patch("openjarvis.speech._tts_discovery.get_tts_backend") as discover:
        response = client.post("/v1/speech/synthesize", json={"text": "  "})

    assert response.status_code == 400
    discover.assert_not_called()


def test_voice_id_not_reused_across_backends(mock_tts_backend):
    """A configured voice belongs to its backend; a fallback uses its own."""
    from types import SimpleNamespace

    config = SimpleNamespace(
        speech=SimpleNamespace(
            tts_backend="kokoro", voice_id="bm_george", voice_speed=1.0
        )
    )
    client = _tts_app(mock_tts_backend, config=config)

    client.post("/v1/speech/synthesize", json={"text": "Hallo"})

    # Backend is mock_tts, not the configured kokoro, so bm_george must not leak.
    assert mock_tts_backend.synthesize.call_args.kwargs["voice_id"] != "bm_george"
