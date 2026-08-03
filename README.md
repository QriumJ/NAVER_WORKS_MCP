# NAVER WORKS MCP

NAVER WORKS API의 읽기 MVP를 MCP 2026-07-28 무상태 서버로 노출하는 검토용 구현입니다. 기본 실행은 Hermes 등 로컬 MCP 클라이언트용 stdio이고, `MCP_TRANSPORT=http`로 Streamable HTTP를 사용할 수 있습니다.

## 포함 범위

- `works_health`
- `works_calendar_default_properties`
- `works_calendar_personals_list`
- `works_calendar_default_events_list`
- `works_calendar_events_list`
- `works_contact_search_minimal`
- `works_directory_users_list`
- `works_directory_user_profile_get`

변경/삭제, Bot 메시지, Board, Task, Form, Mail, Drive, Audit, Monitoring은 실제 테넌트의 상품·Scope·관리자 조건을 확인한 뒤 별도 승인으로 추가합니다.

## 시작

```powershell
npm install
Copy-Item .env.example .env
# .env에 NAVER_WORKS_ACCESS_TOKEN과 NAVER_WORKS_USER_ID를 설정하거나
# NAVER_WORKS_MOCK=true로 계약 테스트를 실행합니다.
npm run build
npm start
```

HTTP 모드:

```powershell
$env:MCP_TRANSPORT="http"
npm run dev
```

`POST /mcp`는 `MCP-Protocol-Version: 2026-07-28`, 요청별 `_meta.io.modelcontextprotocol` envelope, `Mcp-Method` 헤더가 필요한 strict 모드입니다. `initialize`와 `Mcp-Session-Id`를 사용하지 않습니다. `GET /healthz`는 로컬 상태 점검용입니다.

인증 모드는 API 정책과 Service Account 금지 경로를 선택하는 경계입니다. 이 MVP 자체는 OAuth Authorization Code 교환·Refresh Token 수명주기·Service Account JWT 서명을 수행하지 않으며, 외부 Secret/Token Provider가 발급한 Bearer Access Token을 주입받습니다. 운영에서는 `.env` 대신 Secret Manager를 사용하세요.

HTTP는 기본적으로 loopback에만 바인딩하고 `MCP_ALLOWED_HOSTS`도 loopback만 허용합니다. 외부 바인딩이 필요하면 32자 이상 `MCP_SHARED_SECRET`과 `MCP_ALLOWED_HOSTS`에 프록시 호스트를 설정하고, TLS·인증을 담당하는 reverse proxy 뒤에 두세요. 공유 시크릿 없는 공개 바인딩은 설정 오류로 거부합니다. `/healthz`도 원격에서는 같은 secret/Host/Origin 검사를 받습니다.

HTTP 요청 본문은 1 MiB·15초, NAVER WORKS 응답 본문은 2 MiB로 제한합니다. 초과 요청은 413/408로 종료합니다.

Hermes에 연결할 때는 MCP의 로컬 stdio 설정에서 `node`를 실행 파일로, `C:\Users\Home\Documents\네이버웍스\dist\index.js`를 인자로 지정하고 `.env`의 `NAVER_WORKS_*` 변수를 같은 프로세스에 전달합니다. HTTP를 선택할 때는 클라이언트가 2026-07-28 envelope와 표준 헤더를 생성하고, `MCP_SHARED_SECRET`을 `X-MCP-Shared-Secret` 헤더로 전달하는지 먼저 확인하세요.

## 검수 명령

```powershell
npm run build
$env:NAVER_WORKS_MOCK="true"
npm test
```

공식 기준과 적용 판정은 [`docs/naver_works_mcp_plan_2026-07-28.md`](docs/naver_works_mcp_plan_2026-07-28.md)에, 화면용 요약은 [`docs/naver_works_mcp_plan_2026-07-28.html`](docs/naver_works_mcp_plan_2026-07-28.html)에 정리했습니다.
