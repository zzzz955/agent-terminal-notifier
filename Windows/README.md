# Windows 구현

## 동작

```text
Codex notify / lifecycle hook ─┐
Claude Code hook ──────────────┼→ Windows helper (send)
사용자 차단 훅 ────────────────┘    → 부모 프로세스에서 VSCode 셸 PID 탐색
                                  → 창별 named pipe (무작위 인증 토큰)
                                  → VSCode 확장이 해당 터미널 확인
                                  → Windows toast + SFX + 작업표시줄 점멸

알림 클릭 → Windows URL protocol → helper (focus)
         → 원래 창의 확장 → Terminal.show(false)
         → 원래 Windows 창 복원 및 활성화
```

프로젝트명/탭 순번으로 찾지 않습니다. VSCode가 제공한 **셸 PID → 터미널 객체**를 창별로 등록합니다. 알림의 프로젝트명은 훅 payload의 `cwd`에서 얻습니다. 따라서 같은 프로젝트·같은 에이전트를 여러 터미널에서 실행해도 구분합니다. 확장 설치 후 기존 일반 터미널도 등록되므로 실행 명령을 바꿀 필요가 없습니다.

## 준비

- Windows 10 **2004 / build 19041 이상**, 또는 Windows 11.
- 로컬 VSCode Stable (`code.cmd`가 PATH에 있어야 함), VSCode 1.95 이상.
- Node.js **22 이상** 및 npm, **.NET SDK 8 이상**. 설치 시 npm/NuGet 다운로드를 위한 인터넷 필요.
- Windows PowerShell 5.1 또는 PowerShell 7.
- Codex CLI **0.157.1**, Claude Code **2.1.283** 설정 스키마를 기준으로 작성. 오래된 버전은 먼저 업데이트하세요.

빌드된 helper는 self-contained이므로 **실행용 .NET 런타임은 별도 설치하지 않아도 됩니다**. 관리자 실행은 필요하지 않습니다. VSCode와 에이전트는 일반 사용자 권한으로 실행하세요.

## 빌드 → 검증 → 설치

**`Windows/apply.bat`를 더블클릭하면 빌드·검증·설치까지 실행합니다.** 어느 디렉터리에서 실행해도 BAT 파일 위치를 기준으로 파이프라인을 찾으며, 완료/실패 후 창이 유지됩니다. 관리자 권한은 필요하지 않습니다.

ARM64 PC에서는 저장소 루트에서 `Windows\apply.bat -Runtime win-arm64`를 실행하세요.

저장소 루트에서:

```powershell
# 1. 빌드 + 단위 검증 + 실제 Windows IPC 검증 + VSIX 패키징
powershell -NoProfile -ExecutionPolicy Bypass -File .\Windows\scripts\pipeline.ps1

# 2. 검증을 다시 실행한 후 사용자 전역 설치
powershell -NoProfile -ExecutionPolicy Bypass -File .\Windows\scripts\pipeline.ps1 -Install

# 또는 1번에서 만든 결과만 설치
powershell -NoProfile -ExecutionPolicy Bypass -File .\Windows\scripts\install.ps1
```

ARM64 Windows에서는 `pipeline.ps1 -Runtime win-arm64 -Install`을 사용하세요.

산출물은 `Windows/dist/bin/`과 `Windows/dist/agent-terminal-notifier.vsix`입니다. 기본 파이프라인은 사용자 설정·레지스트리·VSCode 설치 상태를 변경하지 않고, 실제 알림도 띄우지 않습니다. IPC 테스트는 임시 디렉터리에 별도 등록을 만들어 검증 후 제거합니다.

설치가 변경하는 범위:

| 위치 | 변경 |
|---|---|
| `%LOCALAPPDATA%/AgentTerminalNotifier/bin/` | helper와 실행 의존성 복사 |
| `%LOCALAPPDATA%/AgentTerminalNotifier/sounds/` | 기본 WAV 4개 생성; 기존 파일은 보존 |
| `%LOCALAPPDATA%/AgentTerminalNotifier/backups/` | 설정 원본 + 복구 manifest |
| 사용자 VSCode 확장 | `local-tools.agent-terminal-notifier` 설치 |
| `HKCU/Software/Classes/agent-terminal-notifier` | 알림 클릭용 URL protocol |
| Windows 알림 앱 등록 | Microsoft notifications toolkit의 사용자 앱 등록 |
| `~/.codex/config.toml` | 완료용 `notify`, 필요 시 `features.hooks = true` |
| `~/.codex/hooks.json` | 승인 요청·사용자 중단 훅 추가 |
| `~/.claude/settings.json` | 응답 종료·알림·API 오류 훅 추가 |

`CODEX_HOME`, `CLAUDE_CONFIG_DIR` 환경 변수가 있으면 그 경로를 사용합니다. 기존 모델·권한·MCP·사용자 훅은 보존합니다. TOML은 주석을 보존하며 필요한 줄만 수정하고, JSON은 의미를 보존하여 재포맷합니다. 기존 `notify`가 있으면 원래 명령/인자를 보관한 `fanout`으로 기존 명령과 새 알림을 함께 실행합니다. 제거 시 원래 명령을 복원합니다. 기존 notify도 별도 소리를 재생한다면 두 소리가 들릴 수 있습니다. 명시적으로 꺼둔 Codex 훅이나 지원하지 않는 설정 형식은 **설정 변경 전 preflight에서 중단**합니다. 반복 설치로 훅이 중복되지 않습니다.

설치 후 **모든 VSCode 창을 Reload Window**하고 Codex/Claude 세션을 다시 시작하세요. Codex가 신규 훅 신뢰 검토를 표시하면 내용을 확인하고 허용해야 실행됩니다. 설치 스크립트는 신뢰 검토를 우회하지 않습니다.

## 직접 테스트: 먼저 가짜 이벤트, 다음 실제 에이전트

1. VSCode 창 두 개(A/B)를 열고, 각 창에서 터미널을 두 개 이상 엽니다. 동일 프로젝트 창/터미널도 테스트하세요.
2. 각 창에 한 번 포커스를 주고, 명령 팔레트에서 **Agent Notifier: Show Registered Terminals** 실행. 셸 PID와 `window captured: true` 확인.
3. A의 첫 터미널을 선택하고 **Agent Notifier: Test Active Terminal** 실행. 완료 SFX와 프로젝트명이 있는 알림 확인.
4. B의 다른 터미널로 이동한 뒤 알림 클릭. **A 창 + A의 원래 터미널 + 입력 커서**로 돌아오는지 확인.
5. A 터미널에서 아래 명령으로 5초 뒤 알림을 예약하고, B 창 또는 다른 앱으로 이동. 알림·SFX·A 창 작업표시줄 점멸 확인.

```powershell
$notifier = Join-Path $env:LOCALAPPDATA 'AgentTerminalNotifier/bin/AgentTerminalNotifier.exe'
Start-Sleep -Seconds 5
'{}' | & $notifier send test attention --strict | Out-Host
```

6. 두 창의 각 터미널에서 반복. 알림 클릭이 같은 프로젝트의 다른 터미널로 가지 않아야 합니다.
7. 알림이 남은 상태에서 해당 터미널을 닫고 클릭. 세션 종료 안내가 나와야 하고 다른 터미널로 이동하면 안 됩니다.
8. 알림을 발생시킨 다음 VSCode를 Reload Window하고 **오래된 알림** 클릭. 오래된 연결은 종료 안내가 나와야 합니다. 새 알림은 복원된 터미널로 정상 이동해야 합니다.
9. 실제 `codex`에 짧은 요청 → 응답 종료 시 알림. 승인 모드에서 승인이 필요한 명령 → 승인 대기 알림. 진행 중 Esc/Ctrl+C 중단 → 중단 알림.
10. 실제 `claude`에 짧은 요청 → 응답 종료 알림. 승인 요청을 약 6초 이상 대기 → 입력 대기 알림. API 오류 발생 시 오류 알림.

Windows 알림 센터에 남은 알림도 클릭할 수 있습니다. 터미널별 마지막 알림으로 교체되며 8시간 후 만료합니다.

## 기존 차단 훅 연결

`PermissionRequest`는 승인 대기이며, **다른 훅이 차단했다는 이벤트와 같지 않습니다**. 다른 훅의 임의 차단을 전역으로 추측하지 않습니다. 실제 거절/차단 분기에 아래 호출을 삽입하세요. 원래 판단 JSON/exit code는 그대로 유지합니다.

```powershell
$notifier = Join-Path $env:LOCALAPPDATA 'AgentTerminalNotifier/bin/AgentTerminalNotifier.exe'
'{}' | & $notifier send hook blocked | Out-Null
# 원래 거절 응답/exit code를 이어서 반환
```

[예제](examples/blocked-hook.ps1)를 참조하세요. 호출은 JSON stdout을 만들지 않고, 알림 전송 실패도 기본 exit 0이므로 훅의 판단을 변경하지 않습니다. 진단할 때만 `--strict`로 실패를 exit 1로 바꾸세요.

## SFX와 설정

기본 파일은 `completed.wav`, `attention.wav`, `blocked.wav`, `error.wav`입니다. 설치 디렉터리의 WAV를 직접 교체하거나 VSCode 설정에서 별도 폴더를 지정하세요. PCM WAV를 사용하면 됩니다.

```json
{
  "agentNotifier.sound": true,
  "agentNotifier.flash": true,
  "agentNotifier.soundDirectory": "C:\\MySounds\\Agents"
}
```

기본 소리는 직접 생성한 짧은 톤입니다. WAV가 없거나 유효하지 않으면 시스템 소리로 대체합니다. 작업표시줄은 해당 창이 비활성일 때 5회 점멸합니다. 같은 세션·이벤트는 10초 동안 중복을 억제하고, Codex는 턴 ID로도 구분합니다.

## 진단과 제한

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Windows\scripts\doctor.ps1
```

- VSCode Output → **Agent Terminal Notifier**: 프로젝트·이벤트·터미널 이름, helper 실패 확인.
- `%LOCALAPPDATA%/AgentTerminalNotifier/errors.log`: 실행 모드와 예외 종류만 기록. 프롬프트/응답/훅 payload/클릭 토큰은 기록하지 않습니다.
- 알림이 안 뜨면 Windows 설정 → 시스템 → 알림, 방해 금지, 앱 알림 허용을 확인하세요. SFX는 별도 재생이므로 방해 금지와 무관하게 들릴 수 있습니다.
- 창 핸들은 해당 VSCode 창에 포커스가 왔을 때 캡처합니다. 설치 후 각 창에 한 번 포커스를 주세요. 핸들을 찾지 못하면 클릭 이동이 실패하며 진단 안내가 나옵니다.
- Windows가 전경 활성화를 거절하는 경우가 있어 실제 클릭 검증이 필요합니다. 우회용 키 입력/마우스 자동화는 사용하지 않습니다.
- **WSL·SSH·Dev Containers·외부 터미널·VSCode 웹은 이번 범위 밖**입니다. 윈도우 네이티브 셸의 프로세스 계보를 사용합니다. 에이전트를 분리된 서비스/백그라운드 작업으로 실행하여 셸 부모 계보가 끊기면 연결되지 않습니다.
- VSCode 재로드 후 새 등록을 사용합니다. 재로드/종료 이전의 알림은 새 터미널에 재연결하지 않습니다.
- “완료”는 응답 종료 신호입니다. 작업 성공이나 테스트 통과를 의미하지 않습니다. Claude `Stop` 훅은 다른 `Stop` 훅이 계속 작업하도록 차단하기 전에도 실행될 수 있습니다. 그런 검증 훅이 있다면 기본 Stop 알림을 제거하고, 해당 검증 훅의 최종 완료 분기에 `send claude completed`를 통합하세요.
- Claude 사용자 Ctrl+C는 `Stop`을 발생시키지 않으므로 자동 중단 알림을 보장하지 않습니다. Codex는 `Interrupt`를 사용합니다. 임의 훅 차단은 위의 명시적 연결이 필요합니다.
- 확장은 토큰을 가진 로컬 named-pipe 요청만 받고, 클릭 데이터는 터미널 선택만 허용합니다. 임의 셸 명령 실행 API는 없습니다. 로컬 등록 파일은 현재 사용자 디렉터리에 저장되며, 프로세스 충돌로 남은 등록은 실제 연결 실패 시 건너뜁니다.

## 제거 / 원본 복구

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Windows\scripts\uninstall.ps1
```

이 도구가 추가한 훅·TOML 줄·protocol·VSCode 확장만 제거합니다. 그 후 VSCode 창과 에이전트를 재시작하세요. 백업/WAV/설치 파일은 복구를 위해 남깁니다. 기존 사용자 설정을 통째로 덮어쓰지 않으므로 설치 이후 변경도 유지합니다. 전체 원본이 필요하면 `backups/<timestamp>/manifest.json`의 `file`↔`backup` 대응에 따라 복원하세요.

## GitHub 업로드

루트 저장소는 `git init -b main`으로 생성했습니다. `.gitignore`는 빌드 산출물·의존성·로그를 제외합니다. 소스와 npm/NuGet lockfile을 업로드하세요.

```powershell
git remote add origin https://github.com/<account>/agent-terminal-notifier.git
git push -u origin main
```

CI에서도 Windows runner에 Node 22, .NET SDK 8 이상을 준비하고 `Windows/scripts/pipeline.ps1`을 호출하면 됩니다. 이 저장소는 OS별 소스를 나누기 위해 **Windows 디렉터리만** 제공합니다.

## 참고

- [VSCode Terminal / window API](https://code.visualstudio.com/api/references/vscode-api)
- [Codex notify](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications), [Codex lifecycle hooks](https://learn.chatgpt.com/docs/hooks)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Windows notification activation](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/app-notifications-quickstart)
- [Microsoft notifications toolkit](https://www.nuget.org/packages/Microsoft.Toolkit.Uwp.Notifications/7.1.3)
