#!/usr/bin/env python3
"""Interactive NAVER WORKS OAuth helper for a local Hermes MCP installation.

This script intentionally uses only the Python standard library. It opens the
NAVER WORKS authorization page, receives the callback through a local listener,
exchanges the one-time authorization code, and writes the resulting access
token to the project's ignored .env file. Client Secret, authorization codes,
access tokens, refresh tokens, and OAuth state are never printed.
"""

from __future__ import annotations

import argparse
import getpass
import hmac
import json
import os
import platform
import re
import secrets
import shutil
import subprocess
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Mapping


ROOT = Path(__file__).resolve().parents[1]
TOKEN_ENDPOINT = "https://auth.worksmobile.com/oauth2/v2.0/token"
AUTHORIZE_ENDPOINT = "https://auth.worksmobile.com/oauth2/v2.0/authorize"
# This installation is dedicated to the user's NAVER WORKS organization. The
# CLI flag and .env value can still override it for another tenant.
DEFAULT_NAVER_WORKS_DOMAIN = "knocmaint.by-works.net"
DEFAULT_SCOPES = (
    "openid,profile,email,board,board.read,calendar,calendar.read,contact,contact.read,"
    "directory.read,form,form.read,group.folder.read,group.note.read,group.read,"
    "orgunit.read,security.external-browser,security.external-browser.read,task,task.read,"
    "user.email.read,user.profile.read,user.read"
)
ENV_KEY = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=")
QUICK_TUNNEL_URL = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com", re.IGNORECASE)
CLOUDFLARED_RELEASE_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download/"


class OAuthSetupError(RuntimeError):
    """A user-actionable setup error that must not reveal credential values."""


def parse_dotenv(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        match = ENV_KEY.match(raw_line)
        if not match:
            continue
        key = match.group(1)
        value = raw_line.split("=", 1)[1].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[key] = value
    return values


def normalize_scopes(value: str) -> list[str]:
    scopes: list[str] = []
    for scope in re.split(r"[\s,]+", value.strip()):
        if scope and scope not in scopes:
            scopes.append(scope)
    if not scopes:
        raise OAuthSetupError("OAuth Scope가 비어 있습니다.")
    return scopes


def validate_redirect_uri(value: str) -> urllib.parse.SplitResult:
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != "https" or not parsed.netloc:
        raise OAuthSetupError(
            "Redirect URL은 Developer Console에 등록한 HTTPS 주소여야 합니다. "
            "예: https://oauth.example.com/callback"
        )
    if parsed.username or parsed.password or parsed.fragment or parsed.query:
        raise OAuthSetupError("Redirect URL에는 사용자 정보, query string, fragment를 넣지 마세요.")
    if not parsed.path or parsed.path == "/":
        raise OAuthSetupError("Redirect URL 끝에 콜백 경로를 넣으세요. 예: https://oauth.example.com/callback")
    return parsed


def validate_callback_path(value: str) -> str:
    if not value.startswith("/") or value == "/" or "?" in value or "#" in value:
        raise OAuthSetupError("콜백 경로는 /callback처럼 query/fragment 없는 절대 경로여야 합니다.")
    return value


def is_quick_tunnel_uri(value: str) -> bool:
    hostname = urllib.parse.urlsplit(value).hostname
    return bool(hostname and hostname.lower().endswith(".trycloudflare.com"))


def prompt_value(label: str, existing: str | None, *, secret: bool = False) -> str:
    if existing:
        answer = input(f"{label} (저장된 값 사용: Enter, 새 값 입력): ").strip()
        if answer:
            return answer
        return existing
    if secret:
        return getpass.getpass(f"{label} (화면에 표시되지 않음): ").strip()
    return input(f"{label}: ").strip()


def merge_env_text(current: str, updates: Mapping[str, str]) -> str:
    """Replace every existing copy of target keys, preventing dotenv duplicate drift."""
    emitted: set[str] = set()
    result: list[str] = []
    for line in current.splitlines():
        match = ENV_KEY.match(line)
        if match and match.group(1) in updates:
            key = match.group(1)
            if key not in emitted:
                result.append(f"{key}={updates[key]}")
                emitted.add(key)
            continue
        result.append(line)
    for key, value in updates.items():
        if key not in emitted:
            result.append(f"{key}={value}")
    return "\n".join(result).rstrip() + "\n"


def write_env_file(env_path: Path, updates: Mapping[str, str]) -> None:
    if env_path.exists():
        current = env_path.read_text(encoding="utf-8")
    else:
        example = env_path.parent / ".env.example"
        current = example.read_text(encoding="utf-8") if example.exists() else ""
    merged = merge_env_text(current, updates)
    env_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = env_path.with_name(f".{env_path.name}.{secrets.token_hex(8)}.tmp")
    try:
        temporary.write_text(merged, encoding="utf-8", newline="\n")
        try:
            os.chmod(temporary, 0o600)
        except OSError:
            pass
        os.replace(temporary, env_path)
    finally:
        if temporary.exists():
            temporary.unlink(missing_ok=True)


class CallbackState:
    def __init__(self, expected_state: str, callback_path: str) -> None:
        self.expected_state = expected_state
        self.callback_path = callback_path
        self.done = threading.Event()
        self.authorization_code: str | None = None
        self.user_message: str | None = None


class QuickTunnel:
    """Owns a temporary cloudflared process and exposes only its public URL."""

    def __init__(self, process: subprocess.Popen[str], public_url: str) -> None:
        self.process = process
        self.public_url = public_url.rstrip("/")

    def stop(self) -> None:
        if self.process.poll() is not None:
            return
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)


def local_cloudflared_path() -> Path:
    """Return the repository-local portable cloudflared location."""
    filename = "cloudflared.exe" if os.name == "nt" else "cloudflared"
    return ROOT / ".tools" / "cloudflared" / filename


def resolve_cloudflared() -> str | None:
    """Prefer an existing PATH install, then the ignored portable copy."""
    installed = shutil.which("cloudflared")
    if installed:
        return installed
    portable = local_cloudflared_path()
    return str(portable) if portable.is_file() else None


def install_portable_cloudflared() -> str:
    """Download Cloudflare's official Windows executable into the ignored .tools folder."""
    if os.name != "nt":
        raise OAuthSetupError(
            "cloudflared가 없습니다. Linux에서는 패키지 관리자로 cloudflared를 설치한 뒤 이 도구를 다시 실행하세요."
        )
    machine = platform.machine().lower()
    architecture = "arm64" if machine in {"arm64", "aarch64"} else "amd64"
    destination = local_cloudflared_path()
    temporary = destination.with_suffix(".download")
    download_url = f"{CLOUDFLARED_RELEASE_URL}cloudflared-windows-{architecture}.exe"
    print("cloudflared가 없어 Cloudflare 공식 휴대용 실행 파일을 준비합니다...")
    print(f"저장 위치: {destination.relative_to(ROOT)}")
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(
            download_url,
            headers={"User-Agent": "NAVER-WORKS-MCP-OAuth-Helper/1.0"},
        )
        with urllib.request.urlopen(request, timeout=90) as response, temporary.open("wb") as output:
            shutil.copyfileobj(response, output)
        if temporary.stat().st_size < 1_000_000:
            raise OAuthSetupError("cloudflared 다운로드 파일이 올바르지 않습니다.")
        os.replace(temporary, destination)
        check_options: dict[str, object] = {
            "stdout": subprocess.PIPE,
            "stderr": subprocess.STDOUT,
            "text": True,
            "encoding": "utf-8",
            "errors": "replace",
            "timeout": 15,
            "check": False,
        }
        if os.name == "nt":
            check_options["creationflags"] = subprocess.CREATE_NO_WINDOW
        check = subprocess.run([str(destination), "--version"], **check_options)
        if check.returncode != 0:
            raise OAuthSetupError("다운로드한 cloudflared를 실행하지 못했습니다.")
    except OAuthSetupError:
        raise
    except (OSError, subprocess.SubprocessError, urllib.error.URLError) as error:
        raise OAuthSetupError(
            "cloudflared 자동 준비에 실패했습니다. 네트워크 또는 Windows 보안 알림을 확인한 뒤 다시 실행하세요."
        ) from error
    finally:
        if temporary.exists():
            temporary.unlink(missing_ok=True)
    print("cloudflared 준비를 완료했습니다. 임시 HTTPS 주소를 생성합니다...")
    return str(destination)


def start_quick_tunnel(
    callback_port: int, startup_timeout: int = 30, *, allow_install: bool = True
) -> QuickTunnel:
    executable = resolve_cloudflared()
    if not executable and allow_install:
        executable = install_portable_cloudflared()
    if not executable:
        raise OAuthSetupError(
            "임시 HTTPS 주소를 만들 cloudflared를 찾지 못했습니다. "
            "Cloudflare 공식 cloudflared를 한 번 설치한 뒤 이 도구를 다시 실행하세요."
        )
    startup = threading.Event()
    output: list[str] = []
    public_url: list[str] = []
    options: dict[str, object] = {
        "stdout": subprocess.PIPE,
        "stderr": subprocess.STDOUT,
        "stdin": subprocess.DEVNULL,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "bufsize": 1,
    }
    if os.name == "nt":
        options["creationflags"] = subprocess.CREATE_NO_WINDOW
    process = subprocess.Popen(
        [executable, "tunnel", "--url", f"http://127.0.0.1:{callback_port}"],
        **options,
    )

    def read_output() -> None:
        assert process.stdout is not None
        for line in process.stdout:
            output.append(line.strip())
            output[:] = output[-8:]
            match = QUICK_TUNNEL_URL.search(line)
            if match and not public_url:
                public_url.append(match.group(0))
                startup.set()
        startup.set()

    threading.Thread(target=read_output, daemon=True).start()
    if not startup.wait(startup_timeout) or not public_url:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        hint = ""
        if any("config" in line.lower() for line in output):
            hint = " Quick Tunnel은 ~/.cloudflared의 config.yaml/config.yml 때문에 시작되지 않을 수 있습니다."
        raise OAuthSetupError("Cloudflare Quick Tunnel을 시작하지 못했습니다." + hint)
    return QuickTunnel(process, public_url[0])


def build_callback_handler(state: CallbackState):
    class CallbackHandler(BaseHTTPRequestHandler):
        server_version = "NAVERWORKSOAuth/1.0"
        sys_version = ""

        def log_message(self, _format: str, *_args: object) -> None:
            # The request line includes code/state query values; never log it.
            return

        def send_html(self, status: int, title: str, message: str) -> None:
            page = (
                "<!doctype html><html lang=\"ko\"><meta charset=\"utf-8\">"
                f"<title>{title}</title><body style=\"font-family:system-ui;margin:3rem;line-height:1.6\">"
                f"<h1>{title}</h1><p>{message}</p></body></html>"
            )
            encoded = page.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Pragma", "no-cache")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(encoded)

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            parsed = urllib.parse.urlsplit(self.path)
            if parsed.path != state.callback_path:
                self.send_html(404, "NAVER WORKS OAuth", "요청한 콜백 경로가 아닙니다.")
                return
            query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
            returned_state = query.get("state", [""])[0]
            if not returned_state or not hmac.compare_digest(returned_state, state.expected_state):
                self.send_html(400, "인증을 확인할 수 없습니다", "브라우저를 닫고 자동 연결 도구를 다시 실행하세요.")
                return
            if query.get("error"):
                state.user_message = "NAVER WORKS 로그인이 취소되었거나 권한 승인이 거부되었습니다."
                state.done.set()
                self.send_html(400, "인증이 완료되지 않았습니다", "이 창을 닫고 도구를 다시 실행하세요.")
                return
            code = query.get("code", [""])[0]
            if not code:
                self.send_html(400, "인증을 확인할 수 없습니다", "브라우저를 닫고 자동 연결 도구를 다시 실행하세요.")
                return
            state.authorization_code = code
            state.done.set()
            self.send_html(200, "NAVER WORKS 연결 완료", "인증 정보를 안전하게 저장했습니다. 이 창을 닫고 Hermes를 다시 시작하세요.")

    return CallbackHandler


def exchange_code(code: str, client_id: str, client_secret: str, redirect_uri: str) -> dict[str, object]:
    form = urllib.parse.urlencode(
        {
            "code": code,
            "grant_type": "authorization_code",
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        TOKEN_ENDPOINT,
        data=form,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        # Deliberately avoid echoing the provider body: it may contain externally supplied data.
        raise OAuthSetupError(
            f"토큰 교환이 HTTP {error.code}으로 거부되었습니다. "
            "Client ID·Client Secret·Redirect URL과 새 Authorization Code를 확인하세요."
        ) from error
    except urllib.error.URLError as error:
        raise OAuthSetupError("NAVER WORKS 인증 서버에 연결하지 못했습니다. 네트워크를 확인하세요.") from error
    try:
        data = json.loads(payload)
    except json.JSONDecodeError as error:
        raise OAuthSetupError("토큰 서버 응답을 해석하지 못했습니다.") from error
    if not isinstance(data, dict) or not isinstance(data.get("access_token"), str) or not data["access_token"]:
        raise OAuthSetupError("Access Token이 응답되지 않았습니다. Developer Console 설정을 확인하세요.")
    return data


def authorization_url(client_id: str, redirect_uri: str, scopes: list[str], state: str, domain: str | None) -> str:
    query: dict[str, str] = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": " ".join(scopes),
        "response_type": "code",
        "state": state,
    }
    if domain:
        query["domain"] = domain
    return AUTHORIZE_ENDPOINT + "?" + urllib.parse.urlencode(query)


def run(args: argparse.Namespace) -> int:
    env_path = Path(args.env_file).expanduser().resolve()
    saved = parse_dotenv(env_path)
    client_id = (args.client_id or saved.get("NAVER_WORKS_CLIENT_ID") or "").strip()
    redirect_uri = (args.redirect_uri or saved.get("NAVER_WORKS_REDIRECT_URI") or "").strip()
    # A saved .env normally contains the scopes granted by an earlier token.
    # Do not silently reuse that narrower list on the next authorization run:
    # the current default must be the visible, intentional requested profile.
    # Advanced users can still supply an explicit custom set through --scopes.
    scopes_text = args.scopes or DEFAULT_SCOPES
    domain = (
        args.domain
        or saved.get("NAVER_WORKS_DOMAIN")
        or os.environ.get("NAVER_WORKS_DOMAIN")
        or DEFAULT_NAVER_WORKS_DOMAIN
    ).strip() or None
    use_quick_tunnel = args.quick_tunnel or (
        not args.no_quick_tunnel and (not redirect_uri or is_quick_tunnel_uri(redirect_uri))
    )

    print("\nNAVER WORKS 실제 계정 연결 도우미")
    print("Client Secret·인증 코드·토큰은 화면에 출력하거나 Git에 저장하지 않습니다.\n")
    if not args.client_id:
        client_id = prompt_value("Client ID", client_id)
    if not client_id:
        raise OAuthSetupError("Client ID가 필요합니다.")
    scopes = normalize_scopes(scopes_text)
    if args.callback_port < 1 or args.callback_port > 65535:
        raise OAuthSetupError("콜백 포트는 1~65535 사이여야 합니다.")
    if args.timeout < 1:
        raise OAuthSetupError("로그인 대기 시간은 1초 이상이어야 합니다.")
    if use_quick_tunnel:
        callback_path = validate_callback_path(args.callback_path)
    else:
        if not args.redirect_uri:
            redirect_uri = prompt_value("Developer Console에 등록한 HTTPS Redirect URL", redirect_uri)
        redirect = validate_redirect_uri(redirect_uri)
        callback_path = redirect.path

    print("\n확인된 Scope: " + ", ".join(scopes))
    print("콜백 대기: 127.0.0.1:%d%s" % (args.callback_port, callback_path))
    expected_state = secrets.token_urlsafe(32)
    callback_state = CallbackState(expected_state, callback_path)
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.callback_port), build_callback_handler(callback_state))
    except OSError as error:
        raise OAuthSetupError(
            f"로컬 콜백 포트 {args.callback_port}을 열지 못했습니다. "
            "다른 프로그램을 종료하거나 --callback-port로 다른 포트를 지정하세요."
        ) from error
    server.daemon_threads = True
    listener = threading.Thread(target=server.serve_forever, daemon=True)
    listener.start()
    quick_tunnel: QuickTunnel | None = None
    try:
        if use_quick_tunnel:
            print("Cloudflare 임시 HTTPS Tunnel을 만드는 중입니다...")
            quick_tunnel = start_quick_tunnel(
                args.callback_port, allow_install=not args.no_install_cloudflared
            )
            redirect_uri = quick_tunnel.public_url + callback_path
            print("\n임시 Redirect URL이 생성되었습니다:\n" + redirect_uri)
            print(
                "\n지금 Developer Console에서 이 주소를 Redirect URL에 그대로 붙여넣고 저장하세요.\n"
                "Quick Tunnel 주소는 이 실행 동안만 유효합니다. 다음 실행에는 새 주소를 다시 등록해야 합니다."
            )
            input("저장 완료 후 Enter를 누르면 NAVER WORKS 로그인을 시작합니다: ")
        else:
            print("등록한 HTTPS Redirect URL이 이 PC의 로컬 콜백으로 전달되는지 확인하세요.")
        redirect = validate_redirect_uri(redirect_uri)
        client_secret = prompt_value("Client Secret", None, secret=True)
        if not client_secret:
            raise OAuthSetupError("Client Secret이 필요합니다.")
        url = authorization_url(client_id, redirect_uri, scopes, expected_state, domain)
        print("브라우저에서 NAVER WORKS 로그인과 권한 승인을 진행합니다.")
        if args.no_browser:
            print("브라우저 자동 열기를 끔: 아래 URL을 주소창에 붙여넣으세요.\n" + url)
        else:
            webbrowser.open(url, new=1)
        if not callback_state.done.wait(args.timeout):
            raise OAuthSetupError("%d초 동안 콜백을 받지 못했습니다. Tunnel/프록시와 Redirect URL을 확인하세요." % args.timeout)
        if callback_state.user_message:
            raise OAuthSetupError(callback_state.user_message)
        if not callback_state.authorization_code:
            raise OAuthSetupError("Authorization Code를 받지 못했습니다. 다시 시도하세요.")
        token_response = exchange_code(callback_state.authorization_code, client_id, client_secret, redirect_uri)
    finally:
        server.shutdown()
        server.server_close()
        if quick_tunnel:
            quick_tunnel.stop()

    granted_scopes = normalize_scopes(str(token_response.get("scope") or " ".join(scopes)))
    write_env_file(
        env_path,
        {
            "NAVER_WORKS_CLIENT_ID": client_id,
            "NAVER_WORKS_REDIRECT_URI": redirect_uri,
            "NAVER_WORKS_OAUTH_SCOPES": " ".join(granted_scopes),
            "NAVER_WORKS_ACCESS_TOKEN": str(token_response["access_token"]),
            # Clear a stale ID token when a later OAuth run omits openid.
            "NAVER_WORKS_ID_TOKEN": str(token_response.get("id_token") or ""),
            "NAVER_WORKS_AUTH_MODE": "user_oauth",
            "NAVER_WORKS_USER_ID": "me",
            "NAVER_WORKS_MOCK": "false",
            # A newly generated configuration exposes the complete MCP tool set.
            # API scopes and per-call confirm=true remain the authorization gates.
            "NAVER_WORKS_WRITE_ENABLED": "true",
            "NAVER_WORKS_DELETE_ENABLED": "true",
            "NAVER_WORKS_SCOPES": ",".join(granted_scopes),
        },
    )
    expires = token_response.get("expires_in")
    expiry_text = f" (유효기간: {expires}초)" if isinstance(expires, (str, int)) else ""
    print("\n실제 계정 연결이 완료되었습니다" + expiry_text + ".")
    print(f"토큰은 {env_path.name}에만 저장했고 화면에는 표시하지 않았습니다.")
    print("이제 Hermes 또는 Docker 컨테이너를 완전히 다시 시작하세요.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="NAVER WORKS OAuth를 실행하고 MCP .env를 안전하게 갱신합니다.")
    parser.add_argument("--env-file", default=str(ROOT / ".env"), help="갱신할 .env 경로")
    parser.add_argument("--client-id", help="Client ID (미지정 시 .env 또는 입력값 사용)")
    parser.add_argument("--redirect-uri", help="Developer Console에 등록된 HTTPS Redirect URL")
    parser.add_argument("--scopes", help="공백 또는 쉼표로 구분한 OAuth Scope")
    parser.add_argument("--domain", help="SSO 사용 조직의 도메인 또는 Lite 그룹명")
    parser.add_argument("--callback-port", type=int, default=8788, help="로컬 콜백 포트 (기본 8788)")
    parser.add_argument("--callback-path", default="/callback", help="Quick Tunnel에 사용할 콜백 경로 (기본 /callback)")
    parser.add_argument("--timeout", type=int, default=600, help="로그인 대기 시간(초, 기본 600)")
    parser.add_argument("--no-browser", action="store_true", help="브라우저 자동 열기 없이 URL만 출력")
    parser.add_argument(
        "--no-install-cloudflared",
        action="store_true",
        help="cloudflared 자동 다운로드를 하지 않고, 이미 설치된 실행 파일만 사용",
    )
    tunnel_mode = parser.add_mutually_exclusive_group()
    tunnel_mode.add_argument("--quick-tunnel", action="store_true", help="Cloudflare 임시 HTTPS Tunnel을 강제로 생성")
    tunnel_mode.add_argument("--no-quick-tunnel", action="store_true", help="등록한 고정 Redirect URL만 사용")
    return parser


if __name__ == "__main__":
    try:
        raise SystemExit(run(build_parser().parse_args()))
    except KeyboardInterrupt:
        print("\n사용자가 취소했습니다.", file=sys.stderr)
        raise SystemExit(130)
    except OAuthSetupError as error:
        print("\n연결하지 못했습니다: " + str(error), file=sys.stderr)
        raise SystemExit(1)
    except EOFError:
        print("\n입력이 닫혀 OAuth 연결을 시작하지 못했습니다.", file=sys.stderr)
        raise SystemExit(1)
