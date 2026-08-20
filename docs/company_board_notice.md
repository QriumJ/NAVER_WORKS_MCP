# Hermes용 NAVER WORKS MCP 연결 안내

안녕하십니까.

Hermes에 NAVER WORKS MCP를 연결하면 채팅으로 일정, 주소록, 조직, 게시판, 그룹 노트, 할 일을 조회할 수 있습니다. 권한을 승인한 경우 일정 등록, 게시글 작성, 연락처 수정, 할 일 생성 등도 사용할 수 있습니다.

## 주요 활용

- “오늘 내 일정 알려줘”
- “김형진님의 연락처를 찾아줘”
- “공지사항 최신 글 5개를 요약해줘”
- “우리 부서 구성원 목록을 보여줘”
- “내 미완료 할 일을 정리해줘”
- “내일 오후 2시 회의를 등록해줘. 실행 전에 내용을 보여줘”

조회 권한은 `calendar.read`, `contact.read`, `directory.read`, `board.read`, `group.read`, `group.note.read`, `task.read` 등이 사용됩니다. 일정·주소록·게시판·그룹 노트·할 일을 변경하려면 Developer Console에서 각각 `calendar`, `contact`, `board`, `group.note`, `task` 쓰기 권한을 추가해야 합니다.

## 설치·연결

MCP 프로젝트를 Hermes 환경에 설치하고 실행 파일은 다음 경로로 등록합니다.

```text
/opt/data/NAVER_WORKS_MCP/dist/index.js
```

실제 계정 연결 후 `.env`에는 `NAVER_WORKS_MOCK=false`, OAuth Access Token, `NAVER_WORKS_USER_ID=me`를 설정합니다. `.env`, Client Secret, Authorization Code, Access Token은 채팅·GitHub·게시판에 공유하지 않습니다.

Windows에서는 `run_naver_works_oauth.bat`를 실행해 OAuth 인증을 진행합니다. 화면에 표시된 임시 HTTPS Redirect URL은 Developer Console에 직접 등록·저장해야 합니다. 인증 중 Developer Console 웹훅 등록 또는 확인이 필요하면 김형진 차장에게 문의합니다. 웹훅 주소와 이벤트 범위는 임의로 입력하지 않습니다.

OAuth 완료 후 생성된 `.env` 파일만 SFTP로 `/opt/data/NAVER_WORKS_MCP/.env`에 업로드하고 Hermes를 재시작합니다. 권한을 변경하면 OAuth를 다시 실행해 새 Access Token을 발급해야 합니다.

자세한 절차는 저장소의 HTML 가이드에서 **Docker 실제 연결값 주입** 절을 확인해 주십시오.

## 안전한 사용

처음에는 조회 기능으로 연결을 확인합니다. 쓰기 기능은 `NAVER_WORKS_WRITE_ENABLED=true`, 삭제 기능은 `NAVER_WORKS_DELETE_ENABLED=true`일 때만 사용할 수 있으며, 변경·삭제 요청에는 매번 사용자 확인이 필요합니다. AI가 작성한 내용은 담당자, 날짜, 수치, 업무 내용을 확인한 뒤 공유해 주십시오.

저장소와 상세 가이드는 [QriumJ/NAVER_WORKS_MCP](https://github.com/QriumJ/NAVER_WORKS_MCP)에서 확인할 수 있습니다.
