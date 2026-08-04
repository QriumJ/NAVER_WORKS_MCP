# NAVER WORKS MCP 기획 수정·생성·검수본

기준 문서: `C:\Users\Home\Downloads\Telegram Desktop\naver_works_free_mcp_plan.html`  
기준일: 2026-08-03  
결정: NAVER WORKS 읽기 기본 모드와 MCP `2026-07-28` 무상태 서버를 유지하고, 쓰기·삭제·메시지 전송은 별도 Scope·환경변수·호출 승인으로 확장한다.

## 1. 기획 수정 판정

| 기존 기획 항목 | 수정 판정 | 구현 반영 |
| --- | --- | --- |
| MCP + Skill 계층 분리 | 유지 | `skills/naver-works/SKILL.md`에 읽기 흐름과 변경 승인 원칙을 분리 |
| Free API당 60회/분, 동시 5개 | 공식 문서와 일치 | `WorksApiClient`에 식별자를 제거한 operation route별 프로세스 공용 window와 semaphore 5 적용(다중 replica는 Redis 등 공유 limiter 필요) |
| User OAuth/Service Account 분리 | 공식 문서와 일치 | `NAVER_WORKS_AUTH_MODE`, `userId=me` 차단, 서비스 계정 금지 경로 차단 |
| 인증 수명주기 | 외부 Provider 전제 | 이 MVP는 OAuth code/refresh·JWT 서명을 수행하지 않고 Secret/Token Provider가 발급한 Bearer Token만 주입받음 |
| 읽기 MVP | Calendar·Directory부터 활성화 | 기존 읽기 전용 `works_*` Tool 유지 |
| Free 읽기 확장 | 추천도 높음/매우 높음인 Calendar·User·Organization·Group·Bot과 공지에 필요한 Board·Group/Note·Task·Form을 읽기 전용으로 확장 | 새 `works_*` 조회 Tool과 mock 계약 테스트 추가 |
| 추천도 중간 이하 API | Mail·Drive·Audit·Security·Archive/Compliance(낮음 이하) | MCP Tool과 기본 Scope에서 제외. 주소록은 사용자 요청으로 `contact.read` 읽기 Tool만 선택형 추가 |
| 공지사항 | Board의 recent/must/board post와 조직·그룹 Note의 `isNotice`를 각각 지원 | `works_board_must_read_posts_list`, `works_board_post_get`, `works_group_note_posts_list`, `works_group_note_post_get` |
| 쓰기 승인 | MCP 내부에서 강제 | `NAVER_WORKS_WRITE_ENABLED`가 꺼지면 Tool 미등록, 호출마다 `confirm=true`; 삭제는 `NAVER_WORKS_DELETE_ENABLED` 추가 |
| 외부 콘텐츠 | 데이터로만 처리 | 캘린더 속성은 ID/이름/공개 여부/형식만, 일정은 설명·참석자 제거, 구성원은 최소 projection |
| 기존 MCP 세션 방식 | 2026-07-28에 맞게 수정 | HTTP `createMcpHandler` strict modern + `legacy: reject`, per-request factory |
| 서버 상태 저장 | 프로토콜 상태와 애플리케이션 상태 분리 | 세션 저장소 없음; API 호출별 새 `McpServer` 생성 |
| 오류·재시도 | POST 자동 재시도 금지 | GET의 408/429/5xx만 제한 재시도, 쓰기 요청은 1회만 시도 |
| 입출력 상한 | DoS 경계 추가 | HTTP 요청 1 MiB·15초, 상류 응답 2 MiB, 413/408 처리 |

## 2. MCP 2026-07-28 적용 체크

- [x] `MCP-Protocol-Version: 2026-07-28`을 현대 HTTP 요청의 기준으로 사용
- [x] `initialize` 및 `Mcp-Session-Id`를 HTTP 경로에서 사용하지 않음
- [x] 요청 `params._meta`에 `io.modelcontextprotocol/protocolVersion`, `io.modelcontextprotocol/clientCapabilities`를 요구
- [x] `server/discover`와 `tools/list`/`tools/call`은 SDK가 처리
- [x] `Mcp-Method` 헤더 검증은 SDK에 위임; `Mcp-Name`은 tools/call의 Tool 이름과 교차 검증
- [x] `server/discover`/`tools/list`에 2026-07-28 cache hint(`ttlMs`, `cacheScope`)를 설정
- [x] per-request factory로 수평 확장 시 서버 인스턴스 간 세션 고정이 없음
- [x] 구형 클라이언트는 stdio에서만 `legacy: serve`로 호환. HTTP endpoint는 혼용을 막기 위해 strict
- [x] deprecated Roots/Sampling/Logging을 새 코드에서 사용하지 않음
- [x] 외부 HTTP 바인딩은 공유 시크릿과 명시적 Host/Origin allowlist 없이는 설정 오류
- [x] 비-mock API Base는 HTTPS만 허용하고 shared secret 비교는 constant-time

## 3. 생성물

- `src/config.ts`: 환경 변수, 인증 모드, Scope 정책, Host/Origin allowlist, 공개 상태 projection
- `src/works-api.ts`: NAVER WORKS API 클라이언트, Bearer 토큰, Free 제한, GET 재시도, PII projection, mock fixture
- `src/server.ts`: typed `works_*` read/write Tool 등록, 기본 OFF·confirm 게이트
- `src/index.ts`: stdio 및 strict stateless Streamable HTTP `/mcp`, `/healthz`
- `skills/naver-works/SKILL.md`: 자연어 업무 계층, 데이터/지시문 경계, 변경 승인 원칙
- `.env.example`, `README.md`: 설치·실행·Hermes 연결 기준

주소록 읽기 추가:

- `works_contacts_list`, `works_user_contacts_list`, `works_contact_get`은 NAVER WORKS Contact API의 목록·구성원별 목록·상세 GET만 호출한다.
- `contact.read`가 로컬 Scope 정책에 없으면 요청을 차단한다. 이메일은 일부 마스킹하고 메모·태그·커스텀 속성은 projection에서 제거한다.
- Contact 생성·수정·삭제는 이번 변경에 포함하지 않는다.

## 4. 검수 결과

### 원본 첨부파일에 대한 검증 경계

- 원본 HTML의 “Mini-GPT 4관점”, “Sol 1·2차 PASS_WITH_WARNING” 표기는 이 작업공간에 검수 로그나 재현 가능한 보고서가 없으므로 사실 증거로 승계하지 않았다.
- 원본의 기준 SHA 저장소는 이 작업공간에 clone되어 있지 않아 저장소 구현 여부·라이선스·의존성은 재검증하지 않았다. 이번 생성물은 해당 저장소를 런타임 의존성으로 사용하지 않는다.
- 실제 Developer Console·OAuth 동의·Access Token·테넌트 API 호출은 외부 계정 권한과 사용자 승인이 필요하므로 이번 검수 범위 밖이다.
- OAuth Authorization Code/Refresh Token과 Service Account JWT 발급은 이 저장소의 책임 범위가 아니며, 외부 Secret/Token Provider 연동을 전제로 한다.

### 통과

- TypeScript strict build (`npm run build`)
- 공식 NAVER WORKS endpoint 기준: Calendar, Directory users, Board/Note/Task/Form 등 읽기 범위
- Scope 기본값은 읽기 최소 범위로 제한
- API 원문을 모델에 그대로 내보내지 않는 allowlist/type-checked projection
- 토큰·Private Key를 로그/health 응답에 포함하지 않음
- mock 모드로 자격증명 없이 계약 테스트 가능

### 사용자/테넌트 확인 필요

- Developer Console에서 실제 Free Scope 표시와 앱 Redirect URL
- User OAuth Access/Refresh Token 발급 및 저장소(OS keyring/Secret Manager)
- Service Account를 쓰는 경우 위임 구성원과 허용 API
- 실제 테넌트의 Calendar/Directory/Board·Note 응답 필드 및 Admin 설정
- Hermes 클라이언트의 2026-07-28 지원 여부와 HTTP 사용 시 header/envelope 생성 방식

### 보류

- Group/OrgUnit 관리, 첨부·파일, 댓글/반응 등 아직 등록하지 않은 쓰기·관리 작업
- Mail·Drive(file.read) 및 Audit/Monitoring, 경영지원 API
- 승인 토큰 저장·폐기·감사 추적(쓰기 Tool 활성화 시 별도 모듈)

## 4-1. 승인형 쓰기 확장 검수 결과

쓰기 기능은 현재 다음 범위로 구현했다.

- 일정: `works_calendar_event_create`, `works_calendar_event_update`, `works_calendar_event_delete`
- 게시판: `works_board_post_create`, `works_board_post_update`, `works_board_post_delete`
- 그룹 Note: `works_group_note_post_create`, `works_group_note_post_update`, `works_group_note_post_delete`
- 할 일: `works_task_create`, `works_task_update`, `works_task_delete`
- Bot: `works_bot_user_message_send` (텍스트 사용자 메시지)

모든 생성·수정 Tool은 일반 Scope와 `NAVER_WORKS_WRITE_ENABLED=true`가 필요하며, 호출 입력에 `confirm=true`가 없으면 실패한다. 삭제 Tool은 `NAVER_WORKS_DELETE_ENABLED=true`까지 켜야 `tools/list`에 나타난다. 기본 읽기 모드의 도구 목록에는 쓰기 Tool이 없어야 한다.

## 5. 검수 실행 순서

```powershell
npm install
npm run build
$env:NAVER_WORKS_MOCK="true"
npm test
```

실계정 검증은 `.env`에 Token을 넣기 전에 Developer Console Scope와 테넌트 조건을 이 문서의 표에 기록한 뒤 수행한다. 실계정 호출은 읽기 Tool 하나씩, 31일보다 짧은 기간, 마스킹 결과 확인 순서로 진행한다.

## 6. 출처

- [NAVER WORKS API 개요](https://developers.worksmobile.com/kr/docs/api)
- [User OAuth](https://developers.worksmobile.com/kr/docs/auth-oauth)
- [Service Account JWT](https://developers.worksmobile.com/kr/docs/auth-jwt)
- [OAuth Scope](https://developers.worksmobile.com/kr/docs/auth-scope)
- [Rate Limits](https://developers.worksmobile.com/kr/docs/rate-limits)
- [Calendar API](https://developers.worksmobile.com/kr/docs/calendar)
- [Directory users](https://developers.worksmobile.com/kr/docs/user-list)
- [MCP 2026-07-28 release candidate / stateless protocol](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- [MCP 2026-07-28 final release](https://github.com/modelcontextprotocol/modelcontextprotocol/releases/tag/2026-07-28)
- [MCP 2025-11-25 anniversary release context](https://blog.modelcontextprotocol.io/posts/2025-11-25-first-mcp-anniversary/)
- [We0.ai 2026-07-28 stateless 설명](https://we0.ai/ko/articles/mcp-2026-07-28-explained-stateless)
