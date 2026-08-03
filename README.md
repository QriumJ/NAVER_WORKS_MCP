# NAVER WORKS MCP

Hermes에서 자연어로 NAVER WORKS의 **일정·연락처·구성원 정보**를 조회하게 해 주는 MCP 서버입니다. 처음에는 안전한 읽기 전용으로 동작하며, MCP 프로토콜 `2026-07-28`의 무상태 HTTP 규칙과 로컬 stdio 연결을 함께 제공합니다.

> 처음 사용하는 분은 [비개발자용 HTML 설명서](docs/hermes_naver_works_setup.html)를 먼저 여세요. 화면에서 순서대로 따라 하면 됩니다.

## 이 프로젝트가 하는 일

- Hermes가 MCP 도구를 호출하면 NAVER WORKS API에 읽기 요청을 보냅니다.
- 일정 속성, 일정 목록, 연락처 검색, 조직 구성원 목록/프로필을 제공합니다.
- 기본값은 로컬 컴퓨터에서만 실행되는 `stdio`입니다. 인터넷에 공개하지 않아 가장 안전합니다.
- 실제 토큰이 없을 때는 `NAVER_WORKS_MOCK=true`로 연결 연습과 계약 테스트를 할 수 있습니다.
- 메시지 보내기, 수정/삭제, Mail·Drive·Board·Task·Form 같은 기능은 현재 등록하지 않았습니다.

## 먼저 준비할 것

1. Windows/macOS/Linux 중 하나
2. Node.js 20.11 이상
3. NAVER WORKS Developer Console에서 발급한 사용자 OAuth Access Token
4. 조회할 NAVER WORKS 사용자의 `userId`
5. Hermes의 MCP 서버 추가 화면

OAuth 로그인·Refresh Token 갱신·Service Account JWT 서명은 이 저장소가 담당하지 않습니다. 외부 OAuth/Secret Provider에서 발급한 **Bearer Access Token**을 환경 변수로 넣는 구조입니다. 토큰은 GitHub, README, HTML 파일에 절대 적지 마세요.

## 10분 안에 로컬 연결하기

### 1) 소스 받기

이미 이 폴더가 있다면 이 단계는 건너뛰세요.

```powershell
git clone https://github.com/QriumJ/NAVER_WORKS_MCP.git
Set-Location NAVER_WORKS_MCP
```

### 2) 설치하고 설정 파일 만들기

```powershell
npm install
Copy-Item .env.example .env
```

`.env`를 메모장으로 열어 먼저 **연습 모드**로 확인합니다.

```dotenv
MCP_TRANSPORT=stdio
NAVER_WORKS_MOCK=true
NAVER_WORKS_USER_ID=mock-user
```

### 3) 빌드와 테스트

```powershell
npm run build
npm test
```

`22 passing`이 나오면 프로그램 자체는 정상입니다.

### 4) Hermes에 서버 등록

Hermes의 `MCP 서버 추가` 화면에서 전송 방식은 `stdio`를 선택하고, 아래 값을 넣습니다. Hermes 버전에 따라 항목 이름이 `command`, `args`, `env` 또는 `실행 파일`, `인자`, `환경 변수`로 보일 수 있습니다.

```json
{
  "name": "naver-works",
  "command": "node",
  "args": ["C:\\Users\\Home\\Documents\\네이버웍스\\dist\\index.js"],
  "env": {
    "MCP_TRANSPORT": "stdio",
    "NAVER_WORKS_MOCK": "true",
    "NAVER_WORKS_USER_ID": "mock-user"
  }
}
```

`args`의 경로는 실제 폴더에 맞게 바꾸세요. 프로젝트가 다른 폴더에 있다면 `dist\index.js`의 전체 경로를 넣습니다. Hermes에 `cwd`(작업 폴더) 항목이 있다면 이 프로젝트 폴더를 지정하면 `.env`도 자동으로 읽습니다.

### 5) Hermes에서 확인

서버를 저장하고 Hermes 채팅에서 다음처럼 말해 보세요.

```
NAVER WORKS에서 내 프로필을 조회해 줘.
```

연습 모드에서는 `mock-user`가 반환됩니다. 응답이 오면 Hermes ↔ MCP 연결은 끝난 것입니다.

## 실제 NAVER WORKS API 연결

### 1) Developer Console에서 확인

앱의 사용자 OAuth 권한에 다음 읽기 Scope를 요청합니다.

```
calendar.read
contact.read
directory.read
user.profile.read
```

조직 정책에 따라 관리자 승인과 Redirect URL 등록이 필요할 수 있습니다. 실제 토큰은 OAuth 로그인 후 외부 Token Provider에서 발급받으세요.

### 2) `.env`에 실제 값 입력

```dotenv
MCP_TRANSPORT=stdio
NAVER_WORKS_MOCK=false
NAVER_WORKS_ACCESS_TOKEN=여기에_짧은_수명의_Bearer_토큰
NAVER_WORKS_USER_ID=조회할_사용자_ID
NAVER_WORKS_AUTH_MODE=user_oauth
NAVER_WORKS_API_BASE=https://www.worksapis.com/v1.0
NAVER_WORKS_ENFORCE_SCOPES=true
NAVER_WORKS_SCOPES=calendar.read,contact.read,directory.read,user.profile.read
```

토큰 앞에 `Bearer `를 붙이지 마세요. 서버가 요청 헤더에 자동으로 붙입니다. 토큰을 바꾼 뒤 Hermes를 완전히 다시 시작해야 새 환경 변수가 반영됩니다.

## HTTP로 연결하고 싶은 경우(고급)

대부분의 개인 사용자는 stdio를 권장합니다. 다른 컴퓨터나 원격 Hermes가 연결해야 할 때만 HTTP를 사용하세요.

```powershell
npm run build
$env:MCP_TRANSPORT="http"
$env:MCP_HOST="127.0.0.1"
$env:MCP_PORT="8787"
node dist/index.js
```

정상 실행 후 `http://127.0.0.1:8787/healthz`에서 상태를 확인할 수 있습니다. HTTP `/mcp`는 MCP `2026-07-28` strict stateless envelope와 표준 헤더를 요구합니다. 원격 바인딩은 32자 이상의 `MCP_SHARED_SECRET`, 허용 Host 목록, TLS reverse proxy가 모두 필요합니다. 공유 시크릿 없이 인터넷에 공개하지 마세요.

## 제공되는 도구

| 도구 | 쉬운 설명 |
| --- | --- |
| `works_health` | NAVER WORKS API 연결 상태 확인 |
| `works_calendar_default_properties` | 기본 캘린더 목록 |
| `works_calendar_personals_list` | 개인 캘린더 목록 |
| `works_calendar_default_events_list` | 기본 캘린더 일정 |
| `works_calendar_events_list` | 지정 캘린더 일정 |
| `works_contact_search_minimal` | 이름·전화·이메일로 연락처 검색 |
| `works_directory_users_list` | 조직 구성원 목록 |
| `works_directory_user_profile_get` | 한 명의 최소 프로필 조회 |

PII는 필요한 최소 필드만 반환하고, 쓰기·삭제 도구는 의도적으로 없습니다.

## 자주 생기는 문제

| 증상 | 해결 |
| --- | --- |
| `node`를 찾을 수 없음 | Node.js 20.11 이상 설치 후 Hermes를 다시 시작 |
| `dist/index.js`가 없음 | 프로젝트 폴더에서 `npm run build` 실행 |
| 토큰이 없다는 오류 | `.env` 또는 Hermes `env`에 `NAVER_WORKS_ACCESS_TOKEN` 입력 |
| Scope 부족(403) | Developer Console 권한과 실제 토큰 Scope를 확인하고 새 토큰 발급 |
| Hermes가 도구를 못 봄 | command는 `node`, args는 `dist/index.js` 전체 경로인지 확인 |
| 실제 데이터 대신 mock-user가 나옴 | `NAVER_WORKS_MOCK=false`로 바꾸고 Hermes 재시작 |
| HTTP 401/403 | `MCP_SHARED_SECRET`, Host/Origin 허용 목록, TLS 프록시 설정 확인 |

## 검수 및 문서

```powershell
npm run build
npm test
npm audit --omit=dev
```

현재 검수 결과는 **98/100**, P0/P1 결함 없음입니다. 남은 항목은 포트 문자열의 더 엄격한 파싱, 실테넌트 권한 검증, 실제 Hermes 클라이언트의 2026-07-28 지원 확인 같은 운영 단계입니다.

- [비개발자용 Hermes·NAVER WORKS 연결 설명서](docs/hermes_naver_works_setup.html)
- [MCP 2026-07-28 기획·검수 기록](docs/naver_works_mcp_plan_2026-07-28.md)
- [NAVER WORKS API 공식 문서](https://developers.worksmobile.com/kr/docs/api)
- [MCP 2026-07-28 설명](https://we0.ai/ko/articles/mcp-2026-07-28-explained-stateless)
- [MCP 2025-11-25 배경](https://blog.modelcontextprotocol.io/posts/2025-11-25-first-mcp-anniversary/)
