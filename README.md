# NAVER WORKS MCP

## 쓰기 기능은 안전하게 선택해서 사용합니다

기본값은 읽기 전용입니다. `NAVER_WORKS_WRITE_ENABLED=false`이면 쓰기 Tool이 `tools/list`에 등록되지 않습니다. 게시판·그룹 Note·일정·할 일의 생성/수정과 Bot 텍스트 전송을 사용하려면 NAVER WORKS에서 해당 일반 Scope를 승인하고 다음을 설정한 뒤 MCP/Hermes를 재시작하세요.

```dotenv
NAVER_WORKS_WRITE_ENABLED=true
NAVER_WORKS_DELETE_ENABLED=false
NAVER_WORKS_SCOPES=calendar,board,group.note,task,bot.message,bot,calendar.read,board.read,group.note.read,task.read,bot.read,directory.read,contact.read,user.profile.read
```

삭제 Tool은 `NAVER_WORKS_DELETE_ENABLED=true`까지 별도로 켜야 나타납니다. 쓰기 Tool은 매 호출 `confirm=true`가 필수이므로, Hermes는 실행 전에 대상·내용·수신자·삭제 여부를 사용자에게 보여주고 다시 승인받아야 합니다. 끄려면 두 환경변수를 `false`로 바꾸고 MCP를 재시작하세요. Scope를 추가해도 MCP에 등록되지 않은 API(Contact, File, Mail, Audit 등)는 호출되지 않습니다.

Hermes에서 자연어로 NAVER WORKS의 **일정·주소록·구성원·그룹·공지 정보**를 조회하고, 명시적으로 켠 경우에만 승인형 쓰기 작업을 수행하는 MCP 서버입니다. 주소록은 `contact.read`로 읽기 전용 연결되며 Contact 생성·수정·삭제는 별도 Tool로 등록하지 않습니다. MCP 프로토콜 `2026-07-28`의 무상태 HTTP 규칙과 로컬 stdio 연결을 함께 제공합니다.

> 처음 사용하는 분은 [비개발자용 HTML 설명서](docs/hermes_naver_works_setup.html)를 먼저 여세요. 화면에서 순서대로 따라 하면 됩니다.

## 이 프로젝트가 하는 일

- Hermes가 MCP 도구를 호출하면 NAVER WORKS API에 읽기 요청을 보냅니다.
- 일정 속성/목록, 조직 구성원/그룹/조직 목록과 프로필, 게시판·그룹 노트 공지, 할 일·Bot·설문 메타데이터를 제공합니다.
- 기본값은 로컬 컴퓨터에서만 실행되는 `stdio`입니다. 인터넷에 공개하지 않아 가장 안전합니다.
- 실제 토큰이 없을 때는 `NAVER_WORKS_MOCK=true`로 연결 연습과 계약 테스트를 할 수 있습니다.
- 기본 모드에서는 메시지 보내기, 수정/삭제 기능이 꺼져 있습니다. `NAVER_WORKS_WRITE_ENABLED=true`일 때만 일정·게시판·그룹 Note·할 일 쓰기와 Bot 텍스트 전송 Tool이 노출되고, `NAVER_WORKS_DELETE_ENABLED=true`를 추가해야 삭제 Tool이 노출됩니다. 주소록은 목록·상세 읽기만 제공하며 Mail·Drive·Security·Audit·Archive 기능은 등록하지 않았습니다.

## 먼저 준비할 것

1. Windows/macOS/Linux 중 하나
2. Node.js 20.11 이상
3. NAVER WORKS Developer Console에서 발급한 사용자 OAuth Access Token (`contact.read` 포함)
4. 조회할 NAVER WORKS 사용자의 `userId`
5. Hermes의 MCP 서버 추가 화면

OAuth 로그인·Refresh Token 갱신·Service Account JWT 서명은 이 저장소가 담당하지 않습니다. 외부 OAuth/Secret Provider에서 발급한 **Bearer Access Token**을 환경 변수로 넣는 구조입니다. 토큰은 GitHub, README, HTML 파일에 절대 적지 마세요.

## 지원 환경과 연결 방식

| 환경 | Hermes와 MCP 관계 | 권장 연결 |
| --- | --- | --- |
| Windows 또는 Ubuntu에 둘 다 설치 | 같은 컴퓨터에서 실행 | `stdio` |
| Hermes만 Docker 안에서 실행 | MCP도 같은 컨테이너에 포함 | 컨테이너 내부 `stdio` |
| Hermes와 MCP가 서로 다른 컨테이너 | Docker 네트워크로 통신 | 내부 HTTP `/mcp` |
| 외부 PC에서 접속 | reverse proxy를 거치는 원격 서비스 | TLS + 공유 시크릿 HTTP |

운영 환경을 자동으로 판단하지 말고, 설치 지시문이 먼저 운영체제·컨테이너 여부·Hermes의 터미널 실행 가능 여부를 확인하게 하세요. 개인 PC에서는 `stdio`가 가장 단순하고 안전합니다.

## 10분 안에 로컬 연결하기

### 1) 소스 받기

이미 이 폴더가 있다면 이 단계는 건너뛰세요.

Windows PowerShell:

```powershell
git clone https://github.com/QriumJ/NAVER_WORKS_MCP.git NAVER_WORKS_MCP
Set-Location NAVER_WORKS_MCP
```

Ubuntu:

```bash
git clone https://github.com/QriumJ/NAVER_WORKS_MCP.git NAVER_WORKS_MCP
cd NAVER_WORKS_MCP
```

현재 완성본은 GitHub `main`에 병합되어 있습니다. 특정 개발 브랜치를 시험할 때만 `--branch 브랜치명`을 추가하세요.

### 2) 설치하고 설정 파일 만들기

Windows PowerShell:

```powershell
npm install
Copy-Item .env.example .env
```

Ubuntu:

```bash
npm install
cp .env.example .env
```

`.env`를 메모장으로 열어 먼저 **연습 모드**로 확인합니다.

```dotenv
MCP_TRANSPORT=stdio
NAVER_WORKS_MOCK=true
NAVER_WORKS_USER_ID=mock-user
```

### 3) 빌드와 테스트

Windows PowerShell 또는 Ubuntu:

```bash
npm run build
npm test
```

`22 passing`이 나오면 프로그램 자체는 정상입니다.

### 4) Hermes에 서버 등록

Hermes의 `MCP 서버 추가` 화면에서 전송 방식은 `stdio`를 선택하고, 아래처럼 현재 운영체제의 절대 경로를 넣습니다. Hermes 버전에 따라 항목 이름이 `command`, `args`, `env` 또는 `실행 파일`, `인자`, `환경 변수`로 보일 수 있습니다.

Windows:

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

Ubuntu:

```json
{
  "name": "naver-works",
  "command": "node",
  "args": ["/home/your-user/NAVER_WORKS_MCP/dist/index.js"],
  "env": {
    "MCP_TRANSPORT": "stdio",
    "NAVER_WORKS_MOCK": "true",
    "NAVER_WORKS_USER_ID": "mock-user"
  }
}
```

`args`의 경로는 실제 폴더에 맞게 바꾸세요. Windows는 `C:\...\\dist\index.js`, Ubuntu는 `/home/.../dist/index.js`처럼 운영체제의 절대 경로를 사용합니다. Hermes에 `cwd`(작업 폴더) 항목이 있다면 이 프로젝트 폴더를 지정하면 `.env`도 자동으로 읽습니다.

### 5) Hermes에서 확인

서버를 저장하고 Hermes 채팅에서 다음처럼 말해 보세요.

```
NAVER WORKS에서 내 프로필을 조회해 줘.
```

연습 모드에서는 `mock-user`가 반환됩니다. 응답이 오면 Hermes ↔ MCP 연결은 끝난 것입니다.

## Hermes 채팅으로 설치시키는 지시문

Hermes가 터미널과 파일을 실행할 수 있다면 아래 지시문 전체를 Hermes 채팅에 붙여 넣으세요. Hermes가 실행 권한을 지원하지 않는 경우에는 명령을 대신 보여 달라고 요청하고, 이 README의 명령을 직접 실행하면 됩니다.

```text
내 환경을 먼저 확인한 뒤 NAVER WORKS MCP를 설치하고 Hermes에 연결해 줘.

규칙:
1. 운영체제가 Windows인지 Ubuntu/Linux인지, Hermes가 Docker 컨테이너 안에서 실행 중인지, 터미널·파일 실행 권한이 있는지 먼저 확인하고 결과를 알려 줘.
2. Node.js 20.11 이상, npm, Git이 설치되어 있는지 확인해. Docker라면 Docker 이미지에서 Node.js 22 이상을 사용해.
3. 기존 저장소가 있으면 파일을 삭제하지 말고 현재 변경사항과 브랜치를 먼저 확인해.
4. 저장소가 없으면 기본 `main`을 내려받아. Windows는 PowerShell 경로, Ubuntu는 bash 경로를 사용해:
   git clone https://github.com/QriumJ/NAVER_WORKS_MCP.git NAVER_WORKS_MCP
5. 저장소 폴더에서 npm install과 npm run build를 실행해. Docker라면 Dockerfile 또는 compose.yaml을 사용해.
6. 실제 토큰을 요구하거나 출력하지 말고, NAVER_WORKS_MOCK=true로 npm test를 실행해 22개 테스트 결과를 확인해.
7. Hermes와 MCP가 같은 환경이면 stdio를 사용해. 다른 Docker 컨테이너라면 MCP를 compose.yaml의 HTTP 서비스로 띄우고 Hermes에는 http://naver-works-mcp:8787/mcp를 설정해.
8. HTTP Docker 서비스는 MCP_HOST=0.0.0.0, 32자 이상 MCP_SHARED_SECRET, MCP_ALLOWED_HOSTS에 실제 서비스 이름을 설정하고 외부 공개 시 TLS reverse proxy를 사용해. 공유 시크릿을 채팅에 출력하지 마.
9. 설치·빌드·테스트·등록 결과를 단계별로 보고하고, 실패하면 원인과 다음 명령만 알려 줘.
10. NAVER_WORKS_ACCESS_TOKEN, 비밀번호, 개인정보를 채팅에 출력하거나 Git에 커밋하지 마.
11. 실제 NAVER WORKS 연결은 내가 별도로 OAuth 토큰을 준비했다고 말한 뒤에만 진행해. 그때도 토큰 값은 화면에 다시 출력하지 말고 환경 변수나 Secret Manager에만 저장해.
12. 기본은 읽기 전용으로 두고, 쓰기·삭제·메시지 전송은 환경변수와 매 호출 `confirm=true` 승인으로 명시적으로 켜.
```

Hermes가 “설치 완료”라고 답하면 채팅에서 `NAVER WORKS에서 내 프로필을 조회해 줘`라고 테스트하세요. 실제 데이터를 연결할 때만 `NAVER_WORKS_MOCK=false`와 외부 Token Provider가 발급한 Access Token을 설정합니다.

## Docker에서 Hermes와 연결하기

### A. Hermes와 MCP가 같은 Docker 컨테이너에 있을 때

이미지를 빌드한 뒤 stdio 프로세스로 실행합니다. MCP 프로토콜은 줄바꿈 기반이므로 `-i`를 사용하고 `-t`(가상 터미널)는 붙이지 않습니다.

Windows PowerShell:

```powershell
docker build -t naver-works-mcp:local .
docker run --rm -i --env-file .env naver-works-mcp:local node dist/index.js
```

Ubuntu:

```bash
docker build -t naver-works-mcp:local .
docker run --rm -i --env-file .env naver-works-mcp:local node dist/index.js
```

Hermes가 Docker 밖에 있고 Docker MCP를 자식 프로세스로 실행할 수 있으면 Hermes의 stdio 설정을 `command=docker`로, 인자를 `run --rm -i --env-file <절대경로>/.env naver-works-mcp:local node dist/index.js`로 지정합니다.

### B. Hermes와 MCP가 서로 다른 Docker 컨테이너일 때

이 저장소의 `compose.yaml`은 MCP를 HTTP 서비스로 띄우고, 호스트에는 loopback으로만 포트를 공개합니다. 먼저 `.env`에 32자 이상의 `MCP_SHARED_SECRET`을 직접 생성해 넣으세요.

Windows PowerShell:

```powershell
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
docker compose up --build
```

Ubuntu:

```bash
cp .env.example .env
openssl rand -hex 32
docker compose up --build
```

출력한 랜덤 문자열은 `.env`의 `MCP_SHARED_SECRET` 값으로만 저장합니다. 다른 컨테이너의 Hermes는 서비스 이름을 사용해 `http://naver-works-mcp:8787/mcp`에 연결하고, `X-MCP-Shared-Secret` 헤더를 보냅니다. Hermes가 MCP `2026-07-28` HTTP envelope를 지원하지 않으면 B 방식 대신 A 방식(stdio)을 사용하세요.

## 실제 NAVER WORKS API 연결

### 1) Developer Console에서 확인

앱의 사용자 OAuth 권한에 다음 읽기 Scope를 요청합니다.

```
calendar.read
directory.read
contact.read
user.profile.read
board.read
group.read
group.note.read
task.read
bot.read
orgunit.read
form.read
```

조직 정책에 따라 관리자 승인과 Redirect URL 등록이 필요할 수 있습니다. 실제 토큰은 OAuth 로그인 후 외부 Token Provider에서 발급받으세요.

위 Scope 중 현재 사용하지 않는 기능은 Developer Console과 `.env`에서 빼도 됩니다. Scope를 새로 추가하면 기존 Access Token에는 자동 반영되지 않으므로 OAuth 인증을 다시 진행해 새 토큰을 발급해야 합니다. `board.read`는 일반 게시판 공지, `group.note.read`는 조직·그룹 노트 공지에 사용합니다.

### 2) `.env`에 실제 값 입력

```dotenv
MCP_TRANSPORT=stdio
NAVER_WORKS_MOCK=false
NAVER_WORKS_ACCESS_TOKEN=여기에_짧은_수명의_Bearer_토큰
NAVER_WORKS_USER_ID=조회할_사용자_ID
NAVER_WORKS_AUTH_MODE=user_oauth
NAVER_WORKS_API_BASE=https://www.worksapis.com/v1.0
NAVER_WORKS_ENFORCE_SCOPES=true
NAVER_WORKS_SCOPES=calendar.read,directory.read,contact.read,user.profile.read,board.read,group.read,group.note.read,task.read,bot.read,orgunit.read,form.read
```

토큰 앞에 `Bearer `를 붙이지 마세요. 서버가 요청 헤더에 자동으로 붙입니다. 토큰을 바꾼 뒤 Hermes를 완전히 다시 시작해야 새 환경 변수가 반영됩니다.

## HTTP로 연결하고 싶은 경우(고급)

대부분의 개인 사용자는 stdio를 권장합니다. 다른 컴퓨터나 원격 Hermes가 연결해야 할 때만 HTTP를 사용하세요.

Windows PowerShell:

```powershell
npm run build
$env:MCP_TRANSPORT="http"
$env:MCP_HOST="127.0.0.1"
$env:MCP_PORT="8787"
node dist/index.js
```

Ubuntu:

```bash
npm run build
MCP_TRANSPORT=http MCP_HOST=127.0.0.1 MCP_PORT=8787 node dist/index.js
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
| `works_directory_users_list` | 조직 구성원 목록 |
| `works_directory_user_profile_get` | 한 명의 최소 프로필 조회 |
| `works_contacts_list` | 접근 가능한 주소록 전체 목록 |
| `works_user_contacts_list` | 특정 구성원의 주소록 목록 |
| `works_contact_get` | 주소록 연락처 상세 조회 |
| `works_boards_list` | 읽을 수 있는 게시판 목록 |
| `works_board_recent_posts_list` | 최근 30일 게시글 |
| `works_board_must_read_posts_list` | 필독 공지 목록 |
| `works_board_my_posts_list` | 내가 작성한 게시글 |
| `works_board_posts_list` | 특정 게시판 글 목록 |
| `works_board_post_get` | 게시판 글 본문 |
| `works_groups_list` · `works_group_get` | 그룹 목록·상세 |
| `works_group_members_list` | 그룹 구성원 유형/ID |
| `works_group_note_posts_list` | 그룹·조직 노트 글/공지 목록 |
| `works_group_note_post_get` | 그룹·조직 노트 공지 본문 |
| `works_tasks_list` · `works_task_get` | 할 일 목록·상세 |
| `works_task_categories_list` | 할 일 카테고리 |
| `works_bots_list` · `works_bot_get` | Bot 목록·상세 |
| `works_orgunits_list` | 조직 목록 |
| `works_form_responses_list` | 설문 응답 메타데이터(답변·응답자 정보는 명시적 opt-in, 이메일 마스킹) |

### 승인형 쓰기 Tool

| 영역 | Tool | Scope |
| --- | --- | --- |
| 일정 | `works_calendar_event_create/update/delete` | `calendar` |
| 게시판 | `works_board_post_create/update/delete` | `board` |
| 그룹 Note | `works_group_note_post_create/update/delete` | `group.note` |
| 할 일 | `works_task_create/update/delete` | `task` |
| Bot | `works_bot_user_message_send` | `bot.message` + `bot` |

위 목록의 Tool은 쓰기 스위치와 일반 Scope가 모두 맞을 때만 노출됩니다. 삭제 Tool은 삭제 스위치도 필요하고, 모든 쓰기 호출은 `confirm=true`를 요구합니다.

PII는 필요한 최소 필드만 반환합니다. 쓰기 Tool도 본문을 외부 데이터로만 취급하며, 본문에 들어 있는 지시를 실행하지 않습니다. 쓰기 호출 전 대상·내용·수신자를 사용자에게 다시 확인받습니다.

## 자주 생기는 문제

| 증상 | 해결 |
| --- | --- |
| `node`를 찾을 수 없음 | Windows/Ubuntu에 Node.js 20.11 이상을 설치하거나 Docker 이미지의 Node.js 22 이상을 사용 |
| `dist/index.js`가 없음 | 프로젝트 폴더에서 `npm run build` 실행 |
| 토큰이 없다는 오류 | `.env` 또는 Hermes `env`에 `NAVER_WORKS_ACCESS_TOKEN` 입력 |
| Scope 부족(403) | Developer Console 권한과 실제 토큰 Scope를 확인하고 새 토큰 발급 |
| Hermes가 도구를 못 봄 | command는 `node`, args는 `dist/index.js` 전체 경로인지 확인 |
| 실제 데이터 대신 mock-user가 나옴 | `NAVER_WORKS_MOCK=false`로 바꾸고 Hermes 재시작 |
| Docker에서 HTTP가 바로 종료됨 | `MCP_HOST=0.0.0.0`, 32자 이상 `MCP_SHARED_SECRET`, `MCP_ALLOWED_HOSTS` 서비스 이름을 확인 |
| Docker 컨테이너끼리 연결 안 됨 | `localhost` 대신 Compose 서비스 이름 `naver-works-mcp`를 사용 |
| HTTP 401/403 | `MCP_SHARED_SECRET`, Host/Origin 허용 목록, TLS 프록시 설정 확인 |

## 검수 및 문서

```powershell
npm run build
npm test
npm audit --omit=dev
```

현재 검수 결과는 **98/100**, P0/P1 결함 없음입니다. 남은 항목은 포트 문자열의 더 엄격한 파싱, 실테넌트 권한 검증, 실제 Hermes 클라이언트의 2026-07-28 지원 확인 같은 운영 단계입니다.

- [비개발자용 Hermes·NAVER WORKS 연결 설명서](docs/hermes_naver_works_setup.html)
- [Docker 이미지](Dockerfile) · [Docker Compose 구성](compose.yaml)
- [MCP 2026-07-28 기획·검수 기록](docs/naver_works_mcp_plan_2026-07-28.md)
- [NAVER WORKS API 공식 문서](https://developers.worksmobile.com/kr/docs/api)
- [MCP 2026-07-28 설명](https://we0.ai/ko/articles/mcp-2026-07-28-explained-stateless)
- [MCP 2025-11-25 배경](https://blog.modelcontextprotocol.io/posts/2025-11-25-first-mcp-anniversary/)
