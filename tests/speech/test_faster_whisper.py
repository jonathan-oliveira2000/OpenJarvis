"""Tests for Faster-Whisper speech backend."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event, Lock
from unittest.mock import MagicMock, patch

import pytest

from openjarvis.core.registry import SpeechRegistry
from openjarvis.speech.faster_whisper import FasterWhisperBackend


@pytest.fixture(autouse=True)
def _register_faster_whisper():
    """Re-register after any registry clear."""
    if not SpeechRegistry.contains("faster-whisper"):
        SpeechRegistry.register_value("faster-whisper", FasterWhisperBackend)


def test_faster_whisper_backend_registers():
    """Backend registers itself in SpeechRegistry."""
    assert SpeechRegistry.contains("faster-whisper")


def test_faster_whisper_model_load_is_shared_by_concurrent_callers():
    constructor_started = Event()
    allow_constructor_to_finish = Event()
    constructor_lock = Lock()
    constructed = []
    model = MagicMock()

    def create_model(*args, **kwargs):
        with constructor_lock:
            constructed.append((args, kwargs))
        constructor_started.set()
        assert allow_constructor_to_finish.wait(timeout=2)
        return model

    with patch(
        "openjarvis.speech.faster_whisper.WhisperModel",
        side_effect=create_model,
    ):
        backend = FasterWhisperBackend(model_size="base", device="cpu")
        with ThreadPoolExecutor(max_workers=2) as executor:
            warmup = executor.submit(backend._ensure_model)
            assert constructor_started.wait(timeout=2)
            request = executor.submit(backend._ensure_model)
            allow_constructor_to_finish.set()
            assert warmup.result(timeout=2) is model
            assert request.result(timeout=2) is model

    assert len(constructed) == 1


def test_faster_whisper_transcribe():
    """Transcribe returns a TranscriptionResult."""
    from openjarvis.speech._stubs import TranscriptionResult

    mock_model = MagicMock()
    mock_segment = MagicMock()
    mock_segment.text = " Hello world"
    mock_segment.start = 0.0
    mock_segment.end = 1.2
    mock_segment.avg_logprob = -0.3

    mock_info = MagicMock()
    mock_info.language = "en"
    mock_info.language_probability = 0.95
    mock_info.duration = 1.5

    mock_model.transcribe.return_value = ([mock_segment], mock_info)

    with patch(
        "openjarvis.speech.faster_whisper.WhisperModel",
        return_value=mock_model,
    ):
        from openjarvis.speech.faster_whisper import FasterWhisperBackend

        backend = FasterWhisperBackend(model_size="base", device="cpu")
        result = backend.transcribe(b"fake audio bytes")

        assert isinstance(result, TranscriptionResult)
        assert result.text == "Hello world"
        assert result.language == "en"
        assert result.duration_seconds == 1.5


def test_faster_whisper_transcribe_temp_file_reopenable_and_removed():
    """The temp file must be closed before the model reads it, and gone after.

    On Windows, an open NamedTemporaryFile holds an exclusive handle, so
    PyAV's reopen of the path inside model.transcribe() fails with EACCES
    unless the file is closed first. Opening the path inside the mocked
    transcribe reproduces that failure mode on Windows.
    """
    import os

    mock_info = MagicMock()
    mock_info.language = "en"
    mock_info.language_probability = 0.95
    mock_info.duration = 1.5

    seen = {}

    def fake_transcribe(path, **kwargs):
        seen["path"] = path
        with open(path, "rb") as fh:
            seen["content"] = fh.read()
        return iter(()), mock_info

    mock_model = MagicMock()
    mock_model.transcribe.side_effect = fake_transcribe

    with patch(
        "openjarvis.speech.faster_whisper.WhisperModel",
        return_value=mock_model,
    ):
        backend = FasterWhisperBackend(model_size="base", device="cpu")
        backend.transcribe(b"fake audio bytes")

    assert seen["content"] == b"fake audio bytes"
    assert not os.path.exists(seen["path"])


def test_faster_whisper_transcribe_removes_temp_file_on_error():
    """The temp file is cleaned up even when transcription fails."""
    import os

    seen = {}

    def fake_transcribe(path, **kwargs):
        seen["path"] = path
        raise RuntimeError("decode failed")

    mock_model = MagicMock()
    mock_model.transcribe.side_effect = fake_transcribe

    with patch(
        "openjarvis.speech.faster_whisper.WhisperModel",
        return_value=mock_model,
    ):
        backend = FasterWhisperBackend(model_size="base", device="cpu")
        with pytest.raises(RuntimeError, match="decode failed"):
            backend.transcribe(b"fake audio bytes")

    assert "path" in seen
    assert not os.path.exists(seen["path"])
    assert "decode failed" in (backend.last_error() or "")


def test_faster_whisper_falls_back_from_unsupported_float16():
    mock_model = MagicMock()

    with (
        patch(
            "openjarvis.speech.faster_whisper.WhisperModel",
            return_value=mock_model,
        ) as mock_whisper,
        patch(
            "openjarvis.speech.faster_whisper.ctranslate2",
            MagicMock(
                get_supported_compute_types=MagicMock(return_value={"float32", "int8"})
            ),
        ),
    ):
        backend = FasterWhisperBackend(
            model_size="base",
            device="cpu",
            compute_type="float16",
        )
        assert backend._ensure_model() is mock_model

    mock_whisper.assert_called_once_with("base", device="cpu", compute_type="int8")


def test_faster_whisper_auto_device_retries_on_cpu_when_cuda_runtime_is_missing():
    mock_segment = MagicMock(text=" Recovered", start=0.0, end=1.0)
    mock_info = MagicMock(
        language="en",
        language_probability=0.9,
        duration=1.0,
    )
    created_models = []

    def fake_whisper_model(model_size, *, device, compute_type):
        created_models.append((model_size, device, compute_type))
        model = MagicMock()
        if device == "auto":
            def fail_during_inference():
                raise RuntimeError(
                    "Library cublas64_12.dll is not found or cannot be loaded"
                )
                yield

            model.transcribe.return_value = (fail_during_inference(), mock_info)
        else:
            model.transcribe.return_value = ([mock_segment], mock_info)
        return model

    with (
        patch(
            "openjarvis.speech.faster_whisper.WhisperModel",
            side_effect=fake_whisper_model,
        ),
        patch(
            "openjarvis.speech.faster_whisper.ctranslate2",
            MagicMock(
                get_supported_compute_types=MagicMock(
                    return_value={"float32", "int8"}
                )
            ),
        ),
    ):
        backend = FasterWhisperBackend(model_size="base", device="auto")
        result = backend.transcribe(b"fake audio bytes")

    assert result.text == "Recovered"
    assert [device for _, device, _ in created_models] == ["auto", "cpu"]
    assert backend._device == "cpu"


def test_faster_whisper_auto_device_does_not_retry_for_non_cuda_errors():
    mock_model = MagicMock()
    mock_model.transcribe.side_effect = RuntimeError("audio decode failed")

    with (
        patch(
            "openjarvis.speech.faster_whisper.WhisperModel",
            return_value=mock_model,
        ) as mock_whisper,
        patch(
            "openjarvis.speech.faster_whisper.ctranslate2",
            MagicMock(
                get_supported_compute_types=MagicMock(
                    return_value={"float32", "int8"}
                )
            ),
        ),
    ):
        backend = FasterWhisperBackend(model_size="base", device="auto")
        with pytest.raises(RuntimeError, match="audio decode failed"):
            backend.transcribe(b"fake audio bytes")

    mock_whisper.assert_called_once_with("base", device="auto", compute_type="int8")


def test_faster_whisper_missing_dependency_hint_uses_desktop_extra():
    with patch("openjarvis.speech.faster_whisper.WhisperModel", new=None):
        backend = FasterWhisperBackend()

        with pytest.raises(ImportError) as excinfo:
            backend._ensure_model()

    assert "uv sync --extra desktop" in str(excinfo.value)
    assert "uv sync --extra speech" not in str(excinfo.value)


def test_faster_whisper_health_no_model():
    """Health returns False before model is loaded."""
    with patch(
        "openjarvis.speech.faster_whisper.WhisperModel",
        new=None,
    ):
        backend = FasterWhisperBackend()
        assert backend.health() is False
        assert "uv sync --extra desktop" in (backend.last_error() or "")


def test_faster_whisper_health_captures_load_error():
    with patch(
        "openjarvis.speech.faster_whisper.WhisperModel",
        side_effect=RuntimeError("missing cublas64_12.dll"),
    ):
        backend = FasterWhisperBackend()
        assert backend.health() is False
        assert "missing cublas64_12.dll" in (backend.last_error() or "")


def test_faster_whisper_supported_formats():
    """Backend supports standard audio formats."""
    with patch("openjarvis.speech.faster_whisper.WhisperModel"):
        from openjarvis.speech.faster_whisper import FasterWhisperBackend

        backend = FasterWhisperBackend.__new__(FasterWhisperBackend)
        formats = backend.supported_formats()
        assert "wav" in formats
        assert "mp3" in formats
        assert "webm" in formats
