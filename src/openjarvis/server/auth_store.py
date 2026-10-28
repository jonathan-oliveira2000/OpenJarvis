"""SQLite persistence for web users, sessions, and conversations."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

from openjarvis.core.paths import get_config_dir

SESSION_COOKIE_NAME = "openjarvis_session"
MIN_USERNAME_LENGTH = 3
MIN_PASSWORD_LENGTH = 8


def _get_compatible_auth_env(name: str, default: str) -> str:
    return os.environ.get(f"MEGA_{name}", os.environ.get(f"JARVIS_{name}", default))


SESSION_TTL_SECONDS = max(
    60, int(_get_compatible_auth_env("SESSION_TTL_SECONDS", "604800"))
)
RATE_LIMIT_MAX_FAILURES = max(
    1, int(_get_compatible_auth_env("AUTH_MAX_FAILURES", "5"))
)
RATE_LIMIT_WINDOW_SECONDS = max(
    1, int(_get_compatible_auth_env("AUTH_RATE_WINDOW_SECONDS", "900"))
)
_SCRYPT_N = 1 << 14
_SCRYPT_R = 8
_SCRYPT_P = 1


def normalize_username(username: str) -> str:
    return username.strip().casefold()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=32,
    )
    return "$".join(
        (
            "scrypt",
            str(_SCRYPT_N),
            str(_SCRYPT_R),
            str(_SCRYPT_P),
            base64.urlsafe_b64encode(salt).decode("ascii"),
            base64.urlsafe_b64encode(digest).decode("ascii"),
        )
    )


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, n, r, p, salt_text, digest_text = encoded.split("$")
        if algorithm != "scrypt":
            return False
        salt = base64.urlsafe_b64decode(salt_text)
        expected = base64.urlsafe_b64decode(digest_text)
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt,
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(expected),
        )
    except (ValueError, TypeError, UnicodeError):
        return False
    return hmac.compare_digest(actual, expected)


class AuthStore:
    """Owns the auth database; each operation uses a short-lived connection."""

    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path) if path else get_config_dir() / "web-auth.db"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._migrate()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def _migrate(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    username TEXT NOT NULL,
                    username_key TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS sessions_user_id
                    ON sessions(user_id);
                CREATE TABLE IF NOT EXISTS login_failures (
                    subject_hash TEXT PRIMARY KEY,
                    failures INTEGER NOT NULL,
                    window_started_at INTEGER NOT NULL,
                    blocked_until INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    payload_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS conversations_user_updated
                    ON conversations(user_id, updated_at DESC);
                CREATE TABLE IF NOT EXISTS legacy_imports (
                    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    imported_at INTEGER NOT NULL,
                    imported_count INTEGER NOT NULL
                );
                """
            )

    @staticmethod
    def _public_user(row: sqlite3.Row) -> dict[str, str]:
        return {
            "id": str(row["id"]),
            "name": str(row["username"]),
            "role": str(row["role"]),
        }

    def seed_admin(self, username: str, password: str) -> None:
        name = username.strip()
        key = normalize_username(name)
        now = int(time.time())
        password_hash = hash_password(password)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT id FROM users WHERE username_key = ?", (key,)
            ).fetchone()
            if row:
                connection.execute(
                    "UPDATE users SET username = ?, password_hash = ?, role = 'admin' "
                    "WHERE id = ?",
                    (name, password_hash, row["id"]),
                )
            else:
                connection.execute(
                    "INSERT INTO users "
                    "(id, username, username_key, password_hash, role, created_at) "
                    "VALUES (?, ?, ?, ?, 'admin', ?)",
                    (str(uuid.uuid4()), name, key, password_hash, now),
                )

    def register(self, username: str, password: str) -> dict[str, str]:
        name = username.strip()
        key = normalize_username(name)
        now = int(time.time())
        user_id = str(uuid.uuid4())
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            role = (
                "admin"
                if connection.execute("SELECT 1 FROM users LIMIT 1").fetchone() is None
                else "user"
            )
            connection.execute(
                "INSERT INTO users "
                "(id, username, username_key, password_hash, role, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (user_id, name, key, hash_password(password), role, now),
            )
            row = connection.execute(
                "SELECT id, username, role FROM users WHERE id = ?", (user_id,)
            ).fetchone()
        assert row is not None
        return self._public_user(row)

    def find_user(self, username: str) -> tuple[dict[str, str], str] | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT id, username, role, password_hash FROM users "
                "WHERE username_key = ?",
                (normalize_username(username),),
            ).fetchone()
        if row is None:
            return None
        return self._public_user(row), str(row["password_hash"])

    def create_session(
        self, user_id: str, ttl_seconds: int = SESSION_TTL_SECONDS
    ) -> tuple[str, int]:
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        expires_at = now + ttl_seconds
        token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) "
                "VALUES (?, ?, ?, ?)",
                (token_hash, user_id, now, expires_at),
            )
        return token, expires_at

    def get_user_for_token(self, token: str | None) -> dict[str, str] | None:
        if not token:
            return None
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        now = int(time.time())
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT users.id, users.username, users.role, sessions.expires_at
                FROM sessions JOIN users ON users.id = sessions.user_id
                WHERE sessions.token_hash = ?
                """,
                (token_hash,),
            ).fetchone()
            if row is None:
                return None
            if int(row["expires_at"]) <= now:
                connection.execute(
                    "DELETE FROM sessions WHERE token_hash = ?", (token_hash,)
                )
                return None
            return self._public_user(row)

    def delete_session(self, token: str | None) -> None:
        if not token:
            return
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        with self._connect() as connection:
            connection.execute(
                "DELETE FROM sessions WHERE token_hash = ?", (token_hash,)
            )

    @staticmethod
    def _failure_hash(kind: str, value: str) -> str:
        return hashlib.sha256(f"{kind}\0{value}".encode("utf-8")).hexdigest()

    def is_rate_limited(self, ip: str, username: str) -> bool:
        now = int(time.time())
        subjects = (
            self._failure_hash("ip", ip),
            self._failure_hash("name", normalize_username(username)),
        )
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT blocked_until FROM login_failures "
                "WHERE subject_hash IN (?, ?)",
                subjects,
            ).fetchall()
        return any(int(row["blocked_until"]) > now for row in rows)

    def record_login_failure(self, ip: str, username: str) -> None:
        now = int(time.time())
        subjects = (
            self._failure_hash("ip", ip),
            self._failure_hash("name", normalize_username(username)),
        )
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            for subject_hash in subjects:
                row = connection.execute(
                    "SELECT failures, window_started_at FROM login_failures "
                    "WHERE subject_hash = ?",
                    (subject_hash,),
                ).fetchone()
                if row is None or now - int(row["window_started_at"]) >= RATE_LIMIT_WINDOW_SECONDS:
                    failures = 1
                    window_started_at = now
                else:
                    failures = int(row["failures"]) + 1
                    window_started_at = int(row["window_started_at"])
                blocked_until = (
                    now + RATE_LIMIT_WINDOW_SECONDS
                    if failures >= RATE_LIMIT_MAX_FAILURES
                    else 0
                )
                connection.execute(
                    """
                    INSERT INTO login_failures
                    (subject_hash, failures, window_started_at, blocked_until)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(subject_hash) DO UPDATE SET
                        failures = excluded.failures,
                        window_started_at = excluded.window_started_at,
                        blocked_until = excluded.blocked_until
                    """,
                    (subject_hash, failures, window_started_at, blocked_until),
                )

    def clear_login_failures(self, ip: str, username: str) -> None:
        subjects = (
            self._failure_hash("ip", ip),
            self._failure_hash("name", normalize_username(username)),
        )
        with self._connect() as connection:
            connection.executemany(
                "DELETE FROM login_failures WHERE subject_hash = ?",
                ((subject,) for subject in subjects),
            )

    def list_conversations(self, user_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT payload_json FROM conversations WHERE user_id = ? "
                "ORDER BY updated_at DESC",
                (user_id,),
            ).fetchall()
        return [json.loads(row["payload_json"]) for row in rows]

    def save_conversation(self, user_id: str, conversation: dict[str, Any]) -> None:
        conversation_id = str(conversation.get("id", ""))
        if not conversation_id:
            raise ValueError("Conversation id is required")
        payload = json.dumps(conversation, ensure_ascii=False, separators=(",", ":"))
        now = int(time.time() * 1000)
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO conversations (id, user_id, payload_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    payload_json = excluded.payload_json,
                    updated_at = excluded.updated_at
                WHERE conversations.user_id = excluded.user_id
                """,
                (
                    conversation_id,
                    user_id,
                    payload,
                    int(conversation.get("createdAt", now)),
                    int(conversation.get("updatedAt", now)),
                ),
            )
            owner = connection.execute(
                "SELECT user_id FROM conversations WHERE id = ?",
                (conversation_id,),
            ).fetchone()
            if owner is None or str(owner["user_id"]) != user_id:
                raise PermissionError("Conversation not found")

    def delete_conversation(self, user_id: str, conversation_id: str) -> bool:
        with self._connect() as connection:
            cursor = connection.execute(
                "DELETE FROM conversations WHERE id = ? AND user_id = ?",
                (conversation_id, user_id),
            )
        return cursor.rowcount > 0

    def import_legacy_conversations(
        self, user_id: str, conversations: list[dict[str, Any]]
    ) -> dict[str, int | bool]:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            user = connection.execute(
                "SELECT role FROM users WHERE id = ?", (user_id,)
            ).fetchone()
            if user is None or user["role"] != "admin":
                raise PermissionError("Only an administrator can import legacy data")
            count = 0
            now = int(time.time() * 1000)
            for conversation in conversations:
                conversation_id = str(conversation.get("id", ""))
                if not conversation_id:
                    continue
                payload = json.dumps(
                    conversation, ensure_ascii=False, separators=(",", ":")
                )
                inserted = connection.execute(
                    """
                    INSERT OR IGNORE INTO conversations
                    (id, user_id, payload_json, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        conversation_id,
                        user_id,
                        payload,
                        int(conversation.get("createdAt", now)),
                        int(conversation.get("updatedAt", now)),
                    ),
                )
                count += inserted.rowcount
            if count:
                connection.execute(
                    """
                    INSERT INTO legacy_imports (user_id, imported_at, imported_count)
                    VALUES (?, ?, ?)
                    ON CONFLICT(user_id) DO UPDATE SET
                        imported_at = excluded.imported_at,
                        imported_count = legacy_imports.imported_count
                            + excluded.imported_count
                    """,
                    (user_id, int(time.time()), count),
                )
        return {"imported": bool(count), "count": count}
