# Project Decision Hub

프로젝트 폴더를 읽고, Codex 역할과 Claude 역할이 토론한 뒤 Judge가 결론을 정리해주는 로컬 웹 도구입니다.

마크다운 파일을 직접 읽는 방식이 아니라 브라우저 카드형 UI로 토론을 보여줍니다. 내부 기록은 `sessions/`에 JSON으로 저장됩니다.

## 빠른 시작

1. 이 폴더를 프로젝트 루트에 둡니다.
2. 서버를 실행합니다. 아래 두 방법 중 하나를 쓰면 됩니다.

**방법 1 — 콘솔 창이 보이는 실행 (`run-hub.bat`)**

`run-hub.bat`을 더블클릭합니다.

- 서버가 **별도 콘솔 창**(`Decision Hub Server`)에서 뜨고, 로그가 그 창에 **실시간으로** 표시됩니다.
- 이미 서버가 떠 있으면 새로 띄우지 않고 브라우저만 엽니다.
- 약 2초 뒤 브라우저가 자동으로 열립니다.
- 로그를 바로 확인하거나 문제를 디버깅할 때 적합합니다. **그 창을 닫으면 서버가 종료됩니다.**

**방법 2 — 콘솔 창 없이 실행 (`start-hidden.vbs`)**

`start-hidden.vbs`를 더블클릭합니다.

- **콘솔 창 없이** 백그라운드에서 서버가 뜨고, 약 2.5초 뒤 브라우저가 자동으로 열립니다.
- 로그는 화면 대신 **`logs/server.log`** 파일에 누적됩니다 (실행할 때마다 타임스탬프 구분선과 함께 기록).
- 멈추려면 **브라우저 탭을 닫으면** 됩니다 — 유휴 상태가 되면 서버가 자동 종료됩니다.
- 평소 사용에는 이 방법을 권장합니다.

> 터미널에서 직접 띄우려면 이 폴더에서 `node server.js` 를 실행해도 됩니다.

3. 브라우저에서 엽니다.

```text
http://localhost:8787
```

기본값은 로컬에 로그인된 `Codex CLI`와 `Claude CLI`를 사용합니다. 별도 API 키는 필요하지 않습니다.

설정을 바꾸고 싶으면 `.env.example`을 `.env`로 복사한 뒤 수정합니다.

```ini
CODEX_PROVIDER=cli
CLAUDE_PROVIDER=cli
CODEX_MODEL=gpt-5.4
CLAUDE_MODEL=
```

## 다른 프로젝트에서 쓰기

`project-decision-hub` 폴더를 다른 프로젝트 루트에 복사한 뒤 같은 방식으로 실행하면 됩니다.

기본값은 도구 폴더의 부모 디렉터리를 프로젝트 루트로 봅니다. 다른 폴더를 대상으로 삼고 싶으면:

```powershell
node server.js --project D:\Project\OtherGame
```

또는 `.env`에 지정합니다.

```ini
PROJECT_ROOT=D:\Project\OtherGame
```

## 작동 방식

1. 질문을 받습니다.
2. `rg --files`로 프로젝트 파일을 훑습니다.
3. 질문 키워드와 주제 힌트로 관련 파일을 고릅니다.
4. 동일한 repo context를 Codex 역할과 Claude 역할에 전달합니다.
5. 지정한 라운드 수만큼 번갈아 토론합니다.
6. Judge가 합의점, 쟁점, 추천 액션을 정리합니다.

## 화면 옵션

- `Analyze root`: 토론할 프로젝트 루트입니다. 직접 입력하거나 `Browse` 버튼으로 Windows 폴더 선택 창에서 고를 수 있습니다.
- `Rounds`: Codex/Claude 토론 왕복 횟수입니다. 기본 2.
- `Context files`: 모델에게 전달할 관련 파일 수입니다. 기본 10.
- `Tone`: 토론 톤입니다.
  - `Balanced`: 읽기 좋은 기본 토론
  - `Sharp`: 더 비판적이고 짧은 판단
  - `Exploratory`: 대안과 불확실성을 더 많이 탐색
- `OpenAI model`: Codex CLI(`codex exec -m`)에 넘길 모델입니다. `Default`(= `.env`의 `CODEX_MODEL`), `GPT-5.5`, `GPT-5.4`, `o3` 또는 `Custom OpenAI model`에 전체 모델명을 직접 입력할 수 있습니다. Codex 토론 턴과 Judge 양쪽에 적용됩니다.
- `Claude model`: Claude CLI(`--model`)에 넘길 모델입니다. `Default`, `Sonnet`, `Opus` 또는 `Custom Claude model`에 전체 모델명을 사용할 수 있습니다.
- `Claude effort`: Claude CLI(`--effort`)에 넘길 추론 강도입니다. `Default`, `Low`, `Medium`, `High`, `xHigh`, `Max`. `ultracode`는 대화형 세션 전용 설정이라 headless `claude -p` 호출에는 넘길 수 없으며, 추론 강도 기준 가장 가까운 값은 `xHigh`입니다.
- `Optional files`: 꼭 포함할 파일을 쉼표로 직접 지정합니다.
- `Start Debate` / `Stop Debate`: 토론을 시작합니다. 실행 중에는 버튼이 빨간 `Stop Debate`로 바뀌고, 누르면 진행 중인 codex/claude 호출을 즉시 중단합니다(중간 결과는 저장하지 않음).

> 모델/effort 선택기는 Project 패널에 모여 있습니다. 기존의 OpenAI/Claude provider 상태줄(`cli · 모델명`)은 선택기와 중복이라 제거했습니다. CLI 미설치·API 키 누락은 토론 시작 시 에러로 표시됩니다.

## 환경 변수

```ini
CODEX_PROVIDER=cli
CLAUDE_PROVIDER=cli
CODEX_MODEL=gpt-5.4
CLAUDE_MODEL=
PORT=8787
PROJECT_ROOT=..
MAX_CONTEXT_FILES=10
MAX_CONTEXT_CHARS=55000
MAX_OUTPUT_TOKENS=2200
CLI_TIMEOUT_MS=600000
AUTO_SHUTDOWN_ON_IDLE=true
AUTO_SHUTDOWN_GRACE_MS=5000
CLIENT_HEARTBEAT_TTL_MS=15000
```

API 방식으로 쓰고 싶을 때만 provider를 `api`로 바꾸고 키를 넣습니다.

```ini
CODEX_PROVIDER=api
CLAUDE_PROVIDER=api
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
OPENAI_MODEL=gpt-5.5
ANTHROPIC_MODEL=claude-opus-4-7
```

## 주의점

- 기본 CLI 모드는 현재 로컬에 로그인된 Codex CLI와 Claude CLI를 호출합니다.
- 서버는 시작할 때 설치된 Codex CLI 중 **가장 최신 버전**을 자동으로 찾아 사용합니다(구버전은 백엔드에서 최신 모델이 거부될 수 있음 — 예: `gpt-5.5`). 특정 binary로 고정하려면 `.env`의 `CODEX_CLI_PATH`를 지정하세요.
- API 모드로 바꾼 경우에만 OpenAI API와 Anthropic API 비용이 발생합니다.
- `sessions/`와 `.env`는 `.gitignore`에 들어가 있습니다.
- 모델명이 계정에서 지원되지 않으면 `.env`의 `OPENAI_MODEL`, `ANTHROPIC_MODEL`을 바꾸면 됩니다.
