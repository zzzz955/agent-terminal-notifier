# Agent Terminal Notifier

Codex CLI, Claude Code, Grok, Gemini CLI, GitHub Copilot CLI의 응답 완료·승인 대기·중단·오류를 알리고, 알림 클릭 시 원래 VSCode 창과 터미널로 이동합니다. 설치 시 PATH에 있는 CLI만 연결합니다.

현재 구현은 **Windows 10/11 + 로컬 VSCode 통합 터미널** 전용입니다. 설치·빌드·검증·제거 절차는 [Windows/README.md](Windows/README.md)를 참조하세요.

**설치·업데이트:** [Windows/apply.bat](Windows/apply.bat)를 더블클릭하면 저장소 기본 브랜치를 받아 설치합니다. 설치된 커밋과 같으면 다시 빌드하지 않습니다. `origin`이 없는 초기 개발 환경에서는 로컬 빌드·검증·설치를 실행하고, 이 체크아웃을 빌드하려면 `apply.bat -Local`을 사용합니다. 결과를 확인할 수 있도록 실행 후 창이 유지됩니다.

릴리즈 제작은 [Windows/release.ps1](Windows/release.ps1), 배포·버전 관리 방법은 [Windows/README.md](Windows/README.md)를 참조하세요.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Windows\scripts\pipeline.ps1
```

기본 파이프라인은 빌드와 자동 검증만 수행합니다. 사용자 설정은 `-Install`을 지정할 때 적용합니다. GitHub 업로드는 직접 수행하세요.
