# Agent Terminal Notifier

Codex CLI / Claude Code의 응답 완료·승인 대기·훅 차단을 알리고, 알림 클릭 시 원래 VSCode 창과 터미널로 이동합니다.

현재 구현은 **Windows 10/11 + 로컬 VSCode 통합 터미널** 전용입니다. 설치·빌드·검증·제거 절차는 [Windows/README.md](Windows/README.md)를 참조하세요.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Windows\scripts\pipeline.ps1
```

기본 파이프라인은 빌드와 자동 검증만 수행합니다. 사용자 설정은 `-Install`을 지정할 때 적용합니다. GitHub 업로드는 직접 수행하세요.
