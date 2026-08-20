@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"

echo.
echo ================================================================
echo  NAVER WORKS OAuth - automatic HTTPS connection helper
echo ================================================================
echo  Login mode: NAVER WORKS account and password
echo  This helper starts OAuth with the official parameter format:
echo    client_id   redirect_uri   response_type=code
echo  SSO domain default: knocmaint.by-works.net
echo  NAVER WORKS may show clientId, redirectUri, or responseType after its
echo  internal browser redirect. That display does not mean this batch failed.
echo.
echo  빠른 로그인 링크
echo  - Developer Console 앱 목록: https://dev.worksmobile.com/kr/console/openapi/v2/app/list/view
echo  - Admin Console 권한 관리: https://admin.worksmobile.com/security/admin
echo  잠시 후 두 관리 페이지를 기본 브라우저에서 엽니다. 로그인 후 이 창으로 돌아오세요.
start "NAVER WORKS Developer Console" "https://dev.worksmobile.com/kr/console/openapi/v2/app/list/view"
start "NAVER WORKS Admin Console" "https://admin.worksmobile.com/security/admin"
echo.

where py >nul 2>&1
if not errorlevel 1 goto use_py

where python >nul 2>&1
if not errorlevel 1 goto use_python

echo Python 3 was not found. Install Python 3 from https://www.python.org/downloads/ and run this file again.
set "OAUTH_EXIT=1"
goto done

:use_py
py -3 scripts\naver_works_oauth.py %*
set "OAUTH_EXIT=%ERRORLEVEL%"
goto done

:use_python
python scripts\naver_works_oauth.py %*
set "OAUTH_EXIT=%ERRORLEVEL%"

:done
echo.
if not "%OAUTH_EXIT%"=="0" echo OAuth was not completed. Read the message above and try again.
pause
exit /b %OAUTH_EXIT%
