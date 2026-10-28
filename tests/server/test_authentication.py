"""Tests for required web authentication and per-user history isolation."""

from __future__ import annotations

import sqlite3
import re
import time
from unittest.mock import MagicMock

import pytest

pytest.importorskip("fastapi", reason="openjarvis[server] not installed")

from fastapi import FastAPI, Request, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from openjarvis.server.auth_routes import initialize_auth_store, router
from openjarvis.server.auth_store import (
    SESSION_COOKIE_NAME,
    AuthStore,
    _get_compatible_auth_env,
    hash_password,
    verify_password,
)
from openjarvis.server.session_auth_middleware import (
    SessionAuthMiddleware,
    authenticated_websocket_user,
)


def _app(path, *, allowed_origins: list[str] | None = None) -> FastAPI:
    app = FastAPI()
    app.state.auth_store = AuthStore(path)
    app.include_router(router)

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.get("/private")
    def private(request: Request):
        return {"user": request.state.user}

    @app.post("/private")
    def private_post(request: Request):
        return {"user": request.state.user}

    @app.websocket("/private-ws")
    async def private_websocket(websocket: WebSocket):
        if authenticated_websocket_user(websocket) is None:
            await websocket.close(code=1008)
            return
        await websocket.accept()
        await websocket.send_json({"ok": True})

    app.add_middleware(
        SessionAuthMiddleware,
        store=app.state.auth_store,
        allowed_origins=allowed_origins or [],
    )
    return app


def _register(client: TestClient, name: str, password: str = "safePass123"):
    return client.post(
        "/auth/register",
        json={"name": name, "password": password},
    )


def test_registration_validation_case_insensitive_unique_and_roles(tmp_path):
    client = TestClient(_app(tmp_path / "auth.db"))
    assert _register(client, "ab", "safePass123").status_code == 422
    assert _register(client, "  A  ", "safePass123").status_code == 422
    assert _register(client, "valid-name", "short").status_code == 422

    first = _register(client, "Alice")
    assert first.status_code == 201
    assert first.json()["user"]["role"] == "admin"
    assert "password" not in first.text
    assert "set-cookie" not in first.headers
    assert client.cookies.get(SESSION_COOKIE_NAME) is None
    assert client.get("/auth/me").status_code == 401
    with sqlite3.connect(tmp_path / "auth.db") as connection:
        assert connection.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0
    login = client.post(
        "/auth/login",
        json={"name": "Alice", "password": "safePass123"},
    )
    assert login.status_code == 200
    assert client.cookies.get(SESSION_COOKIE_NAME)
    assert client.get("/auth/me").json()["user"] == first.json()["user"]

    second = _register(client, "Bob")
    assert second.status_code == 201
    assert second.json()["user"]["role"] == "user"
    duplicate = client.post(
        "/auth/register",
        json={"name": "ALICE", "password": "safePass123"},
    )
    assert duplicate.status_code == 409


def test_login_is_generic_rate_limited_and_password_is_hashed(tmp_path):
    client = TestClient(_app(tmp_path / "auth.db"))
    registered = _register(client, "Alice")
    assert client.post(
        "/auth/login",
        json={"name": "Alice", "password": "safePass123"},
    ).status_code == 200
    user_id = registered.json()["user"]["id"]
    with sqlite3.connect(tmp_path / "auth.db") as connection:
        stored_hash = connection.execute(
            "SELECT password_hash FROM users WHERE id = ?", (user_id,)
        ).fetchone()[0]
    assert stored_hash != "safePass123"
    assert verify_password("safePass123", stored_hash)
    assert not verify_password("wrongPass123", stored_hash)

    unknown = client.post(
        "/auth/login",
        json={"name": "missing", "password": "safePass123"},
    )
    wrong = client.post(
        "/auth/login",
        json={"name": "Alice", "password": "wrongPass123"},
    )
    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json()["detail"] == wrong.json()["detail"]

    for _ in range(3):
        response = client.post(
            "/auth/login",
            json={"name": "rate-limit-user", "password": "wrongPass123"},
        )
        assert response.status_code == 401
    blocked = client.post(
        "/auth/login",
        json={"name": "rate-limit-user", "password": "wrongPass123"},
    )
    assert blocked.status_code == 429
    assert blocked.json()["detail"] == unknown.json()["detail"]


def test_first_registration_and_seed_admin_role(tmp_path, monkeypatch):
    store = AuthStore(tmp_path / "seed.db")
    monkeypatch.delenv("MEGA_ADMIN_NAME", raising=False)
    monkeypatch.delenv("MEGA_ADMIN_PASSWORD", raising=False)
    monkeypatch.setenv("JARVIS_ADMIN_NAME", "Root")
    monkeypatch.setenv("JARVIS_ADMIN_PASSWORD", "long-enough-password")
    initialize_auth_store(store)
    assert store.find_user("root")[0]["role"] == "admin"
    client = TestClient(_app(tmp_path / "first.db"))
    first = _register(client, "First")
    second = _register(client, "Second")
    assert first.json()["user"]["role"] == "admin"
    assert second.json()["user"]["role"] == "user"


def test_mega_admin_seed_overrides_legacy_environment(tmp_path, monkeypatch):
    store = AuthStore(tmp_path / "mega-seed.db")
    monkeypatch.setenv("MEGA_ADMIN_NAME", "MegaRoot")
    monkeypatch.setenv("MEGA_ADMIN_PASSWORD", "mega-password-123")
    monkeypatch.setenv("JARVIS_ADMIN_NAME", "LegacyRoot")
    monkeypatch.setenv("JARVIS_ADMIN_PASSWORD", "legacy-password-123")

    initialize_auth_store(store)

    assert store.find_user("megaroot")[0]["role"] == "admin"
    assert store.find_user("legacyroot") is None


@pytest.mark.parametrize(
    "name",
    [
        "ADMIN_NAME",
        "ADMIN_PASSWORD",
        "SESSION_TTL_SECONDS",
        "AUTH_MAX_FAILURES",
        "AUTH_RATE_WINDOW_SECONDS",
    ],
)
def test_mega_auth_environment_overrides_legacy_and_legacy_remains_fallback(
    name, monkeypatch
):
    monkeypatch.delenv(f"MEGA_{name}", raising=False)
    monkeypatch.setenv(f"JARVIS_{name}", "legacy-value")
    assert _get_compatible_auth_env(name, "default") == "legacy-value"

    monkeypatch.setenv(f"MEGA_{name}", "mega-value")
    assert _get_compatible_auth_env(name, "default") == "mega-value"


def test_default_deny_expired_session_and_origin_check(tmp_path):
    client = TestClient(
        _app(tmp_path / "auth.db", allowed_origins=["https://app.example"])
    )
    assert client.get("/private").status_code == 401
    assert client.post("/private").status_code == 401
    assert client.get("/health").status_code == 200
    assert (
        client.post(
            "/auth/register",
            json={"name": "Alice", "password": "safePass123"},
            headers={"Origin": "https://evil.example"},
        ).status_code
        == 403
    )
    response = _register(client, "Alice")
    assert response.status_code == 201
    assert client.post(
        "/auth/login",
        json={"name": "Alice", "password": "safePass123"},
    ).status_code == 200
    assert client.get("/private").status_code == 200

    token = client.cookies.get(SESSION_COOKIE_NAME)
    token_hash = __import__("hashlib").sha256(token.encode()).hexdigest()
    with sqlite3.connect(tmp_path / "auth.db") as connection:
        connection.execute(
            "UPDATE sessions SET expires_at = ? WHERE token_hash = ?",
            (int(time.time()) - 1, token_hash),
        )
    assert client.get("/private").status_code == 401
    assert client.get("/auth/me").status_code == 401


def test_logout_revokes_the_session_and_clears_the_cookie(tmp_path):
    client = TestClient(_app(tmp_path / "auth.db"))
    assert _register(client, "Alice").status_code == 201
    assert client.post(
        "/auth/login",
        json={"name": "Alice", "password": "safePass123"},
    ).status_code == 200
    response = client.post("/auth/logout")
    assert response.status_code == 204
    assert client.get("/auth/me").status_code == 401
    assert client.get("/private").status_code == 401


def test_user_cannot_read_update_or_delete_another_users_conversation(tmp_path):
    app = _app(tmp_path / "auth.db")
    alice = TestClient(app)
    bob = TestClient(app)
    alice_user = _register(alice, "Alice").json()["user"]
    bob_user = _register(bob, "Bob").json()["user"]
    assert alice.post(
        "/auth/login",
        json={"name": "Alice", "password": "safePass123"},
    ).status_code == 200
    assert bob.post(
        "/auth/login",
        json={"name": "Bob", "password": "safePass123"},
    ).status_code == 200
    conversation = {
        "id": "conversation-1",
        "title": "Private",
        "createdAt": 1,
        "updatedAt": 1,
        "model": "model",
        "messages": [{"id": "m1", "role": "user", "content": "secret"}],
    }
    assert alice.post("/v1/conversations", json=conversation).status_code == 201
    assert alice.get("/v1/conversations").json()["conversations"] == [conversation]
    assert bob.get("/v1/conversations").json()["conversations"] == []
    assert bob.put(
        "/v1/conversations/conversation-1", json=conversation
    ).status_code == 404
    assert bob.delete("/v1/conversations/conversation-1").status_code == 404
    assert alice.get("/v1/conversations").json()["conversations"][0]["messages"][0][
        "content"
    ] == "secret"
    assert alice_user["id"] != bob_user["id"]


def test_legacy_import_is_admin_only_and_idempotent(tmp_path):
    app = _app(tmp_path / "auth.db")
    admin = TestClient(app)
    user = TestClient(app)
    _register(admin, "Admin")
    _register(user, "Member")
    assert admin.post(
        "/auth/login",
        json={"name": "Admin", "password": "safePass123"},
    ).status_code == 200
    assert user.post(
        "/auth/login",
        json={"name": "Member", "password": "safePass123"},
    ).status_code == 200
    legacy = [
        {
            "id": "legacy-1",
            "title": "Old chat",
            "createdAt": 10,
            "updatedAt": 20,
            "model": "old-model",
            "messages": [],
        }
    ]
    assert (
        user.post(
            "/v1/conversations/legacy-import",
            json={"conversations": legacy},
        ).status_code
        == 403
    )
    assert admin.post(
        "/v1/conversations/legacy-import",
        json={"conversations": legacy},
    ).json() == {"imported": True, "count": 1}
    assert admin.post(
        "/v1/conversations/legacy-import",
        json={"conversations": []},
    ).json() == {"imported": False, "count": 0}


def test_websocket_requires_a_session(tmp_path):
    client = TestClient(_app(tmp_path / "auth.db"))
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/private-ws"):
            pass


def test_password_hash_uses_a_unique_salt():
    first = hash_password("safePass123")
    second = hash_password("safePass123")
    assert first != second
    assert first.startswith("scrypt$")


def test_every_http_route_in_the_app_requires_a_session(tmp_path):
    from openjarvis.core.config import JarvisConfig
    from openjarvis.server.app import create_app

    config = JarvisConfig()
    config.analytics.enabled = False
    config.traces.enabled = False
    config.security.enabled = False
    engine = MagicMock()
    engine.health.return_value = True
    app = create_app(
        engine,
        "test-model",
        config=config,
        auth_store=AuthStore(tmp_path / "all-routes.db"),
    )
    client = TestClient(app)
    auth_paths = {"/auth/register", "/auth/login", "/auth/logout", "/auth/me"}
    for route in app.routes:
        path = getattr(route, "path", "")
        methods = getattr(route, "methods", None)
        if not methods:
            continue
        if path in auth_paths or path == "/health":
            continue
        request_path = re.sub(r"\{[^}]+\}", "test-id", path)
        for method in methods - {"OPTIONS"}:
            response = client.request(method, request_path)
            assert response.status_code == 401, (
                method,
                path,
                response.status_code,
            )
