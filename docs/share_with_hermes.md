# Hermes에 NAVER WORKS 연결하기 — 공유용 설치 지시문

아래 저장소와 가이드를 읽고, 내 환경을 먼저 확인한 뒤 설치해 주세요.

## 링크

- 저장소: https://github.com/QriumJ/NAVER_WORKS_MCP
- 초보자용 HTML 가이드: https://github.com/QriumJ/NAVER_WORKS_MCP/blob/main/docs/hermes_naver_works_setup.html
- HTML 원문(자동 읽기용): https://raw.githubusercontent.com/QriumJ/NAVER_WORKS_MCP/main/docs/hermes_naver_works_setup.html
- 이 설치 지시문: https://github.com/QriumJ/NAVER_WORKS_MCP/blob/main/docs/share_with_hermes.md
- 설치 지시문 원문: https://raw.githubusercontent.com/QriumJ/NAVER_WORKS_MCP/main/docs/share_with_hermes.md
- 상세 설치 지시문(권장): https://github.com/QriumJ/NAVER_WORKS_MCP/blob/main/docs/hermes_install_instruction.txt
- 상세 설치 지시문 원문(복사용): https://raw.githubusercontent.com/QriumJ/NAVER_WORKS_MCP/main/docs/hermes_install_instruction.txt
- NAVER WORKS API: https://developers.worksmobile.com/kr/docs/api
- NAVER WORKS OAuth: https://developers.worksmobile.com/kr/docs/auth-oauth
- NAVER WORKS OAuth Scope: https://developers.worksmobile.com/kr/docs/auth-scope
- MCP 2026-07-28 설명: https://we0.ai/ko/articles/mcp-2026-07-28-explained-stateless
- MCP 공식 블로그: https://blog.modelcontextprotocol.io/posts/2025-11-25-first-mcp-anniversary/

## Hermes에 전달할 설치 지시문

당신은 설치 담당자입니다. 아래 순서를 지키세요.

1. Windows, Ubuntu/Linux, Docker 중 현재 Hermes 실행 환경을 먼저 확인합니다.
2. 기존 프로젝트, 설정, 컨테이너를 삭제하지 말고 현재 상태와 경로를 먼저 보여 줍니다.
3. Node.js/npm/Git 또는 Docker 설치 여부를 확인합니다.
4. 저장소를 clone하고 의존성을 설치합니다.

   \`\`\`text
   git clone https://github.com/QriumJ/NAVER_WORKS_MCP.git NAVER_WORKS_MCP
   cd NAVER_WORKS_MCP
   npm install
   \`\`\`

   `main`에서 읽기 전용 8개만 보이면 오래된 checkout일 수 있습니다. 쓰기·삭제·`works_api_call`이 포함된 승인 소스는 `eef97ff66bfbe4c11647e947d07da07d4743f9f8`입니다. 해당 commit을 가져오지 못하면 임의의 다른 branch로 바꾸지 말고 중단해 주세요.

5. 먼저 실제 계정이 아닌 연습 모드로 실행합니다.

   \`\`\`dotenv
   MCP_TRANSPORT=stdio
   NAVER_WORKS_MOCK=true
   NAVER_WORKS_USER_ID=mock-user
   \`\`\`

6. \`npm run build\`와 \`npm test\`를 실행하고 결과를 보여 줍니다.
7. 테스트가 통과한 뒤 Hermes MCP에 등록합니다.
   - Hermes와 MCP가 같은 환경이면 \`node dist/index.js\`를 stdio로 사용합니다.
   - 서로 다른 Docker 컨테이너면 MCP 서비스 주소 \`http://naver-works-mcp:8787/mcp\`를 사용합니다.
8. Hermes에 등록한 \`command\`, \`args\`, \`env\`와 \`dist/index.js\` 전체 경로를 보여 줍니다.
9. 다음 문장으로 연결을 확인합니다.

   > NAVER WORKS에서 내 프로필을 조회해 줘.

10. \`mock-user\`가 반환되면 설치와 MCP 전송이 성공한 것입니다.
11. 실제 OAuth는 내가 Developer Console 권한과 토큰을 준비했다고 말한 뒤에만 진행합니다.
    인증 중 Developer Console 웹훅 등록 또는 확인이 필요하면 김형진 차장에게 문의합니다. 웹훅 주소와 이벤트 범위는 임의로 입력하지 않습니다.
12. Client Secret, Authorization Code, Access Token을 요청하거나 출력하거나 채팅·GitHub에 저장하지 않습니다.
13. 초기 설정에서 전체 Tool을 등록하되, API Key Scope와 Access Token이 허용한 요청만 실행합니다. 쓰기·삭제·메시지 전송은 매 호출 `confirm=true` 승인으로만 실행합니다.
14. OAuth와 Docker 연결 단계에서는 HTML 가이드의 `Docker 실제 연결값 주입` 절을 먼저 읽고 그대로 진행합니다. OAuth가 끝나면 기존 `.env`를 백업한 뒤 `NAVER_WORKS_MOCK=false`, 새 `NAVER_WORKS_ACCESS_TOKEN`, `NAVER_WORKS_AUTH_MODE=user_oauth`, `NAVER_WORKS_USER_ID=me`, `NAVER_WORKS_ENFORCE_SCOPES=true`를 반영합니다. 쓰기·삭제 플래그는 사용자가 승인한 경우에만 켭니다.
15. 갱신한 `.env` 파일 자체만 SFTP로 `/opt/data/NAVER_WORKS_MCP/.env`에 업로드하고 Hermes를 재시작합니다. 토큰 문자열은 채팅에 복사하지 않습니다.
16. 실패하면 실행한 명령, 오류 원인, 다음에 입력할 명령을 초보자도 이해할 수 있게 설명합니다.

현재 Developer Console에서 선택된 OAuth 기본 Scope는 다음과 같습니다. 배치 도우미도 이 목록만 요청합니다.

```text
openid, profile, email, board, board.read, calendar, calendar.read, contact, contact.read,
directory.read, form, form.read, group.folder.read, group.note.read, group.read, orgunit.read,
security.external-browser, security.external-browser.read, task, task.read,
user.email.read, user.profile.read, user.read
```

`audit*`, `bot*`, `directory`, `group`, `group.folder`, `group.note`, `orgunit`, `user`는 현재 미선택입니다. 해당 권한을 Developer Console에 추가하기 전에는 OAuth URL에 넣지 않습니다.

## Docker에서 실제 계정을 연결할 때

먼저 두 환경을 구분합니다.

- **기존 Hermes 컨테이너 안에 `/opt/data/NAVER_WORKS_MCP`가 있는 경우(권장):** 새 Docker 컨테이너를 만들지 않습니다. Windows에서 OAuth 도우미가 만든 `.env`를 SFTP로 `/opt/data/NAVER_WORKS_MCP/.env`에 업로드하고 Hermes만 재시작합니다.
- **Hermes와 MCP가 서로 다른 컨테이너인 경우:** 이때만 `docker compose up -d --build --force-recreate`로 `naver-works-mcp` 서비스를 새로 만듭니다. Hermes 컨테이너 자체를 새로 만드는 작업은 아닙니다.

기존 Hermes 컨테이너 방식에서는 `/opt/data/config.yaml`의 NAVER WORKS MCP 항목이 `/opt/data/NAVER_WORKS_MCP`를 작업 폴더로 사용해야 합니다. `NAVER_WORKS_MOCK=true` 또는 빈 `NAVER_WORKS_ACCESS_TOKEN`을 Hermes 설정의 `env`에 넣어 두었다면 제거합니다. MCP는 프로젝트 루트의 `.env`를 읽으므로 토큰을 `config.yaml`이나 채팅에 중복 입력하지 않습니다.

OAuth는 가능하면 호스트 PC에서 먼저 완료합니다. 발급된 토큰을 프로젝트 루트의 \`.env\`에 넣고 컨테이너를 재생성합니다.

\`\`\`dotenv
MCP_TRANSPORT=http
MCP_HOST=0.0.0.0
MCP_PORT=8787
MCP_SHARED_SECRET=<32자_이상_공유시크릿>
MCP_ALLOWED_HOSTS=localhost,127.0.0.1,[::1],naver-works-mcp,hermes

NAVER_WORKS_API_BASE=https://www.worksapis.com/v1.0
NAVER_WORKS_MOCK=false
NAVER_WORKS_ACCESS_TOKEN=<OAuth로_발급된_토큰>
NAVER_WORKS_AUTH_MODE=user_oauth
NAVER_WORKS_USER_ID=me
NAVER_WORKS_ENFORCE_SCOPES=true
NAVER_WORKS_WRITE_ENABLED=true
NAVER_WORKS_DELETE_ENABLED=true
\`\`\`

그 다음 실행합니다.

\`\`\`bash
docker compose up -d --build --force-recreate
docker compose ps
docker compose logs --tail=50 naver-works-mcp
curl http://127.0.0.1:8787/healthz
\`\`\`

Hermes도 Docker 안에 있다면 \`localhost\`가 아니라 다음 주소를 사용합니다.

\`\`\`text
http://naver-works-mcp:8787/mcp
X-MCP-Shared-Secret: <.env의 MCP_SHARED_SECRET와 같은 값>
\`\`\`

토큰을 Dockerfile, \`compose.yaml\`, 이미지 레이어, Git 커밋에 직접 넣지 않습니다.

## 설치 완료 후 보고할 내용

- 실행 환경과 OS
- 설치 경로
- build/test 결과
- Hermes MCP 등록 상태
- 발견된 전체 NAVER WORKS Tool 목록
- \`works_health\` 결과
- 실제 NAVER WORKS API를 호출했는지 여부
