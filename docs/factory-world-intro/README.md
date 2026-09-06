# Factory World 소개 페이지 (Claude Design 캔버스) 작업 파일

게시된 캔버스: https://claude.ai/code/artifact/8df02560-2e60-41da-827a-ce3c9b0232e9

| 파일 | 역할 |
|---|---|
| `build.mjs` | 아트보드 9장의 HTML과 `canvas.json`을 생성하는 스크립트. 내용 수정은 여기서 |
| `*.dc.html` | 아트보드 9장 (Main 표지, Problem, Scenario, Principles, Process, Stack, Floorplan, Impact, Status) |
| `canvas.json` | 아트보드 배치와 캔버스 시작 옵션 |
| `factory-world-intro.html` | 캔버스 편집기가 포함된 게시용 단일 HTML (design 스킬이 생성) |

## 다시 만들기

이 폴더에서 실행하면 같은 이름의 아트보드와 `canvas.json`이 덮어써진다.

```bash
node build.mjs
```

이후 `design` 스킬로 게시용 HTML을 다시 만들어 위 URL로 재게시한다. 내용의 원천은 `../design-brief.md`.

## 캔버스에서 직접 편집한 뒤 되가져오기 (동기화)

사용자가 게시된 캔버스에서 저장하면 새 버전이 생기고, 이 폴더의 파일은 뒤처진다.
재게시하기 전에 반드시 저장본을 먼저 되가져온다.

1. Artifact 도구 `read`(위 URL)로 현재 게시 버전을 읽는다. 결과가 전체 HTML 파일 경로를 알려준다.
2. `design` 스킬의 `seed-canvas.mjs --extract <그 파일> --to <빈 폴더>` 로 아트보드와 `canvas.json`을 풀어낸다.
3. 풀어낸 파일과 이 폴더를 비교하고, 바뀐 내용을 `build.mjs`에 반영한 뒤 `node build.mjs`로 재생성해 일치하는지 확인한다.
4. 게시본 HTML은 1의 파일을 `factory-world-intro.html`로 그대로 복사한다.

`build.mjs`에 담을 수 없는 편집(요소 자유 배치, 편집기에서 새로 만든 요소 등)이 생기면 이 절에 적고, 해당 `*.dc.html`을 원본으로 유지한다.

### 동기화 이력

- 버전 `1788695958-294a` (2026-09-06): 사용자가 캔버스에서 `02 대표 시나리오` 아트보드를 오른쪽으로 9px 옮김. `build.mjs`의 `xOffsets`에 반영. 편집기는 기본값인 `print: "fixed"`를 저장 시 생략하므로 `build.mjs`도 생략하도록 맞춤. 아트보드 내용(`*.dc.html`) 변경은 없음.
- 버전 `1788698263-fd17` (2026-09-06): 요청에 따라 `02 대표 시나리오`의 9px 오프셋을 되돌려 모든 아트보드를 x=0에 정렬. `build.mjs`의 `xOffsets`를 비움. 재게시 전 읽은 게시본은 `1788695958-294a` 그대로였고(사용자 추가 편집 없음), 아트보드 내용 변경은 없음.
