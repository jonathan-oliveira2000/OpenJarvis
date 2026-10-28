"""Authentication and per-user conversation endpoints."""

from __future__ import annotations

import ipaddress
import os
import re
import sqlite3
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from starlette import status

from openjarvis.server.auth_store import (
    MIN_PASSWORD_LENGTH,
    MIN_USERNAME_LENGTH,
    SESSION_COOKIE_NAME,
    SESSION_TTL_SECONDS,
    AuthStore,
    _get_compatible_auth_env,
    verify_password,
)

router = APIRouter()
_NAME_PATTERN = re.compile(r".*\S.*", re.DOTALL)
_GENERIC_LOGIN_ERROR = "Nome ou senha inválidos."


class RegisterRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=MIN_USERNAME_LENGTH, max_length=128)
    password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=1024)


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=1024)


class ConversationRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str
    title: str = ""
    createdAt: int
    updatedAt: int
    model: str = "default"
    messages: list[dict[str, Any]] = Field(default_factory=list)


class LegacyImportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conversations: list[dict[str, Any]]


def _store(request: Request) -> AuthStore:
    return request.app.state.auth_store


def _session_cookie_options(request: Request) -> tuple[bool, str]:
    forwarded_proto = request.headers.get("x-forwarded-proto", "").split(",", 1)[0]
    origin = request.headers.get("origin", "")
    hostname = request.url.hostname or ""
    try:
        loopback = hostname == "localhost" or ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        loopback = False
    tauri_origin = origin.startswith(
        ("tauri://", "http://tauri.localhost", "https://tauri.localhost")
    )
    secure = (
        request.url.scheme == "https"
        or forwarded_proto.strip() == "https"
        or (tauri_origin and loopback)
    )
    return secure, "none" if secure else "lax"


def _set_session_cookie(request: Request, response: Response, token: str) -> None:
    secure, same_site = _session_cookie_options(request)
    response.set_cookie(
        SESSION_COOKIE_NAME,
        token,
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        secure=secure,
        samesite=same_site,
        path="/",
    )


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _authenticated_user(request: Request) -> dict[str, str]:
    user = getattr(request.state, "user", None)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sessão inválida ou expirada.",
        )
    return user


@router.post("/auth/register", status_code=status.HTTP_201_CREATED)
def register(payload: RegisterRequest, request: Request):
    name = payload.name.strip()
    if len(name) < MIN_USERNAME_LENGTH or not _NAME_PATTERN.fullmatch(name):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="O nome deve ter pelo menos 3 caracteres.",
        )
    try:
        user = _store(request).register(name, payload.password)
    except sqlite3.IntegrityError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Esse nome já está em uso.",
        ) from exc
    return {"user": user}


@router.post("/auth/login")
def login(payload: LoginRequest, request: Request, response: Response):
    store = _store(request)
    ip = _client_ip(request)
    if store.is_rate_limited(ip, payload.name):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=_GENERIC_LOGIN_ERROR,
        )
    matched = store.find_user(payload.name)
    if matched is None or not verify_password(payload.password, matched[1]):
        store.record_login_failure(ip, payload.name)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=_GENERIC_LOGIN_ERROR,
        )
    user = matched[0]
    store.clear_login_failures(ip, payload.name)
    token, _ = store.create_session(user["id"])
    _set_session_cookie(request, response, token)
    return {"user": user}


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(request: Request, response: Response):
    token = request.cookies.get(SESSION_COOKIE_NAME)
    _store(request).delete_session(token)
    secure, same_site = _session_cookie_options(request)
    response.delete_cookie(
        SESSION_COOKIE_NAME,
        path="/",
        httponly=True,
        secure=secure,
        samesite=same_site,
    )
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/auth/me")
def current_user(request: Request):
    return {"user": _authenticated_user(request)}


@router.get("/v1/conversations")
def list_conversations(request: Request):
    user = _authenticated_user(request)
    return {"conversations": _store(request).list_conversations(user["id"])}


@router.post("/v1/conversations", status_code=status.HTTP_201_CREATED)
def save_conversation(
    payload: ConversationRequest,
    request: Request,
):
    user = _authenticated_user(request)
    try:
        _store(request).save_conversation(user["id"], payload.model_dump())
    except PermissionError as exc:
        raise HTTPException(status_code=404, detail="Conversa não encontrada.") from exc
    return {"conversation": payload.model_dump()}


@router.put("/v1/conversations/{conversation_id}")
def update_conversation(
    conversation_id: str,
    payload: ConversationRequest,
    request: Request,
):
    if payload.id != conversation_id:
        raise HTTPException(status_code=400, detail="ID da conversa inválido.")
    user = _authenticated_user(request)
    try:
        _store(request).save_conversation(user["id"], payload.model_dump())
    except PermissionError as exc:
        raise HTTPException(status_code=404, detail="Conversa não encontrada.") from exc
    return {"conversation": payload.model_dump()}


@router.delete("/v1/conversations/{conversation_id}", status_code=204)
def delete_conversation(conversation_id: str, request: Request):
    user = _authenticated_user(request)
    if not _store(request).delete_conversation(user["id"], conversation_id):
        raise HTTPException(status_code=404, detail="Conversa não encontrada.")
    return Response(status_code=204)


@router.post("/v1/conversations/legacy-import")
def import_legacy_conversations(payload: LegacyImportRequest, request: Request):
    user = _authenticated_user(request)
    try:
        result = _store(request).import_legacy_conversations(
            user["id"], payload.conversations
        )
    except PermissionError as exc:
        raise HTTPException(
            status_code=403,
            detail="Apenas o administrador pode migrar o histórico legado.",
        ) from exc
    return result


def initialize_auth_store(store: AuthStore) -> None:
    admin_name = _get_compatible_auth_env("ADMIN_NAME", "").strip()
    admin_password = _get_compatible_auth_env("ADMIN_PASSWORD", "")
    if bool(admin_name) != bool(admin_password):
        raise RuntimeError(
            "MEGA_ADMIN_NAME and MEGA_ADMIN_PASSWORD must be configured together."
        )
    if admin_name:
        if len(admin_name) < MIN_USERNAME_LENGTH:
            raise RuntimeError("MEGA_ADMIN_NAME must contain at least 3 characters.")
        if len(admin_password) < MIN_PASSWORD_LENGTH:
            raise RuntimeError(
                "MEGA_ADMIN_PASSWORD must contain at least 8 characters."
            )
        store.seed_admin(admin_name, admin_password)
